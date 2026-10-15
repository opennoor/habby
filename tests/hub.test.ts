import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { request as secureRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHub } from '../packages/hub/src/hub.js';
import { initializeState } from '../packages/hub/src/state.js';
import { openStore } from '../packages/hub/src/auth/store.js';
import { TOOLS } from '../shared/catalog.js';
import { globalId, LOCAL_PRINCIPAL, type HubConfig, type SatelliteTrust } from '../shared/protocol.js';
import { SatelliteClient } from '../packages/satellite/src/client.ts';
import { tailscaleIdentity } from '../packages/hub/src/exposure.js';

async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function temporaryConfig(): Promise<HubConfig> {
  return { stateDir: await mkdtemp(join(tmpdir(), 'habby-test-')), trustedPort: await freePort(),
    satellitePort: await freePort(), publicPort: await freePort() };
}
async function satellite(trust: SatelliteTrust, windowId: string) {
  const ws = new WebSocket(trust.url, { ca: trust.certificate, headers: { Authorization: `Bearer ${trust.credential}` } });
  await once(ws, 'open');
  const registered = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'register', protocol: 1, windowId, metadata: { title: 'identical' },
    capabilities: TOOLS.filter(tool => tool.name !== 'list_windows').map(tool => tool.name), snapshot: {
      tabs: [{ id: 'tab', title: 'identical' }], sessions: [{ id: 'pane', tabId: 'tab' }], profiles: [], transfers: [],
    } }));
  const binding = JSON.parse(String((await registered)[0]));
  ws.on('message', buffer => {
    const request = JSON.parse(String(buffer));
    if (request.type !== 'request') return;
    ws.send(JSON.stringify({ type: 'response', id: request.id, windowId, epoch: binding.epoch,
      result: { content: [{ type: 'text', text: JSON.stringify({ observedWindow: windowId,
        operation: request.operation, input: request.params, sessionId: 'pane' }) }] } }));
  });
  return ws;
}

