import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultStateDir(): string {
  if (process.env.HABBY_STATE_DIR) return process.env.HABBY_STATE_DIR;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), 'habby');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'habby');
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'habby');
}
