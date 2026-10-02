import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandCapture, commandWrapper, OutputRings, shellFromHints, uniqueMatch } from '../packages/satellite/src/runtime.ts';

test('ambiguous names never select the first session', () => {
    assert.throws(() => uniqueMatch(['prod', 'prod replica'], s => s.includes('prod')), /More than one/);
    assert.equal(uniqueMatch(['prod'], s => s === 'missing'), null);
});
test('wrappers use native shell syntax and shell hints reject REPLs', () => {
    for (const shell of ['sh', 'fish', 'powershell', 'cmd'] as const) {
        const wrapper = commandWrapper('echo hello', shell);
        assert.match(wrapper.start, /^__TABBY_[a-f0-9]{32}_START__$/);
        assert.notEqual(wrapper.start, commandWrapper('echo hello', shell).start);
    }
    assert.equal(shellFromHints('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'powershell');
    assert.equal(shellFromHints('cmd.exe'), 'cmd');
    assert.throws(() => shellFromHints('python REPL'), /known shell/);
    assert.match(commandWrapper('false', 'fish').text, /\$status/);
    assert.match(commandWrapper('Write-Error failure', 'powershell').text, /LASTEXITCODE/);
    assert.match(commandWrapper('exit \/b 4', 'cmd').text, /\r\necho\.\r\necho .*%errorlevel%/);
});
test('command markers survive arbitrary output chunk boundaries and ignore command echo', () => {
    const wrapper = commandWrapper('printf hello', 'sh');
    const capture = new CommandCapture(wrapper.start, wrapper.end);
    const stream = `${wrapper.text}\r\n${wrapper.start}\r\nhello\r\n${wrapper.end}:7\r\nprompt`;
    let result;
    for (const char of stream) { result = capture.feed(char); if (result) break; }
    assert.deepEqual(result, { output: 'hello', exitCode: 7, truncated: false });
});
test('Fish command text is quoted independently of the completion markers', () => {
    const wrapper = commandWrapper("printf '%s\\n' 'a\\b'\nprintf \"unterminated", 'fish', 'abc');
    assert.equal(wrapper.text, "printf '\\n%s%s\\n' '__TABBY_abc_' 'START__'; eval 'printf \\'%s\\\\n\\' \\'a\\\\b\\'\nprintf \"unterminated'; set -l tabby_hub_abc $status; printf '\\n%s%s:%s\\n' '__TABBY_abc_' 'END__' $tabby_hub_abc");
});
test('output cursors preserve arbitrary bytes, report eviction and reject ahead cursors', async () => {
    const ring = new OutputRings(8, 16);
    ring.append('one', Buffer.from([0xff, 0, 0xfe]));
    const first = await ring.read('one');
    assert.deepEqual(Buffer.from(first.data, 'base64'), Buffer.from([0xff, 0, 0xfe]));
    ring.append('one', '123456789');
    const second = await ring.read('one', first.cursor, 4);
    assert.equal(second.gap, true);
    assert.equal(Buffer.from(second.data, 'base64').toString(), '2345');
    const rest = await ring.read('one', second.cursor);
    assert.equal(Buffer.from(rest.data, 'base64').toString(), '6789');
    ring.append('one', 'AB');
    assert.equal(Buffer.from((await ring.read('one', rest.cursor)).data, 'base64').toString(), 'AB');
    await assert.rejects(ring.read('one', first.cursor.split(':')[0] + ':999'), /ahead/);
    const bounded = new OutputRings(1024 * 1024);
    bounded.append('huge', Buffer.alloc(16 * 1024 * 1024, 65));
    assert.equal((bounded as any).rings.get('huge').data.buffer.byteLength, 1024 * 1024);
    const backing = (bounded as any).rings.get('huge').data;
    bounded.append('huge', 'B');
    assert.equal((bounded as any).rings.get('huge').data, backing);
});
test('long polls wake on output and cancel when disconnected', async () => {
    const ring = new OutputRings();
    const initial = await ring.read('one');
    const pending = ring.read('one', initial.cursor, 65536, 25000);
    ring.append('one', 'new output');
    assert.equal((await pending).bytes, 10);
    const controller = new AbortController();
    const cancelled = ring.read('two', undefined, 65536, 25000, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    ring.dispose();
});
test('closing a terminal wakes its readers and preserves unrelated long polls', async () => {
    const ring = new OutputRings();
    try {
        const first = await ring.read('one'), second = await ring.read('two');
        let unrelatedSettled = false;
        const unrelated = ring.read('two', second.cursor, 65536, 25000).then(result => { unrelatedSettled = true; return result; });
        const closing = ring.read('one', first.cursor, 65536, 25000);
        ring.close('one');
        await assert.rejects(timeout(closing), /Terminal session closed/);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(unrelatedSettled, false);
        ring.append('two', 'still waiting');
        assert.equal((await timeout(unrelated)).bytes, 13);
    } finally { ring.dispose(); }
});
test('total output eviction wakes live session polls with a gap and a fresh cursor', async () => {
    const ring = new OutputRings(8, 8);
    try {
        ring.append('one', 'original');
        const original = await ring.read('one');
        const pending = ring.read('one', original.cursor, 65536, 25000);
        ring.append('two', 'other');
        const evicted = await timeout(pending);
        assert.equal(evicted.gap, true);
        assert.equal(evicted.bytes, 0);
        assert.notEqual(evicted.cursor.split(':')[0], original.cursor.split(':')[0]);
        assert.equal((ring as any).rings.size, 2);
        assert.equal([...((ring as any).rings.values())].reduce((sum: number, r: any) => sum + r.data.length, 0), 8);
        assert.deepEqual(await timeout(ring.read('one', original.cursor, 65536, 25000)), evicted);
        ring.append('one', 'next');
        const resumed = await ring.read('one', evicted.cursor);
        assert.equal(resumed.gap, false);
        assert.equal(Buffer.from(resumed.data, 'base64').toString(), 'next');
        const closed = ring.read('one', resumed.cursor, 65536, 25000);
        ring.close('one');
        await assert.rejects(timeout(closed), /Terminal session closed/);
        assert.equal((ring as any).rings.has('one'), false);
        const remaining = await ring.read('two');
        const disposed = ring.read('two', remaining.cursor, 65536, 25000);
        ring.dispose();
        await assert.rejects(timeout(disposed), /Terminal session closed/);
        assert.equal((ring as any).rings.size, 0);
    } finally { ring.dispose(); }
});

import { createServer } from 'node:https';
import { once } from 'node:events';
import { X509Certificate, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';
import { SatelliteClient, validateTrust, verifyPin } from '../packages/satellite/src/client.ts';

test('satellite trust rejects public or cleartext Hub URLs', () => {
    for (const url of ['ws://127.0.0.1:3002/satellite', 'wss://example.com/satellite', 'wss://127.0.0.1:3002/mcp']) {
        assert.throws(() => validateTrust({ url, certificate: '-----BEGIN CERTIFICATE-----', credential: 'x'.repeat(64), spkiPin: 'pin' }), /loopback/);
    }
});
async function tlsFixture() {
    const certificate = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
        keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }] }],
    });
    const cert = new X509Certificate(certificate.cert);
    const pin = 'sha256/' + createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const server = createServer({ cert: certificate.cert, key: certificate.private });
    const sockets = new WebSocketServer({ server });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as any).port;
    return { certificate, pin, server, sockets, url: `wss://127.0.0.1:${port}/satellite` };
}
function timeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Test network operation timed out.')), 5000);
        promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
}
test('pinned WSS satellite enforces scopes, caches mutations once, and rejects stale epochs', async () => {
    const f = await tlsFixture();
    let calls = 0;
    const client = new SatelliteClient(() => ({ url: f.url.replace('127.0.0.1', 'localhost'), certificate: f.certificate.cert, spkiPin: f.pin, credential: 'x'.repeat(64) }), {
        capabilities: () => ['exec_command', 'get_terminal_buffer'], snapshot: async () => ({ tabs: [], sessions: [], profiles: [], transfers: [] }),
        run: async () => { calls++; return { accepted: true }; },
    });
    try {
        const connected = once(f.sockets, 'connection'); client.start();
        const [peer, request] = await timeout(connected);
        assert.equal(request.headers.authorization, 'Bearer ' + 'x'.repeat(64));
        const [registration] = await timeout(once(peer, 'message'));
        const registered = JSON.parse(registration.toString());
        assert.equal(registered.protocol, 1); assert.equal(registered.windowId, client.windowId);
        peer.send(JSON.stringify({ type: 'registered', windowId: client.windowId, epoch: 'test-epoch', resumeToken: registered.resumeToken }));
        const send = async (id: string, scopes: string[], epoch = 'test-epoch') => {
            const received = response(id);
            peer.send(JSON.stringify({ type: 'request', id, windowId: client.windowId, epoch, operation: 'exec_command', params: { command: 'true' }, timeoutMs: 1000, principal: { id: 'agent', scopes } }));
            return await received;
        };
        // Discard snapshot events; collect responses by request ID.
        const response = (id: string) => timeout(new Promise<any>(resolve => {
            const handler = (data: any) => { const message = JSON.parse(data.toString()); if (message.type === 'response' && message.id === id) { peer.off('message', handler); resolve(message); } };
            peer.on('message', handler);
        }));
        const denied = await send('denied', ['terminal:read']);
        assert.equal(denied.error.code, 'FORBIDDEN'); assert.equal(calls, 0);
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = response('mutation');
            peer.send(JSON.stringify({ type: 'request', id: 'mutation', windowId: client.windowId, epoch: 'test-epoch', operation: 'exec_command', params: { command: 'true' }, timeoutMs: 1000, principal: { id: 'agent', scopes: ['terminal:write'] } }));
            assert.deepEqual((await result).result, { accepted: true });
        }
        assert.equal(calls, 1);
        const closed = once(peer, 'close');
        peer.send(JSON.stringify({ type: 'resnapshot', windowId: client.windowId, epoch: 'stale-epoch' }));
        assert.equal((await timeout(closed))[0], 1008);
    } finally {
        client.stop(); for (const socket of f.sockets.clients) socket.terminate();
        await new Promise<void>(resolve => f.sockets.close(() => resolve()));
        await new Promise<void>(resolve => f.server.close(() => resolve()));
    }
});
test('TLS SPKI mismatch blocks authentication credential before websocket upgrade', async () => {
    const f = await tlsFixture(); let upgrades = 0;
    f.sockets.on('connection', () => upgrades++);
    const client = new SatelliteClient(() => ({ url: f.url, certificate: f.certificate.cert, spkiPin: 'sha256/' + 'x'.repeat(44), credential: 'secret'.repeat(12) }), {
        capabilities: () => [], snapshot: async () => ({ tabs: [], sessions: [], profiles: [], transfers: [] }), run: async () => undefined,
    });
    try {
        assert.throws(() => verifyPin(new X509Certificate(f.certificate.cert).raw, 'wrong'), /identity changed/);
        client.start();
        await timeout(new Promise<void>(resolve => { const poll = setInterval(() => { if (client.status === 'disconnected') { clearInterval(poll); resolve(); } }, 10); }));
        assert.equal(upgrades, 0);
    } finally {
        client.stop(); for (const socket of f.sockets.clients) socket.terminate();
        await new Promise<void>(resolve => f.sockets.close(() => resolve()));
        await new Promise<void>(resolve => f.server.close(() => resolve()));
    }
});