test('real MCP over HTTP routes two authenticated WSS satellites independently', async t => {
  const config = await temporaryConfig();
  const hub = await startHub(config);
  t.after(async () => { await hub.close(); await rm(config.stateDir, { recursive: true, force: true }); });
  const trust: SatelliteTrust = JSON.parse(await readFile(join(config.stateDir, 'satellite.json'), 'utf8'));
  const windows = [randomUUID(), randomUUID()];
  const peers = await Promise.all(windows.map(id => satellite(trust, id)));
  const dispatched: unknown[] = [];
  peers[1].on('message', buffer => { const message = JSON.parse(String(buffer)); if (message.type === 'request') dispatched.push(message); });
  t.after(() => { for (const peer of peers) peer.terminate(); });
  const client = new Client({ name: 'Hub integration test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.trustedPort}/mcp`)));
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 38);
  const inventory = await client.callTool({ name: 'list_windows', arguments: {} });
  const inventoryText = JSON.stringify(inventory);
  for (const windowId of windows) assert.match(inventoryText, new RegExp(windowId));
  const ambiguous = await client.callTool({ name: 'exec_command', arguments: { command: 'whoami' } });
  assert.equal(ambiguous.isError, true); assert.match(JSON.stringify(ambiguous), /AMBIGUOUS_TARGET/);
  const result = await client.callTool({ name: 'exec_command', arguments: { command: 'whoami', sessionId: globalId(windows[1], 'pane') } });
  assert.notEqual(result.isError, true);
  assert.match(JSON.stringify(result), new RegExp(windows[1]));
  const beforeInvalid = dispatched.length;
  for (const timeout of [-1, 0, 0.5, 300001]) {
    const invalid = await client.callTool({ name: 'exec_command', arguments: { command: 'whoami', timeout, sessionId: globalId(windows[1], 'pane') } });
    assert.equal(invalid.isError, true);
  }
  assert.equal(dispatched.length, beforeInvalid);
  peers[0].close(); await once(peers[0], 'close');
  const resultAfterClose = await client.callTool({ name: 'send_input', arguments: { input: 'x', sessionId: globalId(windows[1], 'pane') } });
  assert.notEqual(resultAfterClose.isError, true);
});

test('satellite upgrade and browser origins reject unauthorized callers', async t => {
  const config = await temporaryConfig(); const hub = await startHub(config);
  t.after(async () => { await hub.close(); await rm(config.stateDir, { recursive: true, force: true }); });
  const trust: SatelliteTrust = JSON.parse(await readFile(join(config.stateDir, 'satellite.json'), 'utf8'));
  const forbidden = new WebSocket(trust.url, { ca: trust.certificate });
  await assert.rejects(once(forbidden, 'open'), /401/); forbidden.terminate();
  const response = await fetch(`http://127.0.0.1:${config.trustedPort}/mcp`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(response.status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${config.trustedPort}/health`)).status, 200);
});

test('Tailnet IPv6 Host and Origin forms pass trusted request checks', async t => {
  const config = await temporaryConfig();
  const identity = await tailscaleIdentity(async () => JSON.stringify({ BackendState: 'Running', Self: { Online: true, DNSName: 'host.tailnet.ts.net.' }, TailscaleIPs: ['fd7a::1'] }));
  config.trustedHosts = identity.hosts;
  const hub = await startHub(config);
  t.after(async () => { await hub.close(); await rm(config.stateDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${config.trustedPort}/health`;
  const headers = { Host: `[fd7a::1]:${config.trustedPort}`, Origin: `http://[fd7a::1]:${config.trustedPort}` };
  const status = (headers: Record<string, string>) => new Promise<number | undefined>((resolve, reject) => {
    request(base, { headers }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject).end();
  });
  assert.equal(await status(headers), 200);
  assert.equal(await status({ ...headers, Host: `[fd7a::2]:${config.trustedPort}` }), 403);
  assert.equal(await status({ ...headers, Origin: `http://[fd7a::2]:${config.trustedPort}` }), 403);
});

test('trusted host changes activate only after configuration persists', async t => {
  const config = await temporaryConfig(); config.trustedHosts = ['old.tailnet.ts.net'];
  const hub = await startHub(config);
  t.after(async () => { await hub.close(); await rm(config.stateDir, { recursive: true, force: true }); });
  const { adminCredential } = JSON.parse(await readFile(join(config.stateDir, 'secrets.json'), 'utf8'));
  const trust = JSON.parse(await readFile(join(config.stateDir, 'satellite.json'), 'utf8'));
  const update = () => new Promise<number>((resolve, reject) => {
    const req = secureRequest(`https://127.0.0.1:${config.satellitePort}/admin/trusted-hosts`, {
      method: 'POST', ca: trust.certificate, headers: { authorization: `Bearer ${adminCredential}`, 'content-type': 'application/json' },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.end(JSON.stringify({ hosts: ['new.tailnet.ts.net'] }));
  });
  const status = (host: string) => new Promise<number | undefined>((resolve, reject) => {
    request(`http://127.0.0.1:${config.trustedPort}/health`, { headers: {
      Host: `${host}:${config.trustedPort}`, Origin: `http://${host}:${config.trustedPort}`,
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject).end();
  });
  const target = join(config.stateDir, 'config.json'), backup = target + '.backup';
  await rename(target, backup); await mkdir(target);
  try {
    assert.equal(await update(), 500);
    assert.deepEqual(config.trustedHosts, ['old.tailnet.ts.net']);
    assert.equal(await status('old.tailnet.ts.net'), 200);
    assert.equal(await status('new.tailnet.ts.net'), 403);
  } finally { await rm(target, { recursive: true }); await rename(backup, target); }
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')).trustedHosts, ['old.tailnet.ts.net']);
  assert.equal(await update(), 200);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')).trustedHosts, ['new.tailnet.ts.net']);
  assert.equal(await status('new.tailnet.ts.net'), 200);
  assert.equal(await status('old.tailnet.ts.net'), 403);
});

test('initialization keeps private trust identity stable across concurrent callers', async t => {
  const config = await temporaryConfig(); t.after(() => rm(config.stateDir, { recursive: true, force: true }));
  const states = await Promise.all([initializeState(config.stateDir, config), initializeState(config.stateDir, config)]);
  assert.equal(states[0].trust.credential, states[1].trust.credential);
  assert.equal(states[0].trust.spkiPin, states[1].trust.spkiPin);
  assert.notEqual(states[0].adminCredential, states[0].trust.credential);
  if (process.platform !== 'win32') assert.equal((await stat(join(config.stateDir, 'secrets.json'))).mode & 0o077, 0);
});

test('public listener requires OAuth even from loopback and advertises prefixed discovery', async t => {
  const config = await temporaryConfig(); config.publicUrl = 'https://hub.example/tabby/mcp';
  const hub = await startHub(config);
  t.after(async () => { await hub.close(); await rm(config.stateDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${config.publicPort}`;
  const denied = await fetch(base + '/mcp');
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('www-authenticate'), 'Bearer resource_metadata="https://hub.example/.well-known/oauth-protected-resource/tabby/mcp"');
  assert.equal((await fetch(base + '/tabby/mcp', { headers: { origin: 'https://attacker.example' } })).status, 403);
  const metadata = await fetch(base + '/.well-known/oauth-protected-resource/tabby/mcp');
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).resource, config.publicUrl);
  const legacy = await fetch(`http://127.0.0.1:${config.trustedPort}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' },
    } }),
  });
  assert.equal(legacy.status, 200);
  assert.match(await legacy.text(), /2025-11-25/);
});

test('real satellite publishes newly created targets before the tool response', async t => {
  const config = await temporaryConfig(); const hub = await startHub(config);
  t.after(async () => { await hub.close(); await rm(config.stateDir, { recursive: true, force: true }); });
  const trust = JSON.parse(await readFile(join(config.stateDir, 'satellite.json'), 'utf8'));
  let created = false;
  const satellite = new SatelliteClient(() => trust, {
    capabilities: () => ['open_profile', 'send_input'],
    snapshot: async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
      return { tabs: created ? [{ id: 'fresh-tab' }] : [], sessions: [], profiles: [], transfers: [] };
    },
    run: async operation => {
      if (operation === 'open_profile') created = true;
      return { content: [{ type: 'text', text: JSON.stringify({ tabId: 'fresh-tab' }) }] };
    },
  });
  t.after(() => satellite.stop()); satellite.start();
  const deadline = Date.now() + 5000;
  while (satellite.status !== 'connected' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(satellite.status, 'connected');
  await hub.registry.call('open_profile', { windowId: satellite.windowId }, LOCAL_PRINCIPAL);
  // No polling or retry: the very next request uses the returned target.
  const result = await hub.registry.call('send_input', {
    tabId: globalId(satellite.windowId, 'fresh-tab'), input: 'hello',
  }, LOCAL_PRINCIPAL);
  assert.match(JSON.stringify(result), /fresh-tab/);
});


test('failed public bind and config publication leave no committed origin and allow a different retry', async t => {
  const config = await temporaryConfig(); const hub = await startHub(config);
  t.after(async () => { await hub.close(); await rm(config.stateDir, { recursive: true, force: true }); });
  const { adminCredential } = JSON.parse(await readFile(join(config.stateDir, 'secrets.json'), 'utf8'));
  const trust = JSON.parse(await readFile(join(config.stateDir, 'satellite.json'), 'utf8'));
  const configure = (publicUrl: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = secureRequest(`https://127.0.0.1:${config.satellitePort}/admin/configure`, {
      method: 'POST', ca: trust.certificate, headers: { authorization: `Bearer ${adminCredential}`, 'content-type': 'application/json' },
    }, res => { let text = ''; res.on('data', data => { text += data; }); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) })); });
    req.on('error', reject); req.end(JSON.stringify({ publicUrl }));
  });
  const persistedOrigin = async () => { const store = await openStore(config.stateDir); try { return store.get('public-origin'); } finally { store.close(); } };
  const occupied = createServer(); occupied.listen(config.publicPort, '127.0.0.1'); await once(occupied, 'listening');
  try { assert.equal((await configure('https://occupied.example/mcp')).status, 500); }
  finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  assert.equal(config.publicUrl, undefined); assert.equal(await persistedOrigin(), undefined);
  assert.equal(JSON.parse(await readFile(join(config.stateDir, 'config.json'), 'utf8')).publicUrl, undefined);
  const target = join(config.stateDir, 'config.json'), backup = target + '.backup';
  await rename(target, backup); await mkdir(target);
  try { assert.equal((await configure('https://unpublished.example/mcp')).status, 500); }
  finally { await rm(target, { recursive: true }); await rename(backup, target); }
  assert.equal(config.publicUrl, undefined); assert.equal(await persistedOrigin(), undefined);
  const success = await configure('https://final.example/tabby/mcp');
  assert.equal(success.status, 200); assert.match(success.body.url, /^https:\/\/final.example\/tabby\/owner\/enroll/);
  assert.equal(await persistedOrigin(), 'https://final.example');
  assert.equal(JSON.parse(await readFile(target, 'utf8')).publicUrl, 'https://final.example/tabby/mcp');
  assert.equal((await configure('https://migration.example/mcp')).status, 500);
  assert.equal(await persistedOrigin(), 'https://final.example');
});

