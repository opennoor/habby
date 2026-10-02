import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, access, rm, readdir, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { installHub, uninstallHub, defaultPluginDir, renderSupervisor, doctor } from '../packages/hub/src/install.js';

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
