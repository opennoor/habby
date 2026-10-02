import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, access, rm, readdir, chmod, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { installHub, uninstallHub, defaultPluginDir, renderSupervisor, doctor } from '../packages/hub/src/install.js';
import { PRIVATE_STATE_FILES, privateDirectory } from '../packages/hub/src/state.js';

test('all supervisor definitions quote paths and enforce restart/session limits', () => {
  const linux = renderSupervisor('linux', '/node space', '/entry%file.js', '/state"dir');
  assert.match(linux, /Restart=on-failure/); assert.match(linux, /entry%%file/); assert.match(linux, /UMask=0077/);
  const mac = renderSupervisor('darwin', '/node', '/A&B/cli.js', '/state');
  assert.match(mac, /KeepAlive/); assert.match(mac, /A&amp;B/);
  const windows = renderSupervisor('win32', 'C:\\Program Files\\node.exe', 'C:\\app\\cli.js', 'C:\\state');
  assert.match(windows, /<ExecutionTimeLimit>PT0S/); assert.match(windows, /<StopIfGoingOnBatteries>false/); assert.match(windows, /InteractiveToken/);
  assert.match(windows, /RestartOnFailure/); assert.throws(() => renderSupervisor('linux', '/bad\nnode', '/entry', '/state'));
  assert.equal(defaultPluginDir('linux', '/home/user', { XDG_CONFIG_HOME: '/custom' }), path.join('/custom', 'tabby', 'plugins'));
  assert.equal(defaultPluginDir('darwin', '/home/user', {}), path.join('/home/user', 'Library', 'Application Support', 'tabby', 'plugins'));
  assert.equal(defaultPluginDir('win32', '/home/user', { APPDATA: '/roaming' }), path.join('/roaming', 'tabby', 'plugins'));
});

test('installation, upgrade and uninstall preserve other plugins and private state', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'tabby-install-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, 'source'), stateDir = path.join(tmp, 'state'), pluginDir = path.join(tmp, 'plugins');
  await mkdir(path.join(source, 'dist'), { recursive: true }); await mkdir(stateDir);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'tabby-hub-satellite', main: 'dist/index.js' }));
  await writeFile(path.join(source, 'dist', 'index.js'), 'version1');
  await writeFile(path.join(stateDir, 'satellite.json'), '{}', { mode: 0o600 });
  await mkdir(path.join(pluginDir, 'node_modules', 'unrelated'), { recursive: true });
  await writeFile(path.join(pluginDir, 'node_modules', 'unrelated', 'keep'), 'keep');
  const calls: Array<[string, string[]]> = [];
  const options = { config: { stateDir, trustedPort: 3001, satellitePort: 3002, publicPort: 3003 }, platform: 'linux' as const, home: tmp, env: {}, pluginDir, pluginSource: source, executable: '/bundle/node', entrypoint: '/bundle/cli.js', exec: async (file: string, args: string[]) => { calls.push([file, args]); } };
  const installed = await installHub(options);
  assert.equal(installed.started, true);
  assert.equal(await readFile(path.join(pluginDir, 'node_modules', 'tabby-hub-satellite', 'dist', 'index.js'), 'utf8'), 'version1');
  assert.deepEqual(JSON.parse(await readFile(path.join(pluginDir, 'node_modules', 'tabby-hub-satellite', 'hub-state.json'), 'utf8')), { stateDir });
  if (process.platform !== 'win32') assert.equal((await stat(installed.servicePath)).mode & 0o077, 0);
  assert.deepEqual(calls[2], ['systemctl', ['--user', 'restart', 'tabby-hub.service']]);
  await writeFile(path.join(source, 'dist', 'index.js'), 'version2');
  await installHub({ ...options, start: false });
  assert.equal(await readFile(path.join(pluginDir, 'node_modules', 'tabby-hub-satellite', 'dist', 'index.js'), 'utf8'), 'version2');
  const { pluginDir: _customDir, ...uninstallOptions } = options;
  await uninstallHub(options.config, uninstallOptions);
  await access(path.join(stateDir, 'satellite.json')); await access(path.join(pluginDir, 'node_modules', 'unrelated', 'keep'));
  await assert.rejects(access(installed.servicePath));
  await assert.rejects(access(path.join(pluginDir, 'node_modules', 'tabby-hub-satellite')));
  await uninstallHub(options.config, options);
});