import { execFileSync } from 'node:child_process';
test('Fish completion survives malformed commands and preserves shell state', t => {
    try { execFileSync('fish', ['--version'], { stdio: 'pipe' }); }
    catch { t.skip('fish runtime unavailable on this host'); return; }
    for (const command of ["printf 'unterminated", 'if', 'printf hello; )']) {
        const wrapper = commandWrapper(command, 'fish');
        const stream = execFileSync('fish', ['--no-config', '-c', wrapper.text], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        const result = new CommandCapture(wrapper.start, wrapper.end).feed(stream);
        assert.ok(result, 'Malformed commands must still emit a completion marker');
        assert.notEqual(result.exitCode, 0);
    }
    const quoted = commandWrapper("printf '%s\\n' \"a quote: ' and UTF-8: café\"\nprintf '%s\\n' 'a\\b'; false", 'fish');
    const stream = execFileSync('fish', ['--no-config', '-c', quoted.text], { encoding: 'utf8' });
    assert.deepEqual(new CommandCapture(quoted.start, quoted.end).feed(stream), { output: "a quote: ' and UTF-8: café\na\\b\n", exitCode: 1, truncated: false });
    const state = commandWrapper('set -g tabby_test_state retained', 'fish');
    const followup = commandWrapper('printf %s $tabby_test_state', 'fish');
    const persistent = execFileSync('fish', ['--no-config', '-c', `${state.text}\n${followup.text}`], { encoding: 'utf8' });
    assert.equal(new CommandCapture(followup.start, followup.end).feed(persistent)?.output, 'retained');
});
test('POSIX wrapper runs real shell command and captures native exit status', { skip: process.platform === 'win32' }, () => {
    const wrapper = commandWrapper("printf '%s\\n' \"a quote: ' and UTF-8: café\"; false", 'sh');
    const stream = execFileSync('/bin/bash', ['-c', wrapper.text], { encoding: 'utf8' });
    const result = new CommandCapture(wrapper.start, wrapper.end).feed(stream);
    assert.equal(result?.exitCode, 1);
    assert.equal(result?.output, "a quote: ' and UTF-8: café\n");
});
test('PowerShell wrapper executes in native pwsh when installed', t => {
    try { execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { stdio: 'pipe' }); }
    catch { t.skip('pwsh runtime unavailable on this host'); return; }
    const wrapper = commandWrapper(`Write-Output 'it''s café'; & '${process.execPath.replaceAll("'", "''")}' -e 'process.exit(7)'`, 'powershell');
    const stream = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapper.text], { encoding: 'utf8' });
    const result = new CommandCapture(wrapper.start, wrapper.end).feed(stream);
    assert.equal(result?.exitCode, 7);
    assert.equal(result?.output.replaceAll('\r\n', '\n'), "it's café\n");
});

