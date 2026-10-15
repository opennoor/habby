import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { HubError } from '../../../shared/protocol.js';

export async function tabbyExecutable(env = process.env, platform = process.platform): Promise<string> {
  const explicit = env.TABBY_EXECUTABLE;
  if (explicit) {
    if (!isAbsolute(explicit)) throw new HubError('TABBY_NOT_FOUND', 'TABBY_EXECUTABLE must be an absolute path.');
    try { await access(explicit); return explicit; }
    catch { throw new HubError('TABBY_NOT_FOUND', `Tabby executable does not exist: ${explicit}`); }
  }
  const binary = platform === 'win32' ? 'Tabby.exe' : 'tabby';
  const candidates = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, binary)),
    ...(platform === 'linux' ? ['/opt/Tabby/tabby', '/usr/bin/tabby', '/usr/local/bin/tabby'] : []),
    ...(platform === 'darwin' ? ['/Applications/Tabby.app/Contents/MacOS/Tabby', join(homedir(), 'Applications/Tabby.app/Contents/MacOS/Tabby')] : []),
    ...(platform === 'win32' ? [join(env.LOCALAPPDATA ?? '', 'Programs', 'Tabby', 'Tabby.exe'),
      join(env.PROGRAMFILES ?? '', 'Tabby', 'Tabby.exe'), join(env['PROGRAMFILES(X86)'] ?? '', 'Tabby', 'Tabby.exe')] : []),
  ];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try another installation location. */ }
  }
  throw new HubError('TABBY_NOT_FOUND', 'Tabby executable not found. Set TABBY_EXECUTABLE to its absolute path in the Habby service environment.');
}

export async function launchTabby(): Promise<void> {
  const executable = await tabbyExecutable();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
