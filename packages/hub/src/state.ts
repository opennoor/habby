import { chmod, link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { generate } from 'selfsigned';
import { z } from 'zod';
import { defaultStateDir } from '../../../shared/paths.js';
import type { HubConfig, SatelliteTrust } from '../../../shared/protocol.js';

const port = z.number().int().min(1).max(65535);
const configSchema = z.object({ stateDir: z.string(), trustedPort: port, satellitePort: port, publicPort: port,
  publicUrl: z.string().url().optional(), trustedHosts: z.array(z.string().max(253)).max(16).optional() }).strict();
export interface HubState { config: HubConfig; trust: SatelliteTrust; privateKey: string; adminCredential: string }

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('State directory must be a real directory.');
  if (process.getuid && stat.uid !== process.getuid()) throw new Error('State directory must belong to the current user.');
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'
      $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl=New-Object System.Security.AccessControl.DirectorySecurity
      $acl.SetOwner($sid)
      $acl.SetAccessRuleProtection($true,$false)
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $env:TABBY_HUB_PRIVATE_STATE_DIR -AclObject $acl
      foreach($name in @('config.json','satellite.json','secrets.json','auth.sqlite','auth.sqlite-wal','auth.sqlite-shm')) {
        $file=Join-Path $env:TABBY_HUB_PRIVATE_STATE_DIR $name
        if(Test-Path -LiteralPath $file) {
          $item=Get-Item -Force -LiteralPath $file
          if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'State files must be regular files, not links.' }
          $fileAcl=New-Object System.Security.AccessControl.FileSecurity
          $fileAcl.SetOwner($sid)
          $fileAcl.SetAccessRuleProtection($true,$false)
          $fileAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
          Set-Acl -LiteralPath $file -AclObject $fileAcl
        }
      }`;
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, env: { ...process.env, TABBY_HUB_PRIVATE_STATE_DIR: path } });
  } else await chmod(path, 0o700);
}
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}
export async function readConfig(stateDir = defaultStateDir()): Promise<HubConfig> {
  stateDir = resolve(stateDir);
  const config = configSchema.parse(JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8')));
  if (resolve(config.stateDir) !== stateDir) throw new Error('Configuration state directory mismatch.');
  validatePublicUrl(config.publicUrl);
  return config;
}
export function validatePublicUrl(value?: string): void {
  if (!value) return;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    !url.pathname.endsWith('/mcp') || /%|\/\//.test(url.pathname))
    throw new Error('Public URL must be HTTPS and end in /mcp, without credentials, query, fragment, or encoded path.');
}
export async function initializeState(stateDir = defaultStateDir(), overrides: Partial<HubConfig> = {}): Promise<HubState> {
  stateDir = resolve(stateDir);
  await privateDirectory(stateDir);
  let config: HubConfig;
  try { config = await readConfig(stateDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    config = { stateDir, trustedPort: 3001, satellitePort: 3002, publicPort: 3003 };
  }
  config = configSchema.parse({ ...config, ...overrides, stateDir });
  validatePublicUrl(config.publicUrl);
  if (new Set([config.trustedPort, config.satellitePort, config.publicPort]).size !== 3)
    throw new Error('Each trust boundary requires a different port.');
  await writePrivateJson(join(stateDir, 'config.json'), config);
  const secretsPath = join(stateDir, 'secrets.json');
  let secrets: { privateKey: string; adminCredential: string; certificate: string; credential: string };
  try {
    const stat = await lstat(secretsPath);
    if (stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077)))
      throw new Error('Secret file must be private and not a symlink.');
    secrets = z.object({ privateKey: z.string().min(100), adminCredential: z.string().min(40),
      certificate: z.string().min(100), credential: z.string().min(40) }).strict().parse(JSON.parse(await readFile(secretsPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const pems = await generate([{ name: 'commonName', value: 'Tabby Hub local satellite listener' }], {
      keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + 10 * 365 * 86400000), extensions: [
        // Electron's BoringSSL requires a CA trust anchor; clients also pin this exact SPKI.
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', digitalSignature: true, keyCertSign: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }] },
      ],
    });
    secrets = { privateKey: pems.private, certificate: pems.cert,
      credential: randomBytes(32).toString('base64url'), adminCredential: randomBytes(32).toString('base64url') };
    const temporary = `${secretsPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
    try { await link(temporary, secretsPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
    } finally { await unlink(temporary); }
  }
  const certificate = new X509Certificate(secrets.certificate);
  const spkiPin = 'sha256/' + createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const trust: SatelliteTrust = { url: `wss://127.0.0.1:${config.satellitePort}/satellite`,
    certificate: secrets.certificate, spkiPin, credential: secrets.credential };
  await writePrivateJson(join(stateDir, 'satellite.json'), trust);
  return { config, trust, privateKey: secrets.privateKey, adminCredential: secrets.adminCredential };
}