test('PowerShell object formatting is flushed before completion and shell errors fail', t => {
    try { execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { stdio: 'pipe' }); }
    catch { t.skip('pwsh runtime unavailable'); return; }
    for (const [command, status] of [["[PSCustomObject]@{Name='hello'; Count=1}", 0], ["Write-Error bad", 1], ["throw 'failure'", 1]] as const) {
        const wrapper = commandWrapper(command, 'powershell');
        const stream = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapper.text], { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
        const result = new CommandCapture(wrapper.start, wrapper.end).feed(stream);
        assert.equal(result?.exitCode, status);
        if (!status) assert.match(result!.output, /hello/);
    }
});

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import * as runtime from '../packages/satellite/src/runtime.ts';

// Host boundaries are supplied here because Angular/Tabby's Electron modules cannot boot in Node tests.
// The target resolvers and all handler registration below execute the production source unchanged.
function hostCategories() {
    class Terminal { title = ''; hasFocus = false; profile = { name: '' }; frontend = {}; }
    class SSH extends Terminal {}
    class Split { hasFocus = false; title = ''; panes: Terminal[] = []; focused?: Terminal; getAllTabs() { return this.panes; } getFocusedTab() { return this.focused; } }
    class Base { mcpTools: any[] = []; constructor(public logger: unknown) {} registerTool(tool: any) { this.mcpTools.push(tool); } }
    const require = createRequire(import.meta.url);
    const load = (name: string, extra: Record<string, unknown> = {}) => {
        const source = readFileSync(new URL(`../packages/satellite/src/tools/${name}.ts`, import.meta.url), 'utf8');
        const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true, esModuleInterop: true } }).outputText;
        const module = { exports: {} as any };
        const injected = {
            '@angular/core': { Injectable: () => (value: unknown) => value, Inject: () => () => {}, forwardRef: (value: unknown) => value },
            'tabby-core': { BaseTabComponent: Terminal, SplitTabComponent: Split },
            'tabby-terminal': { BaseTerminalTabComponent: Terminal }, 'tabby-ssh': { SSHTabComponent: SSH },
            './base-tool-category': { BaseToolCategory: Base }, '../runtime': runtime,
            '../services/mcpLogger.service': {}, '../services/dialog.service': {},
            '../request-context': { checkRequest() {}, requestContext: { getStore() { return undefined; } } },
            '../execute': { execute() { throw new Error('Not part of target resolver test'); } },
            'strip-ansi': { __esModule: true, default: (text: string) => text }, ...extra,
        };
        vm.runInNewContext(output, { module, exports: module.exports, require: (key: string) => key in injected ? (injected as any)[key] : require(key), console, Buffer, setTimeout, clearTimeout }, { filename: name + '.ts' });
        return module.exports;
    };
    const { TerminalToolCategory } = load('terminal');
    const { TabManagementToolCategory } = load('tabManagement', { './terminal': { TerminalToolCategory } });
    const { SFTPToolCategory } = load('sftp', { './terminal': { TerminalToolCategory } });
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const app = { tabs: [] as any[] }, config = { store: {} }, profiles = { getProfiles: async () => [] };
    const terminal = new TerminalToolCategory(app, logger, config, {});
    const tabs = new TabManagementToolCategory(app, logger, config, profiles, terminal, { create: () => new Split() });
    const sftp = new SFTPToolCategory(app, config, logger, terminal, {});
    return { Terminal, SSH, Split, app, terminal, tabs, sftp };
}
test('production handler catalog includes all 36 upstream tools', () => {
    const host = hostCategories();
    assert.equal(new Set([...host.terminal.mcpTools, ...host.tabs.mcpTools, ...host.sftp.mcpTools].map(tool => tool.name)).size, 36);
});
test('satellite split schema accepts directions and rejects unsupported layout ratios', () => {
    const host = hostCategories();
    const tool = host.tabs.mcpTools.find((tool: any) => tool.name === 'split_tab');
    assert.equal(tool.schema.safeParse({ direction: 'right' }).success, true);
    assert.equal(tool.schema.safeParse({ direction: 'right', ratio: 0.2 }).success, false);
});
test('close tab reports success only after the host removes the target', async () => {
    const host = hostCategories();
    const tab = new host.Terminal(); tab.title = 'retained'; host.app.tabs = [tab];
    const tool = host.tabs.mcpTools.find((tool: any) => tool.name === 'close_tab');
    const tabId = host.tabs.getOrCreateTabId(tab);
    (host.app as any).closeTab = async () => {};
    const retained = JSON.parse((await tool.handler({ tabId })).content[0].text);
    assert.equal(retained.success, false); assert.equal(retained.tabId, tabId);
    (host.app as any).closeTab = async () => { host.app.tabs = []; };
    assert.equal(JSON.parse((await tool.handler({ tabId })).content[0].text).success, true);
});
test('production tab/session resolvers reject stale exact IDs, ambiguous names and inactive defaults', () => {
    const host = hostCategories();
    const a = new host.Terminal(); a.title = 'production'; a.profile.name = 'server';
    const b = new host.Terminal(); b.title = 'production replica'; b.profile.name = 'server replica';
    host.app.tabs = [a, b];
    assert.equal(host.terminal.findSessionByLocator({}), null);
    assert.equal(host.tabs.findTabByLocator({}), null);
    b.hasFocus = true;
    assert.equal(host.terminal.findSessionByLocator({}).tab, b);
    assert.equal(host.tabs.findTabByLocator({}), b);
    const tabId = host.tabs.getOrCreateTabId(a);
    const sessionId = host.terminal.getOrCreateSessionId(a);
    host.app.tabs = [b];
    assert.equal(host.tabs.findTabByLocator({ tabId, tabIndex: 0, title: 'replica' }), null);
    assert.equal(host.terminal.findSessionByLocator({ sessionId, tabIndex: 0, title: 'replica' }), null);
    host.app.tabs = [a, b];
    assert.throws(() => host.tabs.findTabByLocator({ title: 'production' }), /More than one/);
    assert.throws(() => host.terminal.findSessionByLocator({ profileName: 'server' }), /More than one/);
});
test('production SSH resolver uses exact pane IDs and active window pane defaults', () => {
    const host = hostCategories();
    const a = new host.SSH(); a.title = 'server';
    const b = new host.SSH(); b.title = 'server backup';
    const parent = new host.Split(); parent.panes = [a, b]; parent.focused = b;
    host.app.tabs = [parent];
    assert.equal(host.sftp.findSSHSession({}), null);
    parent.hasFocus = true;
    assert.equal(host.sftp.findSSHSession({}).tab, b);
    const id = host.terminal.getOrCreateSessionId(a);
    assert.equal(host.sftp.findSSHSession({ sessionId: id }).tab, a);
    parent.panes = [b];
    assert.equal(host.sftp.findSSHSession({ sessionId: id, tabIndex: 0 }), null);
    parent.panes = [a, b];
    assert.throws(() => host.sftp.findSSHSession({ title: 'server' }), /More than one/);
});

