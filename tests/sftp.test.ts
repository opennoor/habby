import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { requestContext, checkRequest } from '../packages/satellite/src/request-context.ts';

// Execute the real adapters and handlers without booting Angular or Electron.
const require = createRequire(import.meta.url);
function loadSftp(writeSync = fs.writeSync) {
    const module = { exports: {} as any };
    const source = fs.readFileSync(new URL('../packages/satellite/src/tools/sftp.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source + '\nexport { StreamFileDownload, StreamFileUpload };', {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
    }).outputText;
    const dummy = class {};
    const mockRequire = (id: string) => {
        if (id === 'fs') return { ...fs, writeSync };
        if (id === '@angular/core') return { Injectable: () => (value: unknown) => value };
        if (id === 'tabby-core') return { AppService: dummy, ConfigService: dummy, SplitTabComponent: dummy };
        if (id === 'tabby-ssh') return { SSHTabComponent: dummy };
        if (id === '../runtime') return {};
        if (id === '../request-context') return { requestContext, checkRequest };
        if (id === './base-tool-category') return { BaseToolCategory: class {
            mcpTools: any[] = [];
            constructor(public logger: any) {}
            registerTool(tool: any) { this.mcpTools.push(tool); }
        } };
        if (id === '../services/mcpLogger.service') return { McpLoggerService: dummy };
        if (id === '../services/dialog.service') return { DialogService: dummy };
        if (id === './terminal') return { TerminalToolCategory: dummy };
        return require(id);
    };
    runInNewContext(compiled, { module, exports: module.exports, require: mockRequire, Buffer, TextEncoder, setTimeout, clearTimeout });
    return module.exports;
}
const { StreamFileDownload, StreamFileUpload, SFTPToolCategory } = loadSftp();
const logger = { info() {}, debug() {}, warn() {}, error() {} };
test('text writes close the remote SFTP handle on success and failure', async () => {
    for (const fails of [false, true]) {
        let closes = 0;
        const tools = category({ open: async () => ({ write: async () => { if (fails) throw new Error('remote write failed'); }, close: async () => { closes++; } }) });
        const result = JSON.parse((await tools.mcpTools.find((tool: any) => tool.name === 'sftp_write_file').handler({ path: '/file', content: 'text' })).content[0].text);
        assert.equal(result.success, !fails); assert.equal(closes, 1);
        if (fails) assert.equal(result.error, 'remote write failed');
    }
});
function category(backend?: any, timeout = 30, Category = SFTPToolCategory) {
    const tool = new Category({}, { store: { mcp: { sftp: { timeout } } } }, logger, {}, {});
    tool.findSSHSession = () => ({ sessionId: 'pane', tab: { title: 'test', sshSession: { open: true } } });
    tool.getSFTPSession = async () => backend;
    return tool;
}
function fixture(t: any) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-sftp-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const destination = path.join(directory, 'existing');
    fs.writeFileSync(destination, 'original');
    return { directory, destination };
}

test('downloads replace an existing destination only after exact-size EOF and handle short writes', async t => {
    const { directory, destination } = fixture(t);
    const { StreamFileDownload: ShortWriteDownload } = loadSftp((fd: any, buffer: any, offset: any, length: any) =>
        fs.writeSync(fd, buffer, offset, Math.min(length, 2)));
    const download = new ShortWriteDownload(destination, 7);
    await download.write(Buffer.from('updated'));
    assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
    assert.equal(download.isComplete(), false);
    const staged = fs.readdirSync(directory).find(name => name.endsWith('.tmp'))!;
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, staged)).mode & 0o777, 0o600);
    download.close();
    assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
    download.commit();
    assert.equal(fs.readFileSync(destination, 'utf8'), 'updated');
    assert.deepEqual(fs.readdirSync(directory), ['existing']);
});

test('failed, cancelled, mismatched and empty downloads preserve the destination until success', async t => {
    const { directory, destination } = fixture(t);
    for (const scenario of ['failure', 'cancel', 'short', 'grew']) {
        const download = new StreamFileDownload(destination, 4);
        await download.write(Buffer.from('ab'));
        if (scenario === 'grew') await assert.rejects(download.write(Buffer.from('123')), /grew/);
        if (scenario === 'short') { download.close(); assert.throws(() => download.commit(), /incomplete/); }
        download.cancel();
        download.close();
        assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
        assert.deepEqual(fs.readdirSync(directory), ['existing']);
    }
    const empty = new StreamFileDownload(destination, 0);
    assert.equal(empty.isComplete(), false);
    empty.close();
    empty.commit();
    assert.equal(fs.statSync(destination).size, 0);
    assert.deepEqual(fs.readdirSync(directory), ['existing']);
});