test('failed auth origin commit rolls back persisted config and permits a fresh listener retry', async t => {
  const config = await temporaryConfig();
  let attempts = 0;
  const { createPublicAuth } = await import('../packages/hub/src/auth.js');
  const hub = await startHub(config, { authFactory: async (input, options) => {
    const auth = await createPublicAuth(input, options); const commit = auth.commitOrigin;
    auth.commitOrigin = () => { if (++attempts === 1) throw new Error('origin store failed'); commit(); }; return auth;
  } });
  t.after(async () => { await hub.close(); await rm(config.stateDir, { recursive: true, force: true }); });
  const { adminCredential } = JSON.parse(await readFile(join(config.stateDir, 'secrets.json'), 'utf8'));
  const trust = JSON.parse(await readFile(join(config.stateDir, 'satellite.json'), 'utf8'));
  const configure = (publicUrl: string) => new Promise<number>((resolve, reject) => {
    const req = secureRequest(`https://127.0.0.1:${config.satellitePort}/admin/configure`, {
      method: 'POST', ca: trust.certificate, headers: { authorization: `Bearer ${adminCredential}`, 'content-type': 'application/json' },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.end(JSON.stringify({ publicUrl }));
  });
  assert.equal(await configure('https://failed.example/mcp'), 500);
  assert.equal(config.publicUrl, undefined);
  assert.equal(JSON.parse(await readFile(join(config.stateDir, 'config.json'), 'utf8')).publicUrl, undefined);
  const store = await openStore(config.stateDir); try { assert.equal(store.get('public-origin'), undefined); } finally { store.close(); }
  assert.equal(await configure('https://recovered.example/mcp'), 200);
  assert.equal(attempts, 2);
  assert.equal((await fetch(`http://127.0.0.1:${config.publicPort}/.well-known/oauth-protected-resource/mcp`)).status, 200);
});

test('concurrent failed public setup restores the original config before retrying another origin', async t => {
  const config = await temporaryConfig();
  let started!: () => void, fail!: () => void, attempts = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { fail = resolve; });
  const { createPublicAuth } = await import('../packages/hub/src/auth.js');
  const hub = await startHub(config, { authFactory: async (input, options) => {
    if (++attempts === 1) { started(); await gate; throw new Error('setup failed'); }
    return createPublicAuth(input, options);
  } });
  t.after(async () => { fail(); await hub.close(); await rm(config.stateDir, { recursive: true, force: true }); });
  const { adminCredential } = JSON.parse(await readFile(join(config.stateDir, 'secrets.json'), 'utf8'));
  const trust = JSON.parse(await readFile(join(config.stateDir, 'satellite.json'), 'utf8'));
  // Wait until both request bodies have reached the real admin handler.
  const parse = JSON.parse;
  let parsed!: () => void, bodies = 0;
  const bothParsed = new Promise<void>(resolve => { parsed = resolve; });
  t.mock.method(JSON, 'parse', (text: string, ...args: any[]) => {
    const value = parse(text, ...args);
    if (text === '{"publicUrl":"https://failed.example/mcp"}' && ++bodies === 2) parsed();
    return value;
  });
  const configure = (publicUrl: string) => new Promise<number>((resolve, reject) => {
    const req = secureRequest(`https://127.0.0.1:${config.satellitePort}/admin/configure`, {
      method: 'POST', ca: trust.certificate, headers: { authorization: `Bearer ${adminCredential}`, 'content-type': 'application/json' },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.end(JSON.stringify({ publicUrl }));
  });
  const first = configure('https://failed.example/mcp'); await entered;
  const second = configure('https://failed.example/mcp');
  await bothParsed;
  await new Promise(resolve => setImmediate(resolve));
  fail();
  assert.deepEqual(await Promise.all([first, second]), [500, 500]);
  assert.equal(attempts, 1); assert.equal(config.publicUrl, undefined);
  assert.equal(JSON.parse(await readFile(join(config.stateDir, 'config.json'), 'utf8')).publicUrl, undefined);
  assert.equal(await configure('https://retry.example/mcp'), 200);
  assert.equal(attempts, 2); assert.equal(config.publicUrl, 'https://retry.example/mcp');
  const store = await openStore(config.stateDir);
  try { assert.equal(store.get('public-origin'), 'https://retry.example'); } finally { store.close(); }
});