test('split pane identities are discoverable before their frontend initializes', () => {
    const host = hostCategories();
    const pane = new host.Terminal(); (pane as any).frontend = undefined;
    const parent = new host.Split(); parent.panes = [pane]; host.app.tabs = [parent];
    const id = host.terminal.getOrCreateSessionId(pane);
    assert.equal(host.terminal.findSessionByLocator({ sessionId: id }).tab, pane);
    assert.equal(host.terminal.findTerminalSessions()[0].sessionId, id);
});

import { Subject } from 'rxjs';
import { execute } from '../packages/satellite/src/execute.ts';
test('monitored execution rejects a second command and retains timed-out ownership until actual completion', { skip: process.platform === 'win32' }, async () => {
    const host = hostCategories();
    const terminal: any = new host.Terminal(); terminal.profile = { name: 'bash' }; terminal.hasFocus = true;
    const output = new Subject<string>(); const binary = new Subject<Buffer>();
    terminal.session = { open: true, output$: output, binaryOutput$: binary }; terminal.destroyed = new Subject<void>();
    let input = '';
    terminal.sendInput = (data: string) => { input = data; };
    host.app.tabs = [terminal]; (host.app as any).selectTab = () => {};
    const id = host.terminal.getOrCreateSessionId(terminal);
    const first: any = execute(host.terminal, { sessionId: id, command: 'printf actual-output', timeout: 5 });
    await assert.rejects(execute(host.terminal, { sessionId: id, command: 'false' }), /One monitored/);
    const timeoutResult = JSON.parse((await first).content[0].text);
    assert.equal(timeoutResult.error, 'TIMEOUT'); assert.equal(timeoutResult.outcomeUnknown, true);
    await assert.rejects(execute(host.terminal, { sessionId: id, command: 'false' }), /One monitored/);
    const completed = execFileSync('/bin/bash', ['-c', input.replace(/\r$/, '')], { encoding: 'utf8' });
    binary.next(Buffer.from(completed));
    assert.equal(host.terminal._activeCommands.size, 0);
    const next: any = execute(host.terminal, { sessionId: id, command: "printf 'héllo'", timeout: 1000 });
    const bytes = execFileSync('/bin/bash', ['-c', input.replace(/\r$/, '')]);
    for (const byte of bytes) binary.next(Buffer.from([byte]));
    assert.equal(JSON.parse((await next).content[0].text).output, 'héllo');
    binary.complete(); output.complete(); terminal.destroyed.complete();
});

