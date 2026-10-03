import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultStateDir(): string {
  if (process.env.TABBY_HUB_STATE_DIR) return process.env.TABBY_HUB_STATE_DIR;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), 'tabby-hub-mcp');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'tabby-hub-mcp');
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'tabby-hub-mcp');
}
