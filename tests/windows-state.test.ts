import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeState } from '../packages/hub/src/state.js';
import { openStore } from '../packages/hub/src/auth/store.js';
import { doctor, installHub } from '../packages/hub/src/install.js';

test('native Windows state replaces unsafe explicit ACLs before writing secrets', { skip: process.platform !== 'win32' }, async t => {
  const stateDir = await mkdtemp(join(process.env.TABBY_HUB_NATIVE_TEST_ROOT ?? tmpdir(), 'tabby-state-acl-'));
  let preserveForProbe = false;
  t.after(() => preserveForProbe ? undefined : rm(stateDir, { recursive: true, force: true }));
  const execute = promisify(execFile);
  const powershell = async (script: string) => JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules'); " + script, 'utf16le').toString('base64')],
    { env: { ...process.env, TABBY_HUB_PRIVATE_STATE_DIR: stateDir } })).stdout);
  const identity = await powershell(`$id=[System.Security.Principal.WindowsIdentity]::GetCurrent(); $principal=New-Object System.Security.Principal.WindowsPrincipal($id);
    @{sid=$id.User.Value; admin=$principal.IsInRole([System.Security.Principal.WindowsBuiltinRole]::Administrator)} | ConvertTo-Json -Compress`);
  if (process.env.TABBY_HUB_REQUIRE_STANDARD_USER === '1') assert.equal(identity.admin, false, 'Native acceptance must run with a standard user token.');
  const state = await initializeState(stateDir);
  const freshChecks = await doctor({ ...state.config, trustedPort: 1 });
  for (const name of ['state-directory', 'config.json', 'satellite.json', 'secrets.json'])
    assert.equal(freshChecks.find(check => check.name === name)?.ok, true, `${name}: fresh state must already be private before opening storage`);
  const freshStore = await openStore(stateDir);
  try {
    const storageChecks = await doctor({ ...state.config, trustedPort: 1 });
    for (const name of ['auth.sqlite', 'auth.sqlite-wal', 'auth.sqlite-shm'])
      assert.equal(storageChecks.find(check => check.name === name)?.ok, true, `${name}: fresh live database files must be private`);
  } finally { freshStore.close(); }
  const original = await readFile(join(stateDir, 'secrets.json'), 'utf8');
  await execute('icacls.exe', [stateDir, '/grant', '*S-1-1-0:(OI)(CI)R']);
  const files = ['config.json', 'satellite.json', 'secrets.json', 'auth.sqlite', 'installation.json', 'task.xml', 'hub.stderr.log'];
  for (const file of files.slice(4)) await writeFile(join(stateDir, file), 'legacy');
  for (const file of files) await execute('icacls.exe', [join(stateDir, file), '/grant', '*S-1-1-0:M']);
  const descriptors = () => powershell(`ConvertTo-Json -Compress -InputObject @(@('','config.json','satellite.json','secrets.json','auth.sqlite','installation.json','task.xml','hub.stderr.log') | ForEach-Object {
    (Get-Acl -LiteralPath ([IO.Path]::Combine($env:TABBY_HUB_PRIVATE_STATE_DIR,$_))).Sddl})`);
  const unsafeDescriptors = await descriptors();
  const unsafeChecks = await doctor({ ...state.config, trustedPort: 1 });
  for (const name of ['state-directory', ...files]) assert.equal(unsafeChecks.find(check => check.name === name)?.ok, false, `${name}: doctor must detect unsafe ACLs`);
  assert.deepEqual(await descriptors(), unsafeDescriptors, 'Doctor must not repair directory or file ACLs.');
  const source = join(stateDir, 'fixture-source'); await mkdir(join(source, 'dist'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'tabby-hub-satellite' }));
  await writeFile(join(source, 'dist', 'index.js'), 'plugin');
  let registrationObserved = false;
  await installHub({ config: state.config, platform: 'win32', pluginSource: source, pluginDir: join(stateDir, 'plugins'), start: false,
    exec: async () => {
      registrationObserved = true;
      const controlChecks = await doctor({ ...state.config, trustedPort: 1 });
      for (const name of ['state-directory', ...files]) {
        const ok = controlChecks.find(check => check.name === name)?.ok;
        const descriptor = ok ? '' : await powershell(`$file=Join-Path $env:TABBY_HUB_PRIVATE_STATE_DIR '${name === 'state-directory' ? '' : name}';
          ConvertTo-Json -Compress -InputObject (Get-Acl -LiteralPath $file).Sddl`);
        assert.equal(ok, true, `${name}: private before task registration; ${descriptor}`);
      }
      assert.match(await readFile(join(stateDir, 'task.xml'), 'utf16le'), /<Task version=/);
      assert.ok(JSON.parse(await readFile(join(stateDir, 'installation.json'), 'utf8')).pluginDir);
    } });
  assert.equal(registrationObserved, true);
  await initializeState(stateDir);
  (await openStore(stateDir)).close();
  const acl = await powershell(`$acl=Get-Acl -LiteralPath $env:TABBY_HUB_PRIVATE_STATE_DIR;
    @{owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected=$acl.AreAccessRulesProtected;
      rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
        @{sid=$_.IdentityReference.Value; allow=$_.AccessControlType.ToString(); inherited=$_.IsInherited; rights=$_.FileSystemRights.ToString()}})} | ConvertTo-Json -Compress -Depth 4`);
  assert.equal(acl.owner, identity.sid); assert.equal(acl.protected, true);
  assert.equal(acl.rules.length, 1);
  assert.deepEqual(acl.rules[0], { sid: identity.sid, allow: 'Allow', inherited: false, rights: 'FullControl' });
  for (const file of files) {
    const fileAcl = await powershell(`$acl=Get-Acl -LiteralPath (Join-Path $env:TABBY_HUB_PRIVATE_STATE_DIR '${file}');
      ConvertTo-Json -Compress -InputObject @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value})`);
    assert.deepEqual(fileAcl, [identity.sid]);
  }
  assert.equal(await readFile(join(stateDir, 'secrets.json'), 'utf8'), original);
  const privateChecks = await doctor({ ...state.config, trustedPort: 1 });
  for (const name of ['state-directory', ...files]) assert.equal(privateChecks.find(check => check.name === name)?.ok, true, `${name}: doctor must recognize repaired private ACLs`);
  assert.ok(JSON.parse(await readFile(join(stateDir, 'secrets.json'), 'utf8')).credential);
  if (process.env.TABBY_HUB_ACL_PROBE_MANIFEST) {
    await writeFile(process.env.TABBY_HUB_ACL_PROBE_MANIFEST, JSON.stringify({ stateDir, file: join(stateDir, 'secrets.json'), database: join(stateDir, 'auth.sqlite'), files: files.map(file => join(stateDir, file)) }));
    preserveForProbe = true;
  }
});