import { WindowRegistry } from '../packages/hub/src/registry.ts';
import * as protocol from '../shared/protocol.ts';
import * as catalog from '../shared/catalog.ts';

test('lost first registration acknowledgement reconnects without surrendering window ownership', async () => {
    const f = await tlsFixture(), registry = new WindowRegistry();
    let registrations = 0, firstToken: string | undefined;
    let connectedPoll: ReturnType<typeof setInterval> | undefined;
    let recover!: () => void, fail!: (error: unknown) => void;
    const recovered = new Promise<void>((resolve, reject) => { recover = resolve; fail = reject; });
    f.sockets.on('connection', peer => peer.on('message', data => {
        try {
            const message = protocol.wireMessageSchema.parse(JSON.parse(data.toString()));
            if (message.type !== 'register') return;
            const bound = registry.register(message, outbound => peer.send(JSON.stringify(outbound)));
            assert.equal(bound.resumeToken, message.resumeToken);
            peer.once('close', () => registry.disconnect(message.windowId, bound.epoch));
            assert.throws(() => registry.register(message, () => {}), { code: 'DUPLICATE_WINDOW' });
            if (++registrations === 1) {
                firstToken = message.resumeToken;
                assert.match(firstToken!, /^[A-Za-z0-9_-]{43}$/);
                assert.equal(protocol.registerSchema.safeParse({ ...message, resumeToken: 'weak' }).success, false);
                assert.equal(protocol.wireMessageSchema.safeParse({ type: 'registered', windowId: message.windowId,
                    epoch: bound.epoch, resumeToken: 'weak' }).success, false);
                // Commit registration, but discard its acknowledgement before the client learns an epoch.
                peer.once('close', () => {
                    assert.throws(() => registry.register({ ...message, resumeToken: 'z'.repeat(43) }, () => {}), { code: 'INVALID_RESUME' });
                    assert.throws(() => registry.register({ ...message, resumeToken: undefined }, () => {}), { code: 'INVALID_RESUME' });
                });
                peer.close();
            } else {
                assert.equal(message.resumeToken, firstToken);
                peer.send(JSON.stringify({ type: 'registered', windowId: message.windowId, ...bound }));
                recover();
            }
        } catch (error) { fail(error); }
    }));
    const client = new SatelliteClient(() => ({ url: f.url, certificate: f.certificate.cert, spkiPin: f.pin, credential: 'x'.repeat(64) }), {
        capabilities: () => [], snapshot: async () => ({ tabs: [], sessions: [], profiles: [], transfers: [] }), run: async () => {},
    });
    try {
        client.start(); await timeout(recovered);
        await timeout(new Promise<void>(resolve => {
            connectedPoll = setInterval(() => { if (client.status === 'connected') resolve(); }, 10);
        }));
        assert.equal(registrations, 2);
        assert.equal((registry.list(protocol.LOCAL_PRINCIPAL)[0] as any).online, true);
    } finally {
        clearInterval(connectedPoll); client.stop(); registry.close();
        for (const peer of f.sockets.clients) peer.terminate();
        await new Promise<void>(resolve => f.sockets.close(() => resolve()));
        await new Promise<void>(resolve => f.server.close(() => resolve()));
    }
});

