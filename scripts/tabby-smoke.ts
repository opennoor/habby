/** Linux acceptance check in an isolated Tabby profile and Xvfb display. Never installs a supervisor. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHub } from '../packages/hub/src/hub.js';
import { LOCAL_PRINCIPAL } from '../shared/protocol.js';

if (process.platform !== 'linux') throw new Error('This acceptance check requires Linux, Tabby and xvfb-run.');
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'tabby-hub-gui-'));
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function waitFor<T>(check: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const result = await check(); if (result) return result as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
const config = { stateDir: join(temp, 'state'), trustedPort: await freePort(), satellitePort: await freePort(), publicPort: await freePort() };
const hub = await startHub(config);
let app: ReturnType<typeof spawn> | undefined;
let client: Client | undefined;
let stderr = '';
const sockets: WebSocket[] = [];
try {
  const data = join(temp, 'electron'); const plugin = join(data, 'plugins/node_modules/tabby-hub-satellite');
  await mkdir(plugin, { recursive: true });
  await cp(join(root, 'packages/satellite/dist'), join(plugin, 'dist'), { recursive: true });
  await cp(join(root, 'packages/satellite/package.json'), join(plugin, 'package.json'));
  await writeFile(join(plugin, 'hub-state.json'), JSON.stringify({ stateDir: config.stateDir }));
  await writeFile(join(data, 'config.yaml'), 'version: 7\nmcp:\n  pairProgrammingMode:\n    enabled: false\n    showConfirmationDialog: false\n    confirmFileOperations: false\n');
  const debugPort = await freePort();
  app = spawn('xvfb-run', ['-a', process.env.TABBY_EXECUTABLE ?? '/opt/Tabby/tabby', '--no-sandbox',
    `--user-data-dir=${data}`, `--remote-debugging-port=${debugPort}`, '--disable-gpu'], {
    env: { ...process.env, TABBY_CONFIG_DIRECTORY: data, TABBY_PLUGINS: '', NODE_PATH: '' },
    detached: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  app.on('error', error => { stderr += error.message; });
  app.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  const targets = async (): Promise<{ id: string; type: string; webSocketDebuggerUrl: string }[]> =>
    fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json()).catch(() => []);
  const target = await waitFor(async () => (await targets()).find(item => item.type === 'page'), 'Tabby startup');
  async function debuggerCall(url: string) {
    const socket = new WebSocket(url); sockets.push(socket); await once(socket, 'open');
    let serial = 0;
    const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
    socket.on('message', data => {
      const message = JSON.parse(String(data)); const request = pending.get(message.id);
      if (request) { pending.delete(message.id); request.resolve(message); }
    });
    socket.on('close', () => { for (const request of pending.values()) request.reject(new Error('Tabby window closed.')); pending.clear(); });
    return async (expression: string) => {
      const id = ++serial;
      const result = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Debugger request timed out.')); }, 10000);
        pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
      if (result.error || result.result?.exceptionDetails) throw new Error(JSON.stringify(result));
      return result.result?.result?.value;
    };
  }
  const firstWindow = await debuggerCall(target.webSocketDebuggerUrl);
  const online = () => (hub.registry.list(LOCAL_PRINCIPAL) as any[]).filter(window => window.online);
  await waitFor(() => online().length === 1, 'first satellite');
  await firstWindow("require('electron').ipcRenderer.send('app:new-window')");
  await waitFor(() => online().length === 2, 'second satellite');
  client = new Client({ name: 'real-Tabby-smoke', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.trustedPort}/mcp`)));
  assert.equal((await client.listTools()).tools.length, 38);
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await client!.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result));
    const value = JSON.parse((result.content as { type: string; text: string }[]).find(item => item.type === 'text')!.text);
    assert.notEqual(value.success, false, JSON.stringify(value)); return value;
  };
  const execute = async (sessionId: string, marker: string) => {
    const result = await tool('exec_command', { sessionId, command: `printf ${marker}`, timeout: 10000 });
    assert.equal(result.success, true); assert.equal(result.exitCode, 0); assert.match(result.output, new RegExp(marker));
  };
  const windows = (await tool('list_windows', {})).windows.filter((window: any) => window.online);
  const sessions: string[] = [];
  for (const [index, window] of windows.entries()) {
    const profile = window.profiles.find((profile: any) => profile.name === 'bash'); assert(profile);
    const opened = await tool('open_profile', { windowId: window.windowId, profileId: profile.profileId, waitForReady: true, timeout: 10000 });
    assert.equal(opened.ready, true, JSON.stringify(opened));
    sessions.push(opened.sessionId);
    const output = await tool('read_terminal_output', { sessionId: opened.sessionId });
    await execute(opened.sessionId, `TABBY_HUB_WINDOW_${index}`);
    const streamed = await tool('read_terminal_output', { sessionId: opened.sessionId, cursor: output.cursor });
    assert.match(Buffer.from(streamed.data, 'base64').toString(), new RegExp(`TABBY_HUB_WINDOW_${index}`));
  }
  await tool('split_tab', { sessionId: sessions[1], direction: 'right' });
  const panes = await waitFor(async () => {
    const result = await tool('get_session_list', { windowId: windows[1].windowId }); return result.length === 2 ? result : undefined;
  }, 'split panes');
  for (const [index, pane] of panes.entries()) await execute(pane.sessionId, `TABBY_HUB_PANE_${index}`);
  await firstWindow("setTimeout(()=>require('@electron/remote').getCurrentWindow().destroy(),50);true");
  await waitFor(() => online().length === 1, 'first window disconnection');
  await execute(panes[1].sessionId, 'TABBY_HUB_SURVIVES');
  const secondTarget = (await targets()).find(item => item.type === 'page' && item.id !== target.id); assert(secondTarget);
  const secondWindow = await debuggerCall(secondTarget.webSocketDebuggerUrl);
  await secondWindow("setTimeout(()=>require('@electron/remote').getCurrentWindow().destroy(),50);true");
  await waitFor(() => online().length === 0, 'all windows disconnected');
  assert.equal((await client.listTools()).tools.length, 38);
  console.log('PASS: two real Tabby windows, new tabs, split panes, shell execution, output streaming, and Hub survival.');
} catch (error) { console.error(stderr); throw error; }
finally {
  await client?.close(); for (const socket of sockets) socket.close();
  if (app?.pid) { try { process.kill(-app.pid, 'SIGTERM'); } catch {} await new Promise(resolve => setTimeout(resolve, 500)); try { process.kill(-app.pid, 'SIGKILL'); } catch {} }
  await hub.close(); await rm(temp, { recursive: true, force: true });
}