test('backend success commits empty and nonempty downloads; backend failure and UI cancellation preserve existing files', async t => {
    const { directory, destination } = fixture(t);
    for (const content of ['replacement', '']) {
        const tools = category({ stat: async () => ({ size: content.length }), download: async (_: string, stream: any) => {
            if (content) await stream.write(Buffer.from(content));
            stream.close();
        } });
        const result = await tools.mcpTools.find((tool: any) => tool.name === 'sftp_download').handler({ remotePath: '/file', localPath: destination });
        assert.equal(JSON.parse(result.content[0].text).success, true);
        assert.equal(fs.readFileSync(destination, 'utf8'), content);
    }
    fs.writeFileSync(destination, 'original');
    for (const scenario of ['failure', 'cancel']) {
        let tools: any;
        tools = category({ stat: async () => ({ size: 4 }), download: async (_: string, stream: any) => {
            await stream.write(Buffer.from('abcd'));
            if (scenario === 'cancel') tools.cancelTransferById(tools.getTransfers()[0].id);
            else stream.close();
            throw new Error('Backend failed after writing');
        } });
        const result = await tools.mcpTools.find((tool: any) => tool.name === 'sftp_download').handler({ remotePath: '/file', localPath: destination });
        assert.equal(JSON.parse(result.content[0].text).success, false);
        assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
        assert.deepEqual(fs.readdirSync(directory), ['existing']);
        assert.equal(tools.getTransfers()[0].status, scenario === 'cancel' ? 'cancelled' : 'failed');
        assert.equal(tools.getTransfers()[0].cancelCallback, undefined);
    }
});

test('configured deadlines reject stalled backends and clean staging and running tasks', async t => {
    const { directory, destination } = fixture(t);
    const tools = category({ stat: async () => ({ size: 7 }), download: async (_: string, stream: any) => {
        await stream.write(Buffer.from('ab'));
        return new Promise(() => {});
    } });
    const result = await tools.mcpTools.find((tool: any) => tool.name === 'sftp_download').handler({ remotePath: '/file', localPath: destination });
    const response = JSON.parse(result.content[0].text);
    assert.equal(response.success, false);
    assert.match(response.error, /timed out after 30ms/);
    assert.equal(tools.getTransfers()[0].status, 'failed');
    assert.equal(tools.getTransfers()[0].cancelCallback, undefined);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(directory), ['existing']);
});

test('request cancellation and disconnection reject stalled transfers and discard staging', async t => {
    const { directory, destination } = fixture(t);
    const controller = new AbortController();
    await requestContext.run(controller.signal, async () => {
        const download = new StreamFileDownload(destination, 4);
        await download.write(Buffer.from('ab'));
        const pending = category(undefined, 10000).waitForTransferComplete(new Promise(() => {}), download, { open: true }, 5);
        controller.abort();
        await assert.rejects(pending, /cancelled/);
    });
    const disconnected = new StreamFileDownload(destination, 4);
    await disconnected.write(Buffer.from('ab'));
    await assert.rejects(category().waitForTransferComplete(new Promise(() => {}), disconnected, { open: false }, 5), /connection lost/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(directory), ['existing']);
});