test('production SatelliteService rejects conflicting exact selectors before selecting or invoking', async () => {
    const source = readFileSync(new URL('../packages/satellite/src/satellite.service.ts', import.meta.url), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true, esModuleInterop: true } }).outputText;
    const module = { exports: {} as any }, require = createRequire(import.meta.url);
    const injected: Record<string, unknown> = {
        '@angular/core': { Injectable: () => (value: unknown) => value, Inject: () => () => {} },
        'tabby-core': { BOOTSTRAP_DATA: {} }, '../../../shared/catalog': catalog, '../../../shared/protocol': protocol,
        '../../../shared/paths': { defaultStateDir: () => '' }, './runtime': runtime,
        './client': { SatelliteClient: class { windowId = '00000000-0000-4000-8000-000000000001'; stop() {} } },
        './request-context': { requestContext: { run: (_signal: unknown, callback: () => unknown) => callback() } },
        './tools/terminal': {}, './tools/tabManagement': {}, './tools/sftp': {},
    };
    vm.runInNewContext(output, { module, exports: module.exports, require: (key: string) => key in injected ? injected[key] : require(key),
        console, Buffer, process, setTimeout, clearTimeout }, { filename: 'satellite.service.ts' });
    const selected: any[] = [], invoked: any[] = [], focused: any[] = [];
    const a = {}, b = { focus: (pane: unknown) => focused.push(pane) }, pane = {};
    const session = { sessionId: 'pane-b', tabParent: b, tab: pane, isSplit: true, isFocusedPane: true };
    const app = { tabs: [a, b], selectTab: (tab: unknown) => selected.push(tab) };
    const handler = async (params: any) => { invoked.push(params); return { success: true }; };
    const terminal = { mcpTools: [{ name: 'exec_command', handler }], findTerminalSessions: () => [session],
        findSessionByLocator: ({ sessionId }: any) => sessionId === 'pane-b' ? session : null };
    const tabs = { mcpTools: [{ name: 'split_tab', handler }], findTabByLocator: ({ tabId }: any) => tabId === 'tab-a' ? a : tabId === 'tab-b' ? b : null };
    const service = new module.exports.SatelliteService(app, { store: {} }, { run: (callback: () => unknown) => callback() },
        terminal, tabs, { mcpTools: [] }, { windowID: 1 });
    const signal = new AbortController().signal;
    try {
        for (const [operation, params] of [['split_tab', { direction: 'right' }], ['exec_command', { command: 'true' }]] as const) {
            await assert.rejects(service.run(operation, { ...params, tabId: 'tab-a', sessionId: 'pane-b' }, protocol.LOCAL_PRINCIPAL, signal), { code: 'TARGET_CONFLICT' });
        }
        await assert.rejects(service.run('split_tab', { direction: 'right', tabId: 'tab-a', sessionId: 'gone' }, protocol.LOCAL_PRINCIPAL, signal), { code: 'TARGET_GONE' });
        assert.equal(selected.length, 0); assert.equal(focused.length, 0); assert.equal(invoked.length, 0);
        await service.run('split_tab', { direction: 'right', tabId: 'tab-b', sessionId: 'pane-b' }, protocol.LOCAL_PRINCIPAL, signal);
        assert.ok(selected.length > 0); assert.ok(selected.every(tab => tab === b)); assert.deepEqual(focused, [pane]);
        assert.equal(invoked[0].tabIndex, 1);
        await service.run('exec_command', { command: 'true', tabId: 'tab-b', sessionId: 'pane-b' }, protocol.LOCAL_PRINCIPAL, signal);
        assert.equal(invoked[1].sessionId, 'pane-b');
    } finally { service.ngOnDestroy(); }
});


