import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import { privateDirectory } from '../state.js';
import { HubError } from '../../../../shared/protocol.js';

export const secret = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const privateModels = new Set(['AccessToken', 'RefreshToken', 'AuthorizationCode', 'InitialAccessToken',
  'RegistrationAccessToken', 'DeviceCode', 'BackchannelAuthenticationRequest', 'PushedAuthorizationRequest']);

export class AuthStore {
  private nextCleanup = 0;
  cleanup() {
    if (Date.now() < this.nextCleanup) return;
    this.db.prepare(`UPDATE oauth SET expires=(json_extract(payload, '$.client_id_issued_at')+3600)*1000
      WHERE model='Client' AND expires IS NULL AND json_type(payload, '$.client_id_issued_at')='integer'
      AND NOT EXISTS (SELECT 1 FROM grants WHERE client_id=json_extract(payload, '$.client_id') AND revoked=0 AND expires>?)`).run(Date.now());
    this.db.prepare('DELETE FROM oauth WHERE expires IS NOT NULL AND expires<=?').run(Date.now());
    this.db.prepare('DELETE FROM owner_state WHERE expires IS NOT NULL AND expires<=?').run(Date.now());
    this.db.prepare("DELETE FROM owner_state WHERE key LIKE 'challenge:session:%' AND NOT EXISTS (SELECT 1 FROM owner_state AS sessions WHERE sessions.key=substr(owner_state.key,11))").run();
    this.db.prepare('DELETE FROM manual_tokens WHERE expires<=?').run(Date.now());
    this.nextCleanup = Date.now() + 60_000;
  }
  constructor(readonly db: DatabaseSync) {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS oauth (model TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
        expires INTEGER, grant_id TEXT, uid TEXT, user_code TEXT, PRIMARY KEY(model,key));
      CREATE INDEX IF NOT EXISTS oauth_grant ON oauth(grant_id);
      CREATE INDEX IF NOT EXISTS oauth_uid ON oauth(model,uid);
      CREATE TABLE IF NOT EXISTS owner_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER);
      CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, public_key TEXT NOT NULL, counter INTEGER NOT NULL,
        transports TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, scopes TEXT NOT NULL,
        windows TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS manual_tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value,expires FROM owner_state WHERE key=?').get(key) as { value: string; expires: number | null } | undefined;
    if (!row || (row.expires !== null && row.expires <= Date.now())) return undefined;
    return JSON.parse(row.value) as T;
  }
  set(key: string, value: unknown, expires?: number) {
    this.cleanup();
    if (key.startsWith('session:') && !this.get(key)) {
      const count = () => (this.db.prepare("SELECT COUNT(*) AS count FROM owner_state WHERE key LIKE 'session:%'").get() as { count: number }).count;
      if (count() >= 256) {
        this.db.prepare("DELETE FROM owner_state WHERE key IN (SELECT key FROM owner_state WHERE key LIKE 'session:%' AND json_extract(value,'$.owner')=0 AND json_extract(value,'$.enroll')=0 ORDER BY expires,key LIMIT ?)").run(count() - 255);
        this.db.prepare("DELETE FROM owner_state WHERE key LIKE 'challenge:session:%' AND NOT EXISTS (SELECT 1 FROM owner_state AS sessions WHERE sessions.key=substr(owner_state.key,11))").run();
      }
      if (count() >= 256) throw new HubError('RATE_LIMITED', 'Browser session capacity reached. Try again after a session expires.');
    }
    if (key.startsWith('challenge:session:') && !this.get(key.slice(10))) throw new Error('Owner browser session expired. Start again.');
    this.db.prepare('INSERT OR REPLACE INTO owner_state VALUES(?,?,?)').run(key, JSON.stringify(value), expires ?? null);
  }
  take<T>(key: string): T | undefined {
    const value = this.get<T>(key);
    this.db.prepare('DELETE FROM owner_state WHERE key=?').run(key);
    return value;
  }
  adapter(model: string): Adapter {
    const db = this.db; const cleanup = () => this.cleanup();
    const find = async (id: string): Promise<AdapterPayload | undefined> => {
      const row = db.prepare('SELECT payload,expires FROM oauth WHERE model=? AND key=?').get(model, digest(id)) as { payload: string; expires: number | null } | undefined;
      if (!row || (row.expires !== null && row.expires <= Date.now())) return undefined;
      const payload = JSON.parse(row.payload) as AdapterPayload;
      if (privateModels.has(model)) payload.jti = id;
      return payload;
    };
    const findIndex = async (field: 'uid' | 'user_code', value: string) => {
      const row = db.prepare(`SELECT payload,expires FROM oauth WHERE model=? AND ${field}=?`).get(model, value) as { payload: string; expires: number | null } | undefined;
      return row && (row.expires === null || row.expires > Date.now()) ? JSON.parse(row.payload) as AdapterPayload : undefined;
    };
    return {
      find,
      findByUid: uid => findIndex('uid', uid),
      findByUserCode: userCode => findIndex('user_code', userCode),
      async upsert(id, input, expiresIn) {
        cleanup();
        const payload = { ...input };
        if (privateModels.has(model)) delete payload.jti;
        if (model === 'Client' && typeof input.client_id_issued_at === 'number') {
          const count = () => (db.prepare("SELECT COUNT(*) AS count FROM oauth WHERE model='Client'").get() as { count: number }).count;
          if (count() >= 256) db.prepare(`DELETE FROM oauth WHERE model='Client' AND key=(
            SELECT key FROM oauth WHERE model='Client' AND json_type(payload, '$.client_id_issued_at')='integer'
            AND NOT EXISTS (SELECT 1 FROM grants WHERE client_id=json_extract(payload, '$.client_id') AND revoked=0 AND expires>?)
            ORDER BY json_extract(payload, '$.client_id_issued_at'), key LIMIT 1)`).run(Date.now());
          if (count() >= 256) throw new Error('Client registration quota reached by approved or pre-registered clients. Ask the host owner to revoke unused grants.');
        }
        const expires = expiresIn ? Date.now() + expiresIn * 1000 :
          model === 'Client' && typeof input.client_id_issued_at === 'number' ? (input.client_id_issued_at + 3600) * 1000 : null;
        db.prepare('INSERT OR REPLACE INTO oauth VALUES(?,?,?,?,?,?,?)').run(model, digest(id), JSON.stringify(payload),
          expires, input.grantId ?? null, input.uid ?? null, input.userCode ?? null);
      },
      async consume(id) {
        const payload = await find(id);
        if (payload) {
          payload.consumed = Math.floor(Date.now() / 1000);
          if (privateModels.has(model)) delete payload.jti;
          db.prepare('UPDATE oauth SET payload=? WHERE model=? AND key=?').run(JSON.stringify(payload), model, digest(id));
        }
      },
      async destroy(id) { db.prepare('DELETE FROM oauth WHERE model=? AND key=?').run(model, digest(id)); },
      async revokeByGrantId(grantId) { db.prepare('DELETE FROM oauth WHERE grant_id=?').run(grantId); },
    };
  }
  revokeGrant(id: string) {
    this.db.prepare('UPDATE grants SET revoked=1 WHERE id=?').run(id);
    this.db.prepare('DELETE FROM oauth WHERE grant_id=? OR (model=\'Grant\' AND key=?)').run(id, digest(id));
    this.db.prepare('DELETE FROM manual_tokens WHERE grant_id=?').run(id);
  }
  close() { this.db.close(); }
}

export async function openStore(stateDir: string) {
  if (process.platform === 'win32') await privateDirectory(stateDir);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(stateDir);
  if (directory.isSymbolicLink() || !directory.isDirectory() || (process.platform !== 'win32' && ((directory.mode & 0o077) || directory.uid !== process.getuid?.()))) {
    throw new Error('Authentication state directory must be private and must not be a symlink.');
  }
  const path = join(stateDir, 'auth.sqlite');
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.()))) throw new Error('Unsafe authentication database permissions.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Create with private permissions before SQLite can open WAL/journal files.
  try { await writeFile(path, '', { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const store = new AuthStore(new DatabaseSync(path));
  if (process.platform !== 'win32') await chmod(path, 0o600);
  return store;
}