test('a supervisor failure is surfaced and does not claim a successful installation', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'tabby-install-failure-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, 'source'); await mkdir(path.join(source, 'dist'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'tabby-hub-satellite' }));
  await writeFile(path.join(source, 'dist', 'index.js'), 'plugin'); await writeFile(path.join(tmp, 'satellite.json'), '{}');
  await assert.rejects(installHub({ config: { stateDir: tmp, trustedPort: 3001, satellitePort: 3002, publicPort: 3003 }, pluginSource: source, home: tmp, env: {}, platform: 'linux', exec: async () => { throw new Error('user systemd unavailable'); } }), /user systemd unavailable/);
});

test('doctor rejects an unrelated HTTP200 process occupying the configured port', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'tabby-doctor-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  for (const name of ['config.json', 'satellite.json']) await writeFile(path.join(tmp, name), '{}', { mode: 0o600 });
  let correct = false;
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(correct ? { name: 'Tabby Hub', alive: true } : { alive: true, name: 'different daemon' })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = { stateDir: tmp, trustedPort: address.port, satellitePort: 3002, publicPort: 3003 };
  assert.equal((await doctor(config)).find(check => check.name === 'hub')!.ok, false);
  correct = true;
  assert.equal((await doctor(config)).find(check => check.name === 'hub')!.ok, true);
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
  try {
    for (const [version, supported] of [['23.99.99', false], ['24.0.0', false], ['24.20.9', false], ['24.21.0', true], ['24.21.1', true], ['24.22.0', true], ['25.0.0', true]] as const) {
      Object.defineProperty(process.versions, 'node', { ...descriptor, value: version });
      assert.equal((await doctor(config)).find(check => check.name === 'runtime')!.ok, supported, version);
    }
  } finally { Object.defineProperty(process.versions, 'node', descriptor); }
});

test('CLI doctor reports missing, malformed and unsafe state without initializing or repairing files', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'tabby-doctor-readonly-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const stateDir = path.join(tmp, 'state');
  const run = async () => {
    try {
      await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../packages/hub/src/cli.ts', import.meta.url)), 'doctor', '--state-dir', stateDir]);
      assert.fail('Unhealthy state must fail diagnosis.');
    } catch (error) {
      const result = error as any; assert.equal(result.code, 1); return JSON.parse(result.stdout);
    }
  };
  assert.equal((await run())[0].ok, false);
  await assert.rejects(access(stateDir));
  await mkdir(stateDir);
  await writeFile(path.join(stateDir, 'config.json'), 'malformed');
  assert.equal((await run())[0].ok, false);
  assert.equal(await readFile(path.join(stateDir, 'config.json'), 'utf8'), 'malformed');
  const original = JSON.stringify({ stateDir, trustedPort: 65535, satellitePort: 65534, publicPort: 65533 });
  await writeFile(path.join(stateDir, 'config.json'), original);
  if (process.platform !== 'win32') await chmod(path.join(stateDir, 'config.json'), 0o644);
  const checks = await run();
  assert.equal(checks.find((check: any) => check.name === 'satellite.json').ok, false);
  if (process.platform !== 'win32') {
    assert.equal(checks.find((check: any) => check.name === 'config.json').ok, false);
    assert.equal((await stat(path.join(stateDir, 'config.json'))).mode & 0o777, 0o644);
  }
  assert.equal(await readFile(path.join(stateDir, 'config.json'), 'utf8'), original);
  assert.deepEqual(await readdir(stateDir), ['config.json']);
  if (process.platform !== 'win32') {
    const outside = path.join(tmp, 'outside-config.json'); await writeFile(outside, original, { mode: 0o600 });
    await rm(path.join(stateDir, 'config.json')); await symlink(outside, path.join(stateDir, 'config.json'));
    assert.match((await run())[0].detail, /regular file, not a link/);
    assert.equal(await readFile(outside, 'utf8'), original);
    await rm(stateDir, { recursive: true });
    const outsideDirectory = path.join(tmp, 'outside-state'); await mkdir(outsideDirectory);
    await writeFile(path.join(outsideDirectory, 'config.json'), original);
    await symlink(outsideDirectory, stateDir);
    assert.match((await run())[0].detail, /real directory/);
    assert.deepEqual(await readdir(outsideDirectory), ['config.json']);
  }
});