test('split wraps an unsplit terminal in place and keeps all four directions inside its owning tab', async () => {
    for (const [direction, side] of [['right', 'r'], ['left', 'l'], ['top', 't'], ['bottom', 'b']] as const) {
        const host = hostCategories(), original = new host.Terminal(), before = {}, after = {};
        host.app.tabs = [before, original, after];
        const app = host.app as any; app.activeTab = original; app.getParentTab = () => null;
        app.duplicateTab = () => { throw new Error('Top-level duplication must never be used for splitting.'); };
        app.removeTab = (tab: any) => { app.tabs = app.tabs.filter((item: any) => item !== tab); };
        app.addTabRaw = (tab: any, index: number) => { app.tabs.splice(index, 0, tab); app.activeTab = tab; };
        const calls: any[] = [];
        (host.Split.prototype as any).addTab = async function (tab: any, relative: any, side: string) {
            calls.push(['add', tab, relative, side]); this.panes.push(tab); this.focused = tab;
        };
        (host.Split.prototype as any).splitTab = async function (tab: any, side: string) {
            calls.push(['split', tab, side]); const pane = new host.Terminal(); this.panes.push(pane); return pane;
        };
        const id = host.tabs.getOrCreateTabId(original);
        const tool = host.tabs.mcpTools.find((tool: any) => tool.name === 'split_tab');
        const result = JSON.parse((await tool.handler({ direction })).content[0].text);
        assert.equal(result.success, true); assert.equal(result.tabId, id); assert.equal(result.paneCount, 2);
        assert.equal(app.tabs.length, 3); assert.equal(app.tabs[0], before); assert.equal(app.tabs[2], after);
        assert.ok(app.tabs[1] instanceof host.Split); assert.equal(host.tabs.findTabByLocator({ tabId: id }), app.tabs[1]);
        assert.equal(app.tabs[1].panes[0], original); assert.equal(calls[1][1], original); assert.equal(calls[1][2], side);
        const sessions = host.terminal.findTerminalSessions();
        assert.equal(sessions.length, 2); assert.ok(sessions.every((session: any) => session.tabParent === app.tabs[1] && session.isSplit));
    }
});

