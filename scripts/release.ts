import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, writeFile, access, rm, chmod, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const NODE_VERSION = '24.21.0';
// Reviewed against Node's official HTTPS SHASUMS256.txt. A changed manifest cannot silently change the runtime.
const runtimes: Record<string, string> = {
  'linux-x64': '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
  'linux-arm64': '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
  'darwin-x64': '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
  'darwin-arm64': 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
  'win-x64': '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
  'win-arm64': '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921',
};
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function download(url: string): Promise<Buffer> {
  const result = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!result.ok) throw new Error(`Download failed: ${url} (${result.status})`);
  return Buffer.from(await result.arrayBuffer());
}
async function assertNoSymlinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.name === '.bin') { await rm(filename, { recursive: true, force: true }); continue; }
    if (entry.isSymbolicLink()) throw new Error(`Release dependency symlink requires nonportable privileges: ${filename}`);
    if (entry.isDirectory()) await assertNoSymlinks(filename);
  }
}
async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const selected = process.argv.slice(2);
  const targets = selected.length ? selected : Object.keys(runtimes);
  if (targets.some(target => !(target in runtimes))) throw new Error(`Targets: ${Object.keys(runtimes).join(', ')}`);
  await access(path.join(root, 'dist/packages/hub/src/cli.js'));
  await access(path.join(root, 'packages/satellite/dist/index.js'));
  const output = path.join(root, 'dist', 'releases'); await mkdir(output, { recursive: true });
  const staging = await mkdtemp(path.join(os.tmpdir(), 'habby-release-'));
  try {
    const application = path.join(staging, 'application'); await mkdir(application, { recursive: true });
    // Native hoisting preserves shared module identity (ASN decorator registries break if copied per edge).
    // Install only in isolated staging; the frozen lock avoids dependency drift.
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await cp(path.join(root, file), path.join(application, file));
    // PNPM's hoisted linker otherwise includes the absent satellite importer's host-only peers.
    const lockfile = path.join(application, 'pnpm-lock.yaml');
    const lock = await readFile(lockfile, 'utf8');
    await writeFile(lockfile, lock.replace(/^  packages\/satellite:\r?\n(?: {4}.*\r?\n|\r?\n)*/m, ''));
    // The satellite is already bundled; its host-supplied Tabby/Angular peers are not daemon dependencies.
    // Invoke the current pnpm JS entrypoint: execFile cannot launch Windows .cmd shims.
    const pnpm = process.env.npm_execpath;
    await execute(pnpm ? process.execPath : 'pnpm', [...(pnpm ? [pnpm] : []), '--dir', application, '--filter', manifest.name, '--config.node-linker=hoisted', 'install', '--prod', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'], { env: { ...process.env, CI: 'true' }, maxBuffer: 4 * 1024 * 1024 });
    await rm(path.join(application, 'node_modules/.bin'), { recursive: true, force: true });
    // The release supplies its separately verified Node runtime rather than pnpm's development runtime.
    await rm(path.join(application, 'node_modules/node'), { recursive: true, force: true });
    await assertNoSymlinks(path.join(application, 'node_modules'));
    for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) await rm(path.join(application, file));
    await cp(path.join(root, 'dist'), path.join(application, 'dist'), { recursive: true, filter: p => !path.relative(path.join(root, 'dist'), p).split(path.sep).includes('releases') });
    for (const file of ['package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(path.join(root, file), path.join(application, file));
    await mkdir(path.join(application, 'packages/satellite'), { recursive: true });
    for (const file of ['dist', 'package.json']) await cp(path.join(root, 'packages/satellite', file), path.join(application, 'packages/satellite', file), { recursive: true });
    const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
    const officialChecksums = (await download(`${base}/SHASUMS256.txt`)).toString();
    const sums: string[] = [];
    for (const target of targets) {
      const extension = target.startsWith('win-') ? 'zip' : 'tar.gz';
      const runtimeName = `node-v${NODE_VERSION}-${target}`, filename = `${runtimeName}.${extension}`;
      const official = officialChecksums.split('\n').find(line => line.trim().endsWith(`  ${filename}`))?.split(/\s+/)[0];
      if (official !== runtimes[target]) throw new Error(`Pinned runtime checksum mismatch: ${filename}`);
      const archive = await download(`${base}/${filename}`);
      if (sha(archive) !== official) throw new Error(`Corrupt runtime download: ${filename}`);
      const archivePath = path.join(staging, filename); await writeFile(archivePath, archive);
      if (extension === 'zip' && process.platform !== 'win32') await execute('unzip', ['-q', archivePath, '-d', staging]);
      else await execute('tar', ['-xf', archivePath, '-C', staging]);
      const bundleName = `habby-${manifest.version}-${target}`, bundle = path.join(staging, bundleName);
      await cp(application, bundle, { recursive: true }); await mkdir(path.join(bundle, 'runtime/bin'), { recursive: true });
      const binary = target.startsWith('win-') ? 'node.exe' : 'bin/node';
      await cp(path.join(staging, runtimeName, binary), path.join(bundle, 'runtime', binary));
      await cp(path.join(staging, runtimeName, 'LICENSE'), path.join(bundle, 'runtime/LICENSE'));
      await writeFile(path.join(bundle, 'runtime/verification.json'), JSON.stringify({ version: NODE_VERSION, archive: filename, sha256: official, source: `${base}/${filename}` }, null, 2));
      await mkdir(path.join(bundle, 'bin'));
      await writeFile(path.join(bundle, 'bin/habby'), '#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$base/runtime/bin/node" "$base/dist/packages/hub/src/cli.js" "$@"\n');
      await chmod(path.join(bundle, 'bin/habby'), 0o755);
      await writeFile(path.join(bundle, 'bin/habby.cmd'), '@echo off\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\dist\\packages\\hub\\src\\cli.js" %*\r\n');
      const releasePath = path.join(output, `${bundleName}.tar.gz`);
      await execute('tar', ['-czf', releasePath, '-C', staging, bundleName]);
      sums.push(`${sha(await readFile(releasePath))}  ${path.basename(releasePath)}`);
      console.log(`Created ${path.basename(releasePath)}`);
      await rm(bundle, { recursive: true, force: true }); await rm(path.join(staging, runtimeName), { recursive: true, force: true });
    }
    await writeFile(path.join(output, 'SHA256SUMS'), sums.join('\n') + '\n');
    for (const file of ['install.sh', 'install.ps1']) await cp(path.join(root, 'scripts', file), path.join(output, file));
  } finally { await rm(staging, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
