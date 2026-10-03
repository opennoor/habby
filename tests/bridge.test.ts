import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { runBridge } from '../packages/hub/src/bridge.js';

test('stdio bridge preserves JSON-RPC IDs, protocol version, tools, errors and input closure', async t => {
  const received: Array<{ method: string; id: string | number }> = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body); received.push(message);
    if (!('id' in message)) { res.writeHead(202); res.end(); return; }
    assert.equal(req.headers.authorization, 'Bearer secret');
    if (message.method !== 'initialize') assert.equal(req.headers['mcp-protocol-version'], '2025-11-25');
    res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'test-session' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } }
      : { tools: [{ name: 'list_windows', inputSchema: { type: 'object' } }] } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const input = new PassThrough(), output = new PassThrough();
  const errors: Error[] = []; const lines: string[] = [];
  let buffered = '';
  output.on('data', chunk => { buffered += chunk; let newline: number; while ((newline = buffered.indexOf('\n')) >= 0) { lines.push(buffered.slice(0, newline)); buffered = buffered.slice(newline + 1); output.emit('line'); } });
  const waitLine = async () => { if (!lines.length) await once(output, 'line'); return JSON.parse(lines.shift()!); };
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const done = runBridge(`http://127.0.0.1:${address.port}/mcp`, { input, output, token: 'secret', onerror: error => errors.push(error) });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 'opening', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
  assert.equal((await waitLine()).id, 'opening');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' }) + '\n');
  const tools = await waitLine(); assert.equal(tools.id, 42); assert.equal(tools.result.tools[0].name, 'list_windows');
  input.end(); await done;
  assert.deepEqual(received.map(x => x.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.equal(errors.length, 0);
});

test('bridge refuses credentials in URLs and bearer tokens over non-local cleartext', async () => {
  await assert.rejects(runBridge('https://user:secret@example.com/mcp'), /credentials/);
  await assert.rejects(runBridge('http://example.com/mcp', { token: 'secret' }), /HTTPS/);
});

test('lost mutation response produces an uncertain outcome without replay', async t => {
  let executions = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.method === 'tools/call') { executions++; req.socket.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const input = new PassThrough(), output = new PassThrough();
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const done = runBridge(`http://127.0.0.1:${address.port}/mcp`, { input, output, onerror: () => {} });
  const first = once(output, 'data');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
  await first;
  const failure = once(output, 'data');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'exec_command', arguments: { command: 'touch file' } } }) + '\n');
  const [data] = await failure;
  const message = JSON.parse(data.toString()); assert.equal(message.id, 2); assert.match(message.error.message, /unknown/);
  input.end(); await done; assert.equal(executions, 1);
});

test('bridge closes rather than buffering an oversized response for stdout', async t => {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { data: 'x'.repeat(4 * 1024 * 1024) } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const input = new PassThrough(), output = new PassThrough();
  const errors: Error[] = []; let outputBytes = 0; output.on('data', data => { outputBytes += data.length; });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const done = runBridge(`http://127.0.0.1:${address.port}/mcp`, { input, output, onerror: error => errors.push(error) });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  await done; input.end(); assert.equal(outputBytes, 0); assert.ok(errors.some(error => /output buffer limit/.test(error.message)));
});
