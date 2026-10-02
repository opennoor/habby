import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile, cp, rename, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HubConfig } from '../../../shared/protocol.js';
import { PRIVATE_STATE_FILES, privateDirectory, writePrivateFile, writePrivateJson } from './state.js';

type Platform = 'linux' | 'darwin' | 'win32';
type Exec = (file: string, args: string[]) => Promise<unknown>;
const execute: Exec = (file, args) => promisify(execFile)(file, args, { windowsHide: true, timeout: 30000 });
const PLUGIN = 'tabby-hub-satellite';
const SERVICE = 'tabby-hub';
const exists = async (p: string) => { try { await access(p); return true; } catch { return false; } };
const xml = (s: string) => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const systemdQuote = (s: string) => '"' + s.replaceAll('%', '%%').replaceAll('$', () => '$$').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
const windowsQuote = (s: string) => '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';

export interface InstallOptions {
  config: HubConfig; executable?: string; entrypoint?: string; pluginDir?: string; start?: boolean;
  /** Overrides let tests operate only in a temporary directory. */
  platform?: Platform; home?: string; env?: NodeJS.ProcessEnv; exec?: Exec; pluginSource?: string;
}
export function defaultPluginDir(platform = process.platform, home = homedir(), env = process.env): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'tabby', 'plugins');
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'tabby', 'plugins');
  if (platform === 'linux') return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'tabby', 'plugins');
  throw new Error(`Unsupported platform: ${platform}`);
}
export function renderSupervisor(platform: Platform, executable: string, entrypoint: string, stateDir: string): string {
  const args = [entrypoint, 'start', '--state-dir', stateDir];
  if ([executable, ...args].some(s => /[\r\n\0]/.test(s))) throw new Error('Service paths cannot contain line breaks or NUL.');
  if (platform === 'linux') return `[Unit]\nDescription=Tabby Hub MCP\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${[executable, ...args].map(systemdQuote).join(' ')}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  if (platform === 'darwin') return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.tabby-hub.mcp</string><key>ProgramArguments</key><array>${[executable, ...args].map(s => `<string>${xml(s)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>Umask</key><integer>63</integer><key>StandardErrorPath</key><string>${xml(path.join(stateDir, 'hub.stderr.log'))}</string></dict></plist>\n`;
  return `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${xml(executable)}</Command><Arguments>${xml(args.map(windowsQuote).join(' '))}</Arguments></Exec></Actions></Task>\n`;
}
function servicePath(platform: Platform, home: string, stateDir: string, env: NodeJS.ProcessEnv): string {
  return platform === 'linux' ? path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'systemd', 'user', `${SERVICE}.service`)
    : platform === 'darwin' ? path.join(home, 'Library', 'LaunchAgents', 'com.tabby-hub.mcp.plist') : path.join(stateDir, 'task.xml');
}
const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
function taskName(env: NodeJS.ProcessEnv): string { return `TabbyHubMCP-${(env.USERNAME ?? 'user').replace(/[^\w.-]/g, '_')}`; }
async function pluginSource(): Promise<string> {
  for (const relative of ['../../../../packages/satellite', '../../../satellite', '../../satellite']) {
    const candidate = fileURLToPath(new URL(relative, import.meta.url));
    if (await exists(path.join(candidate, 'dist', 'index.js'))) return candidate;
  }
  throw new Error('Compiled satellite missing. Build with pnpm build, or use a complete release archive.');
}
async function ensureOwnedPlugin(destination: string): Promise<void> {
  if (!await exists(destination)) return;
  if ((await lstat(destination)).isSymbolicLink()) throw new Error('Refusing to replace a symlinked plugin directory.');
  const manifest = JSON.parse(await readFile(path.join(destination, 'package.json'), 'utf8'));
  if (manifest.name !== PLUGIN) throw new Error('Refusing to replace a different plugin.');
}
export async function installHub(options: InstallOptions): Promise<{ pluginDir: string; servicePath: string; supervisor: Platform; started: boolean }> {
  const { config } = options;
  const platform = options.platform ?? process.platform as Platform;
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  const home = options.home ?? homedir(), env = options.env ?? process.env, exec = options.exec ?? execute;
  const source = options.pluginSource ?? await pluginSource();
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (manifest.name !== PLUGIN) throw new Error('Unexpected satellite package.');
  await access(path.join(source, 'dist', 'index.js'));
  await privateDirectory(config.stateDir);
  await access(path.join(config.stateDir, 'satellite.json'));
  const pluginDir = path.resolve(options.pluginDir ?? defaultPluginDir(platform, home, env));
  const destination = path.join(pluginDir, 'node_modules', PLUGIN);
  await ensureOwnedPlugin(destination);
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = `${destination}.staging-${process.pid}`, backup = `${destination}.backup-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  try {
    await cp(path.join(source, 'dist'), path.join(staging, 'dist'), { recursive: true, dereference: true });
    await cp(path.join(source, 'package.json'), path.join(staging, 'package.json'));
    // The plugin reads this path, never a secret copied into the plugin tree.
    await writeFile(path.join(staging, 'hub-state.json'), JSON.stringify({ stateDir: config.stateDir }), { mode: 0o600 });
    if (await exists(destination)) await rename(destination, backup);
    try { await rename(staging, destination); } catch (error) { if (await exists(backup)) await rename(backup, destination); throw error; }
    await rm(backup, { recursive: true, force: true });
  } finally { await rm(staging, { recursive: true, force: true }); }
  await writePrivateJson(path.join(config.stateDir, 'installation.json'), { pluginDir });
  const target = servicePath(platform, home, config.stateDir, env);
  await mkdir(path.dirname(target), { recursive: true });
  const content = renderSupervisor(platform, options.executable ?? process.execPath, options.entrypoint ?? fileURLToPath(new URL('./cli.js', import.meta.url)), config.stateDir);
  await writePrivateFile(target, platform === 'win32' ? Buffer.from('\uFEFF' + content, 'utf16le') : content);
  const start = options.start !== false;
  if (platform === 'linux') {
    await exec('systemctl', ['--user', 'daemon-reload']);
    await exec('systemctl', ['--user', 'enable', `${SERVICE}.service`]);
    if (start) await exec('systemctl', ['--user', 'restart', `${SERVICE}.service`]);
  } else if (platform === 'darwin') {
    const domain = `gui/${process.getuid!()}`;
    // Replacing an existing definition requires unloading it first.
    try { await exec('launchctl', ['bootout', `${domain}/com.tabby-hub.mcp`]); } catch { /* not previously loaded */ }
    if (start) await exec('launchctl', ['bootstrap', domain, target]);
  } else {
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $existing=Get-ScheduledTask -TaskName ${psQuote(taskName(env))} -ErrorAction SilentlyContinue; if ($existing) { $existing | Stop-ScheduledTask }; Register-ScheduledTask -TaskName ${psQuote(taskName(env))} -Xml (Get-Content -Raw -LiteralPath ${psQuote(target)}) -User ($env:USERDOMAIN+'\\'+$env:USERNAME) -Force | Out-Null`]);
    if (start) await exec('schtasks.exe', ['/Run', '/TN', taskName(env)]);
  }
  return { pluginDir, servicePath: target, supervisor: platform, started: start };
}
export async function uninstallHub(config: HubConfig, options: Omit<InstallOptions, 'config'> & { purge?: boolean } = {}): Promise<{ removed: string[]; statePurged: boolean }> {
  const platform = options.platform ?? process.platform as Platform, home = options.home ?? homedir(), env = options.env ?? process.env, exec = options.exec ?? execute;
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  let recordedPluginDir: string | undefined;
  try {
    const record = JSON.parse(await readFile(path.join(config.stateDir, 'installation.json'), 'utf8'));
    if (typeof record.pluginDir !== 'string' || !path.isAbsolute(record.pluginDir)) throw new Error('Invalid recorded plugin directory.');
    recordedPluginDir = record.pluginDir;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const destination = path.join(options.pluginDir ?? recordedPluginDir ?? defaultPluginDir(platform, home, env), 'node_modules', PLUGIN);
  await ensureOwnedPlugin(destination);
  const resolvedState = path.resolve(config.stateDir);
  if (options.purge && (resolvedState === path.parse(resolvedState).root || resolvedState === path.resolve(home))) throw new Error('Refusing to purge a root or home directory.');
  const target = servicePath(platform, home, config.stateDir, env);
  if (await exists(target)) {
    if (platform === 'linux') await exec('systemctl', ['--user', 'disable', '--now', `${SERVICE}.service`]);
    else if (platform === 'darwin') { try { await exec('launchctl', ['bootout', `gui/${process.getuid!()}/com.tabby-hub.mcp`]); } catch { /* already stopped */ } }
    else await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $task=Get-ScheduledTask -TaskName ${psQuote(taskName(env))} -ErrorAction SilentlyContinue; if ($task) { $task | Stop-ScheduledTask; $task | Unregister-ScheduledTask -Confirm:$false }`]);
    await rm(target);
    if (platform === 'linux') await exec('systemctl', ['--user', 'daemon-reload']);
  }
  await rm(destination, { recursive: true, force: true });
  await rm(path.join(config.stateDir, 'installation.json'), { force: true });
  if (options.purge) {
    await rm(resolvedState, { recursive: true, force: true });
  }
  return { removed: [target, destination], statePurged: options.purge === true };
}
export async function doctor(config: HubConfig): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const checks = [{ name: 'runtime', ok: major > 24 || (major === 24 && (minor > 21 || (minor === 21 && patch >= 0))), detail: process.versions.node }];
  const entries = [
    { name: 'state-directory', p: config.stateDir, directory: true },
    ...PRIVATE_STATE_FILES.map(file => ({ ...file, p: path.join(config.stateDir, file.name) })),
  ];
  let privatePaths: Record<string, boolean> = {};
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $result=@{}
      foreach($path in (ConvertFrom-Json $env:TABBY_HUB_DOCTOR_PATHS)) {
        $ok=$false
        try {
          $item=Get-Item -Force -LiteralPath $path
          if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Links are not private state.' }
          $acl=$item.GetAccessControl([Security.AccessControl.AccessControlSections]'Access,Owner')
          $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
          $ok=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and $rules.Count -gt 0
          foreach($rule in $rules) { if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) { $ok=$false } }
        } catch { $ok=$false }
        $result[$path]=$ok
      }; ConvertTo-Json -Compress -InputObject $result`;
    try {
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 30000, env: { ...process.env, TABBY_HUB_DOCTOR_PATHS: JSON.stringify(entries.map(entry => entry.p)) } });
      privatePaths = JSON.parse(result.stdout);
    } catch { /* A failed ACL inspection cannot establish privacy. */ }
  }
  for (const entry of entries) {
    const { name, p } = entry;
    try {
      const stat = await lstat(p);
      const privateFile = process.platform === 'win32' ? privatePaths[p] === true : (stat.mode & 0o077) === 0 && stat.uid === process.getuid!();
      const expectedType = 'directory' in entry && entry.directory ? stat.isDirectory() : stat.isFile();
      checks.push({ name, ok: expectedType && !stat.isSymbolicLink() && privateFile, detail: privateFile ? p : `Permissions must be private: ${p}` });
    } catch (error) {
      if (!('optional' in entry && entry.optional && (error as NodeJS.ErrnoException).code === 'ENOENT')) checks.push({ name, ok: false, detail: `Missing or unreadable: ${p}` });
    }
  }
  try {
    const response = await fetch(`http://127.0.0.1:${config.trustedPort}/health`, { signal: AbortSignal.timeout(2000) });
    const body = await response.json() as { name?: string; alive?: boolean };
    const healthy = response.ok && body.name === 'Tabby Hub' && body.alive === true;
    checks.push({ name: 'hub', ok: healthy, detail: healthy ? 'Trusted listener healthy' : `Unexpected health response on port ${config.trustedPort} (HTTP ${response.status}).` });
  } catch { checks.push({ name: 'hub', ok: false, detail: 'Trusted listener unreachable; check supervisor status.' }); }
  return checks;
}