test('Windows installer selects supported architectures and rejects unsupported ones before installation', async t => {
  const execute = promisify(execFile);
  try { await execute('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']); }
  catch { t.skip('PowerShell runtime unavailable on this host'); return; }
  const source = await readFile(new URL('../scripts/install.ps1', import.meta.url), 'utf8');
  const command = `
    $ErrorActionPreference = 'Stop'
    $source = [Console]::In.ReadToEnd()
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$null)
    $selection = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.SwitchStatementAst] }, $true)
    $select = [scriptblock]::Create($selection.Extent.Text)
    foreach ($architecture in @('X64', 'Arm64')) {
      if ((& $select) -cne $architecture.ToLowerInvariant()) { throw "Wrong bundle for $architecture" }
    }
    foreach ($architecture in @('X86', 'Arm', 'Wasm', 'S390x')) {
      try { & $select; throw 'Unsupported architecture was accepted.' }
      catch { if ($_.Exception.Message -ne "Unsupported Windows architecture: $architecture") { throw } }
    }
    exit 0
  `;
  await new Promise<void>((resolve, reject) => {
    const child = execFile('pwsh', ['-NoLogo', '-NoProfile', '-Command', command], error => error ? reject(error) : resolve());
    child.stdin!.end(source);
  });
});


test('Unix supervisor upgrades repair existing writable units and plists', { skip: process.platform === 'win32' }, async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'tabby-supervisor-upgrade-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, 'source'); await mkdir(path.join(source, 'dist'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'tabby-hub-satellite' }));
  await writeFile(path.join(source, 'dist', 'index.js'), 'plugin');
  const stateDir = path.join(tmp, 'state'); await mkdir(stateDir);
  await writeFile(path.join(stateDir, 'satellite.json'), '{}', { mode: 0o600 });
  for (const platform of ['linux', 'darwin'] as const) {
    const options = { config: { stateDir, trustedPort: 3001, satellitePort: 3002, publicPort: 3003 }, platform,
      home: tmp, env: {}, pluginSource: source, pluginDir: path.join(tmp, platform, 'plugins'), start: false, exec: async () => {} };
    const installed = await installHub(options);
    await chmod(installed.servicePath, 0o666);
    await installHub({ ...options, start: true, exec: async () => {
      assert.equal((await stat(installed.servicePath)).mode & 0o777, 0o600, platform);
    } });
    assert.equal((await stat(installed.servicePath)).mode & 0o777, 0o600, platform);
  }
});

test('Unix doctor diagnoses the entire state inventory without repairing mode, ownership or links', { skip: process.platform === 'win32' }, async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'tabby-doctor-inventory-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const names = PRIVATE_STATE_FILES.map(file => file.name);
  for (const name of names) await writeFile(path.join(tmp, name), '{}', { mode: 0o600 });
  const config = { stateDir: tmp, trustedPort: 1, satellitePort: 3002, publicPort: 3003 };
  assert.ok((await doctor(config)).filter(check => check.name !== 'runtime' && check.name !== 'hub').every(check => check.ok));
  for (const name of ['state-directory', ...names]) {
    const file = name === 'state-directory' ? tmp : path.join(tmp, name);
    const mode = name === 'state-directory' ? 0o755 : 0o644;
    await chmod(file, mode);
    assert.equal((await doctor(config)).find(check => check.name === name)?.ok, false, name);
    assert.equal((await stat(file)).mode & 0o777, mode, 'Diagnosis must not repair permissions.');
    await chmod(file, name === 'state-directory' ? 0o700 : 0o600);
  }
  // Changing the observed UID exercises actual ownership comparison without requiring root.
  const getuid = process.getuid!;
  try {
    process.getuid = () => getuid() + 1;
    for (const check of (await doctor(config)).filter(check => check.name !== 'runtime' && check.name !== 'hub')) assert.equal(check.ok, false, check.name);
  } finally { process.getuid = getuid; }
  const outside = path.join(tmp, 'outside'); await writeFile(outside, 'unchanged', { mode: 0o600 });
  await rm(path.join(tmp, 'task.xml')); await symlink(outside, path.join(tmp, 'task.xml'));
  assert.equal((await doctor(config)).find(check => check.name === 'task.xml')?.ok, false);
  await assert.rejects(privateDirectory(tmp), /regular files, not links/);
  assert.equal(await readFile(outside, 'utf8'), 'unchanged');
  await rm(path.join(tmp, 'task.xml'));
  const optionalAbsent = await doctor(config);
  assert.equal(optionalAbsent.some(check => check.name === 'task.xml'), false);
  await rm(path.join(tmp, 'secrets.json'));
  assert.equal((await doctor(config)).find(check => check.name === 'secrets.json')?.ok, false);
});

