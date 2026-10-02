import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHub } from '../packages/hub/src/hub.js';
import { initializeState } from '../packages/hub/src/state.js';
import { TOOLS } from '../shared/catalog.js';
import { globalId, LOCAL_PRINCIPAL, type HubConfig, type SatelliteTrust } from '../shared/protocol.js';
import { SatelliteClient } from '../packages/satellite/src/client.ts';

async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function temporaryConfig(): Promise<HubConfig> {
  return { stateDir: await mkdtemp(join(tmpdir(), 'tabby-hub-test-')), trustedPort: await freePort(),
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