test('existing split roots and child targets split directly; unsupported and refused splits never duplicate', async () => {
    for (const childTarget of [false, true]) {
        const host = hostCategories(), pane = new host.Terminal(), wrapper = new host.Split();
        wrapper.panes = [pane]; wrapper.focused = pane; host.app.tabs = [wrapper];
        const app = host.app as any; app.activeTab = childTarget ? pane : wrapper; app.getParentTab = () => wrapper;
        let duplicates = 0, calls = 0;
        app.duplicateTab = () => { duplicates++; throw new Error('Unexpected duplication'); };
        const tool = host.tabs.mcpTools.find((tool: any) => tool.name === 'split_tab');
        (wrapper as any).splitTab = async (target: any, side: string) => {
            calls++; assert.equal(target, pane); assert.equal(side, 'l'); const next = new host.Terminal(); wrapper.panes.push(next); return next;
        };
        assert.equal(JSON.parse((await tool.handler({ direction: 'left' })).content[0].text).success, true);
        for (const refusal of [null, new Error('host refused'), new host.Terminal()]) {
            (wrapper as any).splitTab = async () => { calls++; if (refusal instanceof Error) throw refusal; return refusal; };
            assert.equal(JSON.parse((await tool.handler({ direction: 'right' })).content[0].text).success, false);
        }
        assert.equal(calls, 4); assert.equal(duplicates, 0); assert.deepEqual(app.tabs, [wrapper]);
        app.activeTab = {}; app.getParentTab = () => null;
        assert.equal(JSON.parse((await tool.handler({ direction: 'bottom' })).content[0].text).error, 'UNSUPPORTED_SPLIT');
        wrapper.focused = undefined; app.activeTab = wrapper;
        assert.equal(JSON.parse((await tool.handler({ direction: 'top' })).content[0].text).error, 'UNSUPPORTED_SPLIT');
        assert.equal(calls, 4); assert.equal(duplicates, 0);
    }
});


test('split factory and host failures retain the original terminal without top-level duplication', async () => {
    for (const failure of ['factory', 'refused', 'exception']) {
        const host = hostCategories(), original = new host.Terminal(); host.app.tabs = [original];
        const app = host.app as any; app.activeTab = original; app.getParentTab = () => null;
        app.duplicateTab = () => { throw new Error('Unexpected duplication'); };
        app.removeTab = (tab: any) => { app.tabs = app.tabs.filter((item: any) => item !== tab); };
        app.addTabRaw = (tab: any, index: number) => { app.tabs.splice(index, 0, tab); app.activeTab = tab; };
        if (failure === 'factory') (host.tabs as any).tabFactory.create = () => { throw new Error('factory unavailable'); };
        (host.Split.prototype as any).addTab = async function (tab: any) { this.panes.push(tab); this.focused = tab; };
        (host.Split.prototype as any).splitTab = async () => { if (failure === 'exception') throw new Error('host failed'); return null; };
        const id = host.tabs.getOrCreateTabId(original);
        const result = JSON.parse((await host.tabs.mcpTools.find((tool: any) => tool.name === 'split_tab').handler({ direction: 'right' })).content[0].text);
        assert.equal(result.success, false); assert.equal(app.tabs.length, 1);
        assert.equal(host.tabs.findTabByLocator({ tabId: id }), app.tabs[0]);
        if (failure === 'factory') assert.equal(app.tabs[0], original);
        else assert.deepEqual(app.tabs[0].getAllTabs(), [original]);
    }
});

test('failed wrapper attachment restores the original session, tab ID and position without destroying it', async () => {
    for (const failure of ['before-attach', 'after-attach', 'refused']) {
        const host = hostCategories(), original = new host.Terminal(), before = {}, after = {};
        host.app.tabs = [before, original, after];
        const app = host.app as any; app.activeTab = original; app.getParentTab = () => null;
        app.removeTab = (tab: any) => { app.tabs = app.tabs.filter((item: any) => item !== tab); };
        app.addTabRaw = (tab: any, index: number) => { app.tabs.splice(index, 0, tab); app.activeTab = tab; };
        let changed = 0, destroyedWrappers = 0;
        app.selectTab = (tab: any) => { app.activeTab = tab; }; app.emitTabsChanged = () => changed++;
        (original as any).destroy = () => { throw new Error('Original terminal must survive.'); };
        (original as any).removeFromContainer = () => {};
        (host.Split.prototype as any).addTab = async function (tab: any) {
            if (failure === 'after-attach') { this.panes.push(tab); tab.parent = this; }
            if (failure !== 'refused') throw new Error('attachment failed');
        };
        (host.Split.prototype as any).removeTab = function (tab: any) { this.panes = this.panes.filter((item: any) => item !== tab); };
        (host.Split.prototype as any).destroy = function () { assert.equal(this.panes.length, 0); destroyedWrappers++; };
        (host.Split.prototype as any).splitTab = () => { throw new Error('Split must not run after attachment failure.'); };
        const tabId = host.tabs.getOrCreateTabId(original), sessionId = host.terminal.getOrCreateSessionId(original);
        const result = JSON.parse((await host.tabs.mcpTools.find((tool: any) => tool.name === 'split_tab').handler({ direction: 'right' })).content[0].text);
        assert.equal(result.success, false); assert.deepEqual(app.tabs, [before, original, after]);
        assert.equal(app.activeTab, original); assert.equal(host.tabs.findTabByLocator({ tabId }), original);
        assert.equal(host.terminal.findSessionByLocator({ sessionId }).tab, original);
        assert.equal((original as any).parent, null); assert.equal(changed, 1); assert.equal(destroyedWrappers, 1);
    }
});