test('Unix installer replaces private control records and supervisor links without touching their target', { skip: process.platform === 'win32' }, async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'tabby-control-upgrade-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, 'source'); await mkdir(path.join(source, 'dist'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'tabby-hub-satellite' }));
  await writeFile(path.join(source, 'dist', 'index.js'), 'plugin');
  const stateDir = path.join(tmp, 'state'); await mkdir(stateDir); await writeFile(path.join(stateDir, 'satellite.json'), '{}');
  const options = { config: { stateDir, trustedPort: 3001, satellitePort: 3002, publicPort: 3003 }, platform: 'linux' as const,
    home: tmp, env: {}, pluginSource: source, start: false, exec: async () => {} };
  const installed = await installHub(options);
  await chmod(path.join(stateDir, 'installation.json'), 0o666);
  const outside = path.join(tmp, 'outside'); await writeFile(outside, 'unchanged');
  await rm(installed.servicePath); await symlink(outside, installed.servicePath);
  await installHub(options);
  assert.equal(await readFile(outside, 'utf8'), 'unchanged');
  assert.equal((await stat(installed.servicePath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(stateDir, 'installation.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
});

test('uninstall stops and deregisters missing definitions before removing plugin or state', async t => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    if (platform === 'darwin' && !process.getuid) continue; // macOS/Linux CI cover the native UID domain.
    for (const scenario of ['registered', 'absent', 'failure'] as const) {
      const home = await mkdtemp(path.join(os.tmpdir(), 'tabby-uninstall-'));
      t.after(() => rm(home, { recursive: true, force: true }));
      const stateDir = path.join(home, 'state'), pluginDir = path.join(home, 'plugins');
      const destination = path.join(pluginDir, 'node_modules', 'tabby-hub-satellite');
      await mkdir(destination, { recursive: true }); await mkdir(stateDir);
      await writeFile(path.join(destination, 'package.json'), JSON.stringify({ name: 'tabby-hub-satellite' }));
      await writeFile(path.join(stateDir, 'secrets.json'), 'retain on failure');
      const calls: Array<[string, string[]]> = [];
      const options = { platform, home, pluginDir, env: { USERNAME: 'fixture' }, purge: true,
        exec: async (file: string, args: string[]) => {
          await access(destination); await access(stateDir); // Deregistration must precede destructive cleanup.
          calls.push([file, args]);
          if (scenario === 'failure') throw Object.assign(new Error('supervisor access denied'), { code: 1, stderr: 'Permission denied' });
          if (scenario === 'absent' && platform !== 'win32') {
            if (args.includes('stop')) throw Object.assign(new Error('not installed'), { code: 5 });
            if (args.includes('disable')) throw Object.assign(new Error('not installed'), { code: 1, stderr: "Failed to disable unit: Unit tabby-hub.service does not exist\nRemoved '/fixture/default.target.wants/tabby-hub.service'.\n" });
            if (file === 'launchctl') throw Object.assign(new Error('no such service'), { code: 3 });
          }
        } };
      const config = { stateDir, trustedPort: 3001, satellitePort: 3002, publicPort: 3003 };
      if (scenario === 'failure') {
        await assert.rejects(uninstallHub(config, options), /supervisor access denied/);
        await access(destination); assert.equal(await readFile(path.join(stateDir, 'secrets.json'), 'utf8'), 'retain on failure');
      } else {
        assert.equal((await uninstallHub(config, options)).statePurged, true);
        await assert.rejects(access(destination)); await assert.rejects(access(stateDir));
        if (platform === 'linux') assert.deepEqual(calls.map(([, args]) => args[1]), ['stop', 'disable', 'daemon-reload']);
        if (platform === 'darwin') assert.equal(calls[0][1][0], 'bootout');
        if (platform === 'win32') {
          const command = calls[0][1].at(-1)!;
          assert.match(command, /GetTask\('TabbyHubMCP-fixture'\)/);
          assert.match(command, /HResult -ne -2147024894/);
          assert.match(command, /\$task.Stop\(0\)/);
          assert.match(command, /GetInstances\(0\).Count -gt 0/);
          assert.match(command, /\$folder.DeleteTask/);
          assert.doesNotMatch(command, /SilentlyContinue/);
        }
      }
    }
  }
});

test('missing Linux unit diagnostics do not hide disable permission or connectivity failures', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tabby-uninstall-error-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateDir = path.join(home, 'state'); await mkdir(stateDir); await writeFile(path.join(stateDir, 'keep'), 'keep');
  const config = { stateDir, trustedPort: 3001, satellitePort: 3002, publicPort: 3003 };
  for (const stderr of ['Permission denied', 'Failed to connect to bus', 'Failed to disable unit: Unit tabby-hub.service does not exist\nPermission denied']) {
    await assert.rejects(uninstallHub(config, { platform: 'linux', home, env: {}, purge: true, exec: async (_file, args) => {
      if (args.includes('disable')) throw Object.assign(new Error('disable failed'), { code: 1, stderr });
    } }), /disable failed/);
    assert.equal(await readFile(path.join(stateDir, 'keep'), 'utf8'), 'keep');
  }
});

