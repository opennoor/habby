import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeState } from '../packages/hub/src/state.js';
import { openStore } from '../packages/hub/src/auth/store.js';

test('native Windows state replaces unsafe explicit ACLs before writing secrets', { skip: process.platform !== 'win32' }, async t => {
  const stateDir = await mkdtemp(join(process.env.TABBY_HUB_NATIVE_TEST_ROOT ?? tmpdir(), 'tabby-state-acl-'));
  let preserveForProbe = false;
  t.after(() => preserveForProbe ? undefined : rm(stateDir, { recursive: true, force: true }));
  const execute = promisify(execFile);
  const powershell = async (script: string) => JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, TABBY_HUB_PRIVATE_STATE_DIR: stateDir } })).stdout);
  const identity = await powershell(`$id=[System.Security.Principal.WindowsIdentity]::GetCurrent(); $principal=New-Object System.Security.Principal.WindowsPrincipal($id);
    @{sid=$id.User.Value; admin=$principal.IsInRole([System.Security.Principal.WindowsBuiltinRole]::Administrator)} | ConvertTo-Json -Compress`);
  if (process.env.TABBY_HUB_REQUIRE_STANDARD_USER === '1') assert.equal(identity.admin, false, 'Native acceptance must run with a standard user token.');
  await initializeState(stateDir);
  (await openStore(stateDir)).close();
  const original = await readFile(join(stateDir, 'secrets.json'), 'utf8');
  await execute('icacls.exe', [stateDir, '/grant', '*S-1-1-0:(OI)(CI)R']);
  for (const file of ['secrets.json', 'auth.sqlite']) await execute('icacls.exe', [join(stateDir, file), '/grant', '*S-1-1-0:R']);
  await initializeState(stateDir);
  (await openStore(stateDir)).close();
  const acl = await powershell(`$acl=Get-Acl -LiteralPath $env:TABBY_HUB_PRIVATE_STATE_DIR;
    @{owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected=$acl.AreAccessRulesProtected;
      rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
        @{sid=$_.IdentityReference.Value; allow=$_.AccessControlType.ToString(); inherited=$_.IsInherited; rights=$_.FileSystemRights.ToString()}})} | ConvertTo-Json -Compress -Depth 4`);
  assert.equal(acl.owner, identity.sid); assert.equal(acl.protected, true);
  assert.equal(acl.rules.length, 1);
  assert.deepEqual(acl.rules[0], { sid: identity.sid, allow: 'Allow', inherited: false, rights: 'FullControl' });
  for (const file of ['secrets.json', 'auth.sqlite']) {
    const fileAcl = await powershell(`$acl=Get-Acl -LiteralPath (Join-Path $env:TABBY_HUB_PRIVATE_STATE_DIR '${file}');
      ConvertTo-Json -Compress -InputObject @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value})`);
    assert.deepEqual(fileAcl, [identity.sid]);
  }
  assert.equal(await readFile(join(stateDir, 'secrets.json'), 'utf8'), original);
  assert.ok(JSON.parse(await readFile(join(stateDir, 'secrets.json'), 'utf8')).credential);
  if (process.env.TABBY_HUB_ACL_PROBE_MANIFEST) {
    await writeFile(process.env.TABBY_HUB_ACL_PROBE_MANIFEST, JSON.stringify({ stateDir, file: join(stateDir, 'secrets.json'), database: join(stateDir, 'auth.sqlite') }));
    preserveForProbe = true;
  }
});
