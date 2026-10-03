/** Native packaged acceptance. Refuses an existing current-user Hub task. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { initializeState } from '../packages/hub/src/state.js';

assert.equal(process.platform, 'win32', 'Run on native Windows.');
const execute = promisify(execFile);
const releaseDir = resolve(process.argv[2] ?? 'dist/releases');
const taskName = `TabbyHubMCP-${(process.env.USERNAME ?? 'user').replace(/[^\w.-]/g, '_')}`;
const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const ps = (script: string, env = process.env) => execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand',
  Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules'); ${script}; exit 0`, 'utf16le').toString('base64')],
  { env, windowsHide: true, timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
const scheduler = `$s=New-Object -ComObject Schedule.Service; $s.Connect(); $folder=$s.GetFolder('\\');`;
await ps(`${scheduler} try { $null=$folder.GetTask(${psQuote(taskName)}); throw 'Existing Hub task; refusing acceptance.' }
  catch { if($_.Exception.GetBaseException().HResult -ne -2147024894) { throw } }`);
const root = await mkdtemp(join(tmpdir(), 'tabby-package-'));
const local = join(root, 'local space & café'), stateDir = join(local, 'state'), pluginDir = join(local, 'plugins');
const env = { ...process.env, LOCALAPPDATA: local, TABBY_HUB_STATE_DIR: stateDir,
  PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot};${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0` };
let taskOwned = false;
let client: Client | undefined;
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function waitFor<T>(check: () => Promise<T>, label: string, timeout = 300000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check(); if (result) return result as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${label}`);
}
const bundleName = 'tabby-hub-1.0.0-win-x64';
const bundle = join(local, 'TabbyHub', 'versions', '1.0.0-win-x64');
let runtime = join(bundle, 'runtime', 'node.exe'), cli = join(bundle, 'dist', 'packages', 'hub', 'src', 'cli.js');
const run = (...args: string[]) => execute(runtime, [cli, ...args, '--state-dir', stateDir], { env, windowsHide: true, timeout: 120000 });
try {
  await mkdir(local, { recursive: true });
  const state = await initializeState(stateDir, { trustedPort: await freePort(), satellitePort: await freePort(), publicPort: await freePort(),
    publicUrl: 'https://windows-acceptance.example.invalid/mcp' });
  const secrets = await readFile(join(stateDir, 'secrets.json'), 'utf8');
  await mkdir(join(pluginDir, 'node_modules', 'unrelated'), { recursive: true });
  await writeFile(join(pluginDir, 'node_modules', 'unrelated', 'keep'), 'retain');
  const installer = resolve('scripts/install.ps1');
  const install = (directory: string) => ps(`& ${psQuote(installer)} -Version 1.0.0 -ArchiveDir ${psQuote(directory)} -PluginDir ${psQuote(pluginDir)}`, env);
  const bad = join(root, 'bad-checksum'); await mkdir(bad);
  await cp(join(releaseDir, `${bundleName}.tar.gz`), join(bad, `${bundleName}.tar.gz`));
  await writeFile(join(bad, 'SHA256SUMS'), `${'0'.repeat(64)}  ${bundleName}.tar.gz\n`);
  await assert.rejects(install(bad), /Release checksum mismatch/);
  await assert.rejects(access(bundle));
  console.log('PASS: packaged installer rejects a bad checksum before installing.');
  taskOwned = true; // Registration may succeed even if the later start fails.
  await install(releaseDir);
  assert.equal((await execute(runtime, ['--version'], { env })).stdout.trim(), 'v24.21.0');
  const health = () => fetch(`http://127.0.0.1:${state.config.trustedPort}/health`, { signal: AbortSignal.timeout(2000) })
    .then(response => response.ok).catch(() => false);
  await waitFor(health, 'scheduled daemon startup');
  await assert.rejects(install(releaseDir), /Version already exists/);
  assert.ok(JSON.parse((await run('doctor')).stdout).every((check: any) => check.ok));
  client = new Client({ name: 'windows-package-acceptance', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${state.config.trustedPort}/mcp`)));
  assert.equal((await client.listTools()).tools.length, 38);
  const windows = await client.callTool({ name: 'list_windows', arguments: {} });
  assert.deepEqual(JSON.parse((windows.content as Array<{ text: string }>)[0].text).windows, []);
  assert.equal((await fetch(`http://127.0.0.1:${state.config.publicPort}/mcp`)).status, 401);
  await client.close(); client = undefined;
  console.log('PASS: independent bundled runtime, doctor, 38 MCP tools, zero windows and public authentication.');
  const originalPid = JSON.parse((await run('status')).stdout).pid;
  process.kill(originalPid); // Actual crash; Task Scheduler must restart after its one-minute interval.
  await waitFor(health, 'Task Scheduler crash recovery');
  assert.notEqual(JSON.parse((await run('status')).stdout).pid, originalPid);
  console.log('PASS: Task Scheduler restarts a crashed daemon.');
  const replacement = join(local, 'replacement bundle'); await cp(bundle, replacement, { recursive: true });
  runtime = join(replacement, 'runtime', 'node.exe'); cli = join(replacement, 'dist', 'packages', 'hub', 'src', 'cli.js');
  await run('install', '--plugin-dir', pluginDir);
  await waitFor(health, 'upgraded daemon');
  const registered = await ps(`${scheduler} $folder.GetTask(${psQuote(taskName)}).Definition.Actions.Item(1).Path`, env);
  assert.equal(registered.stdout.trim().toLowerCase(), runtime.toLowerCase());
  assert.equal(await readFile(join(stateDir, 'secrets.json'), 'utf8'), secrets);
  console.log('PASS: upgrade replaces the absolute runtime path and retains identity.');
  await run('uninstall'); taskOwned = false;
  await waitFor(async () => !await health(), 'daemon shutdown');
  assert.equal(await readFile(join(stateDir, 'secrets.json'), 'utf8'), secrets);
  await access(join(pluginDir, 'node_modules', 'unrelated', 'keep'));
  await assert.rejects(access(join(pluginDir, 'node_modules', 'tabby-hub-satellite')));
  await run('uninstall');
  taskOwned = true; await run('install', '--no-start', '--plugin-dir', pluginDir);
  assert.equal(await health(), false);
  // Cross a recovery interval: deferred installation must not arm immediate repeats.
  await new Promise(resolve => setTimeout(resolve, 65000));
  assert.equal(await health(), false);
  await run('uninstall', '--purge'); taskOwned = false;
  await assert.rejects(access(stateDir));
  console.log('PASS: uninstall stops the daemon, retains state/unrelated plugins, absent-task uninstall, no-start reinstall and purge.');
} catch (error) {
  console.error(error);
  if (taskOwned) console.error((await ps(`${scheduler} $task=$folder.GetTask(${psQuote(taskName)});
    ConvertTo-Json -Compress -InputObject @{state=$task.State; result=$task.LastTaskResult; action=$task.Definition.Actions.Item(1).Path; arguments=$task.Definition.Actions.Item(1).Arguments}`).catch(() => ({ stdout: 'No acceptance task available for diagnostics.' }))).stdout);
  throw error;
} finally {
  await client?.close();
  if (taskOwned) await ps(`${scheduler} $task=$null;
    try { $task=$folder.GetTask(${psQuote(taskName)}) }
    catch { if($_.Exception.GetBaseException().HResult -ne -2147024894) { throw } }
    if($task) { $task.Stop(0); $deadline=[DateTime]::UtcNow.AddSeconds(10);
      while($task.GetInstances(0).Count -gt 0) {
        if([DateTime]::UtcNow -ge $deadline) { throw 'Acceptance task did not stop; fixture retained.' }
        Start-Sleep -Milliseconds 100
      }; $folder.DeleteTask(${psQuote(taskName)},0)
    }`);
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