test('native Windows uninstall recognizes a genuinely unregistered task', { skip: process.platform !== 'win32' }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tabby-uninstall-native-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateDir = path.join(home, 'state'); await mkdir(stateDir);
  await uninstallHub({ stateDir, trustedPort: 3001, satellitePort: 3002, publicPort: 3003 }, {
    platform: 'win32', home, env: { APPDATA: home, USERNAME: `absent-${Date.now()}-${process.pid}` }, purge: true,
  });
  await assert.rejects(access(stateDir));
});


test('Windows deregistration script distinguishes missing, denied and still-running tasks', async t => {
  const execute = promisify(execFile);
  try { await execute('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']); }
  catch { t.skip('PowerShell runtime unavailable on this host'); return; }
  const home = await mkdtemp(path.join(os.tmpdir(), 'tabby-task-script-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateDir = path.join(home, 'state'); await mkdir(stateDir);
  let command = '';
  await uninstallHub({ stateDir, trustedPort: 3001, satellitePort: 3002, publicPort: 3003 }, {
    platform: 'win32', home, env: {}, exec: async (_file, args) => { command = args.at(-1)!; },
  });
  for (const scenario of ['absent', 'denied', 'running', 'stopped']) {
    const fixture = `
      $scenario='${scenario}'; $events=[Collections.Generic.List[string]]::new()
      $fixtureTask=[pscustomobject]@{}
      $fixtureTask | Add-Member ScriptMethod Stop { param($flags) $events.Add('stop') }
      $fixtureTask | Add-Member ScriptMethod GetInstances { param($flags) @{Count=[int]($scenario -eq 'running')} }
      $folder=[pscustomobject]@{}
      $folder | Add-Member ScriptMethod GetTask { param($name)
        if($scenario -eq 'absent') { throw [Runtime.InteropServices.COMException]::new('missing',-2147024894) }
        if($scenario -eq 'denied') { throw [Runtime.InteropServices.COMException]::new('denied',-2147024891) }
        return $fixtureTask
      }
      $folder | Add-Member ScriptMethod DeleteTask { param($name,$flags) $events.Add('delete') }
      $schedulerFixture=[pscustomobject]@{}
      $schedulerFixture | Add-Member ScriptMethod Connect {}
      $schedulerFixture | Add-Member ScriptMethod GetFolder { param($path) return $folder }
      function New-Object { param($ComObject) return $schedulerFixture }
      try {
        ${command.replace('AddSeconds(10)', 'AddSeconds(0)')}
        ConvertTo-Json -Compress -InputObject @{events=@($events); error=$null}
      } catch { ConvertTo-Json -Compress -InputObject @{events=@($events); error=$_.Exception.Message} }
    `;
    const { stdout } = await execute('pwsh', ['-NoProfile', '-NonInteractive', '-Command', fixture]);
    const result = JSON.parse(stdout);
    if (scenario === 'stopped') { assert.deepEqual(result.events, ['stop', 'delete']); assert.equal(result.error, null); }
    if (scenario === 'absent') { assert.deepEqual(result.events, []); assert.equal(result.error, null); }
    if (scenario === 'denied') { assert.deepEqual(result.events, []); assert.match(result.error, /denied/); }
    if (scenario === 'running') { assert.deepEqual(result.events, ['stop']); assert.match(result.error, /instances did not stop/); }
  }
});
