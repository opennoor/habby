import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, access, rm } from 'node:fs/promises';
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