test('a resolved incomplete backend fails; polling waits for backend close including empty uploads', async t => {
    const { destination } = fixture(t);
    const tools = category();
    const incomplete = new StreamFileDownload(destination, 4);
    await incomplete.write(Buffer.from('ab'));
    incomplete.close();
    await assert.rejects(tools.waitForTransferComplete(Promise.resolve(), incomplete, { open: true }, 5), /expected file size/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
    const upload = new StreamFileUpload(destination, 8);
    await upload.read();
    assert.equal(upload.isComplete(), false);
    const completed = tools.waitForTransferComplete(new Promise(() => {}), upload, { open: true }, 5);
    upload.close();
    assert.equal(await completed, 'completed_via_polling');
    fs.writeFileSync(destination, '');
    const empty = new StreamFileUpload(destination, 0);
    assert.equal(empty.isComplete(), false);
    const pending = tools.waitForTransferComplete(new Promise(() => {}), empty, { open: true }, 5);
    empty.close();
    assert.equal(await pending, 'completed_via_polling');
});

test('interrupted opaque uploads report unknown outcomes before a late remote commit and never replay', async t => {
    const { destination } = fixture(t);
    const decode = (response: any) => JSON.parse(response.content[0].text);
    for (const scenario of ['timeout', 'cancel', 'abort', 'disconnect', 'async']) {
        const controller = new AbortController();
        await requestContext.run(controller.signal, async () => {
            let release!: () => void, entered!: () => void;
            const barrier = new Promise<void>(resolve => { release = resolve; });
            const atEof = new Promise<void>(resolve => { entered = resolve; });
            let remote = 'original', calls = 0, settled!: Promise<void>;
            const tools = category({ upload: (_: string, stream: any) => {
                calls++;
                settled = (async () => {
                    await stream.read();
                    assert.equal((await stream.read()).length, 0);
                    entered();
                    // Tabby's upload awaits remote close after EOF, then unlinks/renames
                    // without reading the adapter again or checking its cancellation.
                    await barrier;
                    remote = 'replacement';
                    stream.close();
                })();
                return settled;
            } }, scenario === 'timeout' || scenario === 'async' ? 20 : 10000);
            const session = { sessionId: 'pane', tab: { title: 'test', sshSession: { open: true } } };
            tools.findSSHSession = () => session;
            const invoke = (name: string, params: any) => tools.mcpTools.find((tool: any) => tool.name === name).handler(params);
            const pending = invoke('sftp_upload', { localPath: destination, remotePath: '/file', sync: scenario !== 'async' });
            try {
                await atEof;
                const task = tools.getTransfers()[0];
                if (scenario === 'cancel') {
                    const response = decode(await invoke('sftp_cancel_transfer', { transferId: task.id }));
                    assert.equal(response.status, 'unknown');
                    assert.equal(response.code, 'OUTCOME_UNKNOWN');
                    assert.match(response.message, /unknown/);
                }
                if (scenario === 'abort') controller.abort();
                if (scenario === 'disconnect') session.tab.sshSession.open = false;
                const response = decode(await pending);
                if (scenario === 'async') {
                    assert.equal(response.async, true);
                    await new Promise<void>((resolve, reject) => {
                        const deadline = setTimeout(() => { clearInterval(poll); reject(new Error('Unknown outcome not published')); }, 2000);
                        const poll = setInterval(() => { if (task.status === 'unknown') { clearTimeout(deadline); clearInterval(poll); resolve(); } }, 5);
                    });
                } else {
                    assert.equal(response.success, false);
                    assert.equal(response.code, 'OUTCOME_UNKNOWN');
                    assert.match(response.error, /inspect the remote file before retrying/i);
                }
                assert.equal(remote, 'original');
                assert.equal(task.status, 'unknown'); // Also used by the window snapshot.
                assert.equal(task.cancelCallback, undefined);
                assert.equal(decode(await invoke('sftp_get_transfer_status', { transferId: task.id })).code, 'OUTCOME_UNKNOWN');
                const listed = decode(await invoke('sftp_list_transfers', { status: 'unknown' })).transfers;
                assert.equal(listed.length, 1); assert.equal(listed[0].status, 'unknown');
                assert.equal(listed[0].code, 'OUTCOME_UNKNOWN');
                release(); await settled;
                assert.equal(remote, 'replacement');
                assert.equal(task.status, 'unknown');
                assert.equal(calls, 1);
                tools.clearCompletedTransfers();
                assert.equal(tools.getTransfers().length, 0);
            } finally { release(); await settled; }
        });
    }
});

test('uploads and downloads share capacity through cancelled or unknown backend lifetimes', { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { SFTPToolCategory: TimedCategory } = loadSftp();
    const decode = (response: any) => JSON.parse(response.content[0].text);
    const gates: Array<{ resolve: () => void; reject: (error: Error) => void; promise: Promise<void> }> = [];
    t.after(async () => {
        for (const gate of gates) gate.resolve();
        await Promise.allSettled(gates.map(gate => gate.promise));
        await new Promise(resolve => setImmediate(resolve));
    });
    const { directory, destination } = fixture(t);
    let uploads = 0, downloads = 0, stats = 0, ready = 0;
    let enteredAll!: () => void;
    const allEntered = new Promise<void>(resolve => { enteredAll = resolve; });
    const entered = () => { if (++ready === 16) enteredAll(); };
    const defer = () => {
        let resolve!: () => void, reject!: (error: Error) => void;
        const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        const gate = { resolve, reject, promise }; gates.push(gate); return gate;
    };
    const tools = category({
        stat: async () => { stats++; return { size: 4 }; },
        upload: async (_: string, stream: any) => {
            uploads++; const gate = defer(); await stream.read(); await stream.read(); entered();
            await gate.promise; stream.close();
        },
        download: async (_: string, stream: any) => {
            downloads++; const gate = defer(); await stream.write(Buffer.from('a')); entered();
            await gate.promise; await stream.write(Buffer.from('bcd')); stream.close();
        },
    }, 20, TimedCategory);
    const invoke = (name: string, params: any) => tools.mcpTools.find((tool: any) => tool.name === name).handler(params);
    for (let i = 0; i < 16; i++) {
        const response = decode(await invoke(i % 2 ? 'sftp_download' : 'sftp_upload', {
            localPath: i % 2 ? path.join(directory, `download-${i}`) : destination, remotePath: '/file', sync: false,
        }));
        assert.equal(response.async, true);
    }
    await allEntered;
    assert.equal(ready, 16); // All real reads/writes reached the backend barrier before virtual timeout.
    assert.equal(uploads, 8); assert.equal(downloads, 8); assert.equal(stats, 8);
    const before = fs.readdirSync(directory);
    const denied = decode(await invoke('sftp_download', { remotePath: '/denied', localPath: path.join(directory, 'rejected', 'file'), sync: false }));
    assert.equal(denied.code, 'TRANSFER_CAPACITY'); assert.equal(stats, 8); assert.equal(downloads, 8);
    assert.equal(tools.getTransfers().length, 16); assert.deepEqual(fs.readdirSync(directory), before);
    tools.cancelTransferById(tools.getTransfers()[0].id);
    t.mock.timers.tick(20);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tools.getTransfers().filter((task: any) => task.status === 'unknown').length, 8);
    assert.equal(tools.getTransfers().filter((task: any) => task.status === 'failed').length, 8);
    tools.clearCompletedTransfers(); assert.equal(tools.getTransfers().length, 0);
    assert.equal(decode(await invoke('sftp_upload', { localPath: destination, remotePath: '/still-live', sync: false })).code, 'TRANSFER_CAPACITY');
    assert.equal(uploads, 8); assert.equal(tools.activeTransfers, 16);
    // An opaque upload can succeed late; a rejected download backend also frees its slot.
    gates[0].resolve(); gates[1].reject(new Error('backend stopped'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tools.activeTransfers, 14);
    for (const kind of ['sftp_upload', 'sftp_download']) {
        assert.equal(decode(await invoke(kind, { localPath: kind === 'sftp_upload' ? destination : path.join(directory, 'replacement'), remotePath: '/new', sync: false })).async, true);
    }
    assert.equal(tools.activeTransfers, 16);
    assert.equal(decode(await invoke('sftp_upload', { localPath: destination, remotePath: '/full', sync: false })).code, 'TRANSFER_CAPACITY');
});

test('failed transfer preflight releases capacity without inserting history or opening files', async t => {
    const { directory } = fixture(t);
    const tools = category({ stat: async () => { throw new Error('stat failed'); } });
    for (let i = 0; i < 20; i++) {
        for (const name of ['sftp_upload', 'sftp_download']) {
            const result = JSON.parse((await tools.mcpTools.find((tool: any) => tool.name === name).handler({
                localPath: path.join(directory, 'missing'), remotePath: '/file', sync: false,
            })).content[0].text);
            assert.equal(result.success, false); assert.notEqual(result.code, 'TRANSFER_CAPACITY');
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    assert.equal(tools.activeTransfers, 0); assert.equal(tools.getTransfers().length, 0);
    assert.deepEqual(fs.readdirSync(directory), ['existing']);
});

test('missing transfer size settings use 10 GiB defaults while explicit limits remain enforced', async t => {
    const { directory, destination } = fixture(t);
    const overTenMiB = 11 * 1024 * 1024;
    fs.truncateSync(destination, overTenMiB);
    let uploads = 0, downloads = 0, remoteSize = overTenMiB;
    const tools = category({
        stat: async () => ({ size: remoteSize }),
        upload: async () => { uploads++; throw new Error('Upload admitted'); },
        download: async () => { downloads++; throw new Error('Download admitted'); },
    });
    const invoke = async (name: string) => JSON.parse((await tools.mcpTools.find((tool: any) => tool.name === name).handler({
        localPath: destination, remotePath: '/file',
    })).content[0].text);
    // Both a partially populated SFTP config and a missing section occur on upgrades.
    for (const settings of [{ timeout: 10000 }, undefined]) {
        tools.config.store.mcp.sftp = settings;
        assert.match((await invoke('sftp_upload')).error, /Upload admitted/);
        assert.match((await invoke('sftp_download')).error, /Download admitted/);
    }
    assert.equal(uploads, 2); assert.equal(downloads, 2);
    tools.config.store.mcp.sftp = { maxUploadSize: 10 * 1024 * 1024, maxDownloadSize: 10 * 1024 * 1024 };
    assert.match((await invoke('sftp_upload')).error, /File too large/);
    assert.match((await invoke('sftp_download')).error, /File too large/);
    assert.equal(uploads, 2); assert.equal(downloads, 2);
    tools.config.store.mcp.sftp = {};
    remoteSize = 10 * 1024 * 1024 * 1024 + 1;
    assert.match((await invoke('sftp_download')).error, /max: 10737418240/);
    assert.equal(downloads, 2);
    assert.equal(fs.statSync(destination).size, overTenMiB);
    assert.deepEqual(fs.readdirSync(directory), ['existing']);
});
