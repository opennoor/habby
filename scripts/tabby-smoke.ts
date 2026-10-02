/** Native acceptance check in an isolated Tabby profile. Linux uses Xvfb. Never installs a supervisor. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHub } from '../packages/hub/src/hub.js';
import { LOCAL_PRINCIPAL, parseGlobalId } from '../shared/protocol.js';

const isWindows = process.platform === 'win32';
if (process.platform !== 'linux' && !isWindows) throw new Error('This acceptance check supports Linux and Windows.');
if (isWindows && !process.env.TABBY_EXECUTABLE) throw new Error('Set TABBY_EXECUTABLE to the Windows Tabby executable.');
const waitMs = Number(process.env.TABBY_SMOKE_TIMEOUT_MS ?? 45000);
assert.ok(Number.isInteger(waitMs) && waitMs >= 10000 && waitMs <= 600000, 'Invalid TABBY_SMOKE_TIMEOUT_MS.');
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'tabby-hub-gui-'));
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function waitFor<T>(check: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + waitMs;
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
  const executable = process.env.TABBY_EXECUTABLE ?? '/opt/Tabby/tabby';
  const appArgs = ['--no-sandbox', `--user-data-dir=${data}`, `--remote-debugging-port=${debugPort}`, '--disable-gpu'];
  app = spawn(isWindows ? executable : 'xvfb-run', isWindows ? appArgs : ['-a', executable, ...appArgs], {
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
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Debugger request timed out.')); }, waitMs);
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
  const focusSequence = await firstWindow(`(() => {
    const module = require(${JSON.stringify(plugin)}).default;
    const Dialog = module.ɵinj.providers.find(provider => provider.prototype?.showOperationConfirmation);
    const service = new Dialog({ info(){}, warn(){}, error(){} }, { t: key => key }, {}, {});
    service.requestOsAttention = service.clearOsAttention = () => {};
    window.__modalFocusService = service;
    const outside = document.createElement('button'); outside.id = 'modal-focus-test'; document.body.append(outside); outside.focus();
    service.showDialog('Focus test', 'test', 'test');
    const sequence = [document.activeElement.className];
    for (const shiftKey of [false, false, true, true]) {
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      document.activeElement.dispatchEvent(event);
      if (!event.defaultPrevented) throw new Error('Dialog Tab was not trapped.');
      sequence.push(document.activeElement.className);
    }
    outside.focus();
    outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    sequence.push(document.activeElement.className);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    if (document.querySelector('.mcp-dialog-overlay')) throw new Error('Escape did not close the dialog.');
    return sequence;
  })()`);
  assert.deepEqual(focusSequence, ['reject', 'approve', 'reject', 'approve', 'reject', 'approve'].map(action => `mcp-dialog-btn mcp-dialog-btn-${action}`));
  await waitFor(() => firstWindow("document.activeElement.id === 'modal-focus-test'"), 'dialog focus restoration');
  await firstWindow(`(() => {
    window.__queuedModalResults = [];
    window.__modalFocusService.showOperationConfirmation('queued-first', 'test', 'first').then(result => window.__queuedModalResults.push(result));
    window.__modalFocusService.showOperationConfirmation('queued-second', 'test', 'second').then(result => window.__queuedModalResults.push(result));
    return true;
  })()`);
  await waitFor(() => firstWindow("document.querySelector('.mcp-dialog-panel')?.getAttribute('aria-label').endsWith('queued-first')"), 'first queued modal');
  await firstWindow("document.querySelector('.mcp-dialog-btn-approve').click();true");
  await waitFor(() => firstWindow("document.querySelector('.mcp-dialog-panel')?.getAttribute('aria-label').endsWith('queued-second')"), 'second queued modal');
  // Check focus after the prior modal's restoration timer has had a real renderer turn.
  await firstWindow("window.__queuedModalTimerPassed = false; setTimeout(() => window.__queuedModalTimerPassed = true, 20);true");
  await waitFor(() => firstWindow("window.__queuedModalTimerPassed"), 'queued modal timer turn');
  assert.equal(await firstWindow("document.querySelectorAll('.mcp-dialog-overlay').length === 1 && document.querySelector('.mcp-dialog-panel').contains(document.activeElement)"), true);
  await firstWindow("document.querySelector('.mcp-dialog-btn-reject').click();true");
  await waitFor(() => firstWindow("window.__queuedModalResults.length === 2 && document.activeElement.id === 'modal-focus-test'"), 'final queued modal focus restoration');
  assert.deepEqual(await firstWindow("window.__queuedModalResults"), [true, false]);
  assert.equal(await firstWindow("document.querySelectorAll('.mcp-dialog-overlay').length"), 0);
  await firstWindow("document.getElementById('modal-focus-test').remove(); delete window.__modalFocusService; delete window.__queuedModalResults; delete window.__queuedModalTimerPassed;true");
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
    const result = await tool('exec_command', { sessionId, command: isWindows ? `Write-Output ${marker}` : `printf ${marker}`, timeout: 30000 });
    assert.equal(result.success, true); assert.equal(result.exitCode, 0); assert.match(result.output, new RegExp(marker));
  };
  const windows = (await tool('list_windows', {})).windows.filter((window: any) => window.online);
  const sessions: string[] = [];
  for (const [index, window] of windows.entries()) {
    const profile = window.profiles.find((profile: any) => isWindows ? /powershell/i.test(profile.name) : profile.name === 'bash');
    assert(profile, `Native shell profile missing: ${JSON.stringify(window.profiles)}`);
    const opened = await tool('open_profile', { windowId: window.windowId, profileId: profile.profileId, waitForReady: true, timeout: 30000 });
    assert.equal(opened.ready, true, JSON.stringify(opened));
    sessions.push(opened.sessionId);
    const output = await tool('read_terminal_output', { sessionId: opened.sessionId });
    await execute(opened.sessionId, `TABBY_HUB_WINDOW_${index}`);
    const streamed = await tool('read_terminal_output', { sessionId: opened.sessionId, cursor: output.cursor });
    assert.match(Buffer.from(streamed.data, 'base64').toString(), new RegExp(`TABBY_HUB_WINDOW_${index}`));
  }
  const secondTarget = (await targets()).find(item => item.type === 'page' && item.id !== target.id); assert(secondTarget);
  const secondWindow = await debuggerCall(secondTarget.webSocketDebuggerUrl);
  // Some Tabby builds wrap profile tabs by default. Expose the existing terminal as
  // a raw top-level tab so acceptance must exercise the plugin's unsplit wrap path.
  const rawTerminal = await secondWindow(`(() => {
    const Module = require(${JSON.stringify(plugin)}).default;
    const Provider = Module.ɵinj.providers.find(provider => provider.prototype?.capabilities && provider.prototype?.snapshot);
    const service = require('@angular/core').getDebugNode(document.querySelector('app-root')).injector.get(Provider);
    const session = service.terminal.findSessionByLocator({ sessionId: ${JSON.stringify(parseGlobalId(sessions[1]).localId)} });
    if (!session) throw new Error('Original terminal missing.');
    if (session.isSplit) {
      const parent = session.tabParent;
      if (parent.getAllTabs().length !== 1) throw new Error('Expected a single initial pane.');
      const index = service.app.tabs.indexOf(parent);
      const tabId = service.tabs.getOrCreateTabId(parent);
      parent.removeTab(session.tab);
      service.app.removeTab(parent);
      service.tabs.tabToId.set(session.tab, tabId);
      service.app.addTabRaw(session.tab, index);
    }
    void service.client.snapshot();
    return service.terminal.findSessionByLocator({ sessionId: session.sessionId }).isSplit === false;
  })()`);
  assert.equal(rawTerminal, true, 'Fixture must expose an unsplit terminal before wrapping.');
  await waitFor(async () => (await tool('get_session_list', { windowId: windows[1].windowId }))
    .find((session: any) => session.sessionId === sessions[1])?.isSplit === false, 'unsplit original terminal');
  const topology = async () => (await tool('list_windows', {})).windows.find((window: any) => window.windowId === windows[1].windowId);
  const beforeSplit = await topology();
  const owningTabId = beforeSplit.sessions.find((session: any) => session.sessionId === sessions[1] || session.id === sessions[1])?.tabId;
  assert.ok(owningTabId, 'Original session must have a discovered owning tab.');
  let panes: any[] = [];
  for (const [index, direction] of ['right', 'left', 'top', 'bottom'].entries()) {
    await tool('split_tab', { sessionId: sessions[1], direction });
    panes = await waitFor(async () => {
      const window = await topology();
      assert.equal(window.tabs.length, beforeSplit.tabs.length, 'Splitting must not create a top-level tab.');
      const sameTab = window.sessions.filter((session: any) => session.tabId === owningTabId);
      if (sameTab.length !== index + 2) return undefined;
      const listed = await tool('get_session_list', { windowId: windows[1].windowId });
      const matched = listed.filter((session: any) => sameTab.some((pane: any) => pane.id === session.sessionId));
      return matched.length === index + 2 && matched.every((session: any) => session.isSplit && session.totalPanes === index + 2) ? sameTab : undefined;
    }, `same-tab ${direction} split panes`);
  }
  for (const [index, pane] of panes.entries()) await execute(pane.id, `TABBY_HUB_PANE_${index}`);
  await firstWindow("setTimeout(()=>require('@electron/remote').getCurrentWindow().destroy(),50);true");
  await waitFor(() => online().length === 1, 'first window disconnection');
  await execute(panes[1].id, 'TABBY_HUB_SURVIVES');
  await secondWindow("setTimeout(()=>require('@electron/remote').getCurrentWindow().destroy(),50);true");
  await waitFor(() => online().length === 0, 'all windows disconnected');
  assert.equal((await client.listTools()).tools.length, 38);
  console.log('PASS: modal keyboard focus and queued-dialog restoration, two real Tabby windows, new tabs, split panes, shell execution, output streaming, and Hub survival.');
} catch (error) { console.error(stderr); throw error; }
finally {
  await client?.close(); for (const socket of sockets) socket.close();
  if (app?.pid) {
    if (isWindows) await promisify(execFile)('taskkill.exe', ['/PID', String(app.pid), '/T', '/F']).catch(() => {});
    else { try { process.kill(-app.pid, 'SIGTERM'); } catch {} await new Promise(resolve => setTimeout(resolve, 500)); try { process.kill(-app.pid, 'SIGKILL'); } catch {} }
  }
  await hub.close(); await rm(temp, { recursive: true, force: true });
}
