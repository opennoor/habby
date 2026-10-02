import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TOOL_BY_NAME, authorize } from '../../../shared/catalog.js';
import { HubError, MAX_REQUEST_TIMEOUT_MS, globalId, parseGlobalId, snapshotSchema, type Principal, type Registration,
  type Snapshot, type WireMessage } from '../../../shared/protocol.js';

interface WindowEntry {
  id: string; metadata: Record<string, unknown>; capabilities: string[]; snapshot: Snapshot;
  epoch: string; resumeToken: string; lastSeen: number; online: boolean; revision: number;
  sequence: number; send: (message: WireMessage) => void;
}
interface Pending {
  windowId: string; epoch: string; mutation: boolean;
  resolve: (result: unknown) => void; reject: (error: Error) => void; cleanup: () => void;
}
const targetKinds = { tabId: 'tabs', sessionId: 'sessions', profileId: 'profiles', transferId: 'transfers' } as const;

export class WindowRegistry extends EventEmitter {
  private windows = new Map<string, WindowEntry>();
  private pending = new Map<string, Pending>();
  private timer = setInterval(() => {
    const now = Date.now();
    for (const window of this.windows.values()) {
      if (window.online && now - window.lastSeen > 30000) this.disconnect(window.id, window.epoch);
      if (!window.online && now - window.lastSeen > 600000) this.windows.delete(window.id);
    }
  }, 10000).unref();

  register(registration: Registration, send: (message: WireMessage) => void): { epoch: string; resumeToken: string } {
    const existing = this.windows.get(registration.windowId);
    if (existing?.online) throw new HubError('DUPLICATE_WINDOW', 'This window already has a live satellite.');
    if (existing && !equalSecret(registration.resumeToken ?? '', existing.resumeToken))
      throw new HubError('INVALID_RESUME', 'A reconnect must resume the same window incarnation.');
    if (!existing && this.windows.size >= 256) throw new HubError('LIMIT_REACHED', 'Window registry is full.');
    if (!registration.capabilities.every(name => TOOL_BY_NAME.has(name)))
      throw new HubError('INVALID_CAPABILITY', 'Satellite advertised an unknown operation.');
    validateSnapshot(registration.snapshot);
    const window: WindowEntry = { id: registration.windowId, metadata: registration.metadata,
      capabilities: registration.capabilities, snapshot: registration.snapshot, epoch: randomUUID(),
      resumeToken: existing?.resumeToken ?? registration.resumeToken ?? randomBytes(32).toString('base64url'), lastSeen: Date.now(), online: true,
      revision: (existing?.revision ?? 0) + 1, sequence: 0, send };
    this.windows.set(window.id, window);
    this.emit('topology', window.id);
    return { epoch: window.epoch, resumeToken: window.resumeToken };
  }

  receive(windowId: string, epoch: string, message: WireMessage): void {
    const window = this.windows.get(windowId);
    if (!window?.online || window.epoch !== epoch) return;
    if (!('windowId' in message) || message.windowId !== windowId || !('epoch' in message) || message.epoch !== epoch)
      throw new HubError('INVALID_WINDOW', 'Message does not belong to the bound window and epoch.');
    window.lastSeen = Date.now();
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending || pending.windowId !== windowId || pending.epoch !== epoch) return;
      this.pending.delete(message.id); pending.cleanup();
      if (message.error) pending.reject(new HubError(message.error.code, message.error.message));
      else pending.resolve(this.namespace(message.result, window));
    } else if (message.type === 'event') {
      if (message.sequence <= window.sequence) return;
      const gap = message.sequence !== window.sequence + 1;
      window.sequence = message.sequence;
      if (message.event === 'snapshot') {
        const snapshot = snapshotSchema.parse(message.data); validateSnapshot(snapshot);
        window.snapshot = snapshot; window.revision++;
        this.emit('topology', windowId);
      } else if (gap) window.send({ type: 'resnapshot', windowId, epoch });
      this.emit(message.event, windowId, message.data);
    } else if (message.type !== 'heartbeat') {
      throw new HubError('INVALID_MESSAGE', 'Unexpected satellite message.');
    }
  }

  disconnect(windowId: string, epoch: string): void {
    const window = this.windows.get(windowId);
    if (!window?.online || window.epoch !== epoch) return;
    window.online = false; window.lastSeen = Date.now();
    for (const [id, pending] of this.pending) if (pending.windowId === windowId && pending.epoch === epoch) {
      this.pending.delete(id); pending.cleanup();
      pending.reject(new HubError(pending.mutation ? 'OUTCOME_UNKNOWN' : 'WINDOW_OFFLINE',
        `${pending.mutation ? 'Operation may already have happened. Inspect the target; do not automatically retry.' : 'Window disconnected.'} Request: ${id}`));
    }
    this.emit('offline', windowId); this.emit('topology', windowId);
  }

  list(principal: Principal, windowId?: string): unknown[] {
    authorize(principal, 'list_windows');
    return [...this.windows.values()].filter(window => (!windowId || window.id === windowId) &&
      (!principal.windows || principal.windows.includes(window.id))).map(window => ({
      ...window.metadata, windowId: window.id, online: window.online, epoch: window.epoch,
      revision: window.revision, capabilities: window.capabilities,
      ...this.namespace({ ...window.snapshot,
        transfers: principal.scopes.includes('files:read') ? window.snapshot.transfers : [],
      }, window) as object,
    }));
  }

  async call(operation: string, input: Record<string, unknown>, principal: Principal, signal?: AbortSignal): Promise<unknown> {
    const definition = TOOL_BY_NAME.get(operation);
    if (!definition) throw new HubError('UNKNOWN_TOOL', 'Unknown operation.');
    const params = definition.schema.parse(input) as Record<string, unknown>;
    authorize(principal, operation, params, params.windowId as string | undefined);
    if (operation === 'list_windows') return textResult({ windows: this.list(principal, params.windowId as string | undefined) });
    let resolvedId = params.windowId as string | undefined;
    for (const [key, kind] of Object.entries(targetKinds)) {
      if (params[key] === undefined) continue;
      const target = parseGlobalId(String(params[key]));
      authorize(principal, operation, params, target.windowId);
      if (resolvedId && resolvedId !== target.windowId) throw new HubError('INVALID_TARGET', 'Targets belong to different windows.');
      resolvedId = target.windowId;
      const owner = this.windows.get(resolvedId);
      if (!owner?.snapshot[kind as keyof Snapshot].some(entity => entity.id === target.localId))
        throw new HubError('TARGET_NOT_FOUND', 'Exact target no longer exists.');
      params[key] = target.localId;
    }
    delete params.windowId;
    const permitted = [...this.windows.values()].filter(window => window.online &&
      (!principal.windows || principal.windows.includes(window.id)));
    if (!resolvedId && definition.aggregate) {
      const results = await Promise.all(permitted.map(async window => {
        try { return { windowId: window.id, result: decodeResult(await this.invoke(window, operation, params, principal, signal)) }; }
        catch (error) { return { windowId: window.id, error: {
          code: error instanceof HubError ? error.code : 'OPERATION_FAILED',
          message: error instanceof Error ? error.message : 'Window operation failed.',
        } }; }
      }));
      return textResult({ windows: results });
    }
    if (!resolvedId) {
      if (!permitted.length) throw new HubError('NO_WINDOWS', 'No connected Tabby windows.');
      if (permitted.length !== 1) throw new HubError('AMBIGUOUS_TARGET',
        `Specify windowId or an exact target ID. Windows: ${permitted.map(window => window.id).join(', ')}`);
      resolvedId = permitted[0].id;
    }
    authorize(principal, operation, params, resolvedId);
    const window = this.windows.get(resolvedId);
    if (!window?.online) throw new HubError('WINDOW_OFFLINE', 'Target window is offline.');
    return this.invoke(window, operation, params, principal, signal);
  }

  private invoke(window: WindowEntry, operation: string, params: Record<string, unknown>, principal: Principal,
    signal?: AbortSignal): Promise<unknown> {
    authorize(principal, operation, params, window.id);
    if (!window.capabilities.includes(operation)) throw new HubError('CAPABILITY_UNAVAILABLE', 'Tool is unavailable in this window.');
    if (this.pending.size >= 256) throw new HubError('LIMIT_REACHED', 'Too many outstanding operations.');
    if (signal?.aborted) throw new HubError('CANCELLED', 'Request was cancelled before dispatch.');
    const id = randomUUID();
    const mutation = TOOL_BY_NAME.get(operation)!.scopes.some(scope => scope !== 'terminal:read' && scope !== 'files:read') ||
      (operation === 'get_session_environment' && params.activeProbe !== false && principal.scopes.includes('terminal:write'));
    const timeoutMs = operation === 'read_terminal_output' ? 35000 : Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(150000, Number(params.timeout ?? 30000) + 125000));
    return new Promise((resolve, reject) => {
      const cancel = (code: string, message: string) => {
        if (!this.pending.delete(id)) return;
        cleanup();
        try { window.send({ type: 'cancel', id, windowId: window.id, epoch: window.epoch }); } catch { /* Socket may already be closed. */ }
        reject(new HubError(code, `${message} Request: ${id}`));
      };
      const timer = setTimeout(() => cancel(mutation ? 'OUTCOME_UNKNOWN' : 'TIMEOUT', 'Observation deadline exceeded.'), timeoutMs).unref();
      const abort = () => cancel(mutation ? 'OUTCOME_UNKNOWN' : 'CANCELLED', 'Request cancelled; cancellation does not prove the operation stopped.');
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { windowId: window.id, epoch: window.epoch, mutation, resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try {
        window.send({ type: 'request', id, windowId: window.id, epoch: window.epoch, operation, params,
          timeoutMs, principal: { id: principal.id, scopes: [...principal.scopes], ...(principal.windows ? { windows: [...principal.windows] } : {}) } });
      } catch {
        cancel(mutation ? 'OUTCOME_UNKNOWN' : 'WINDOW_OFFLINE', 'Satellite send failed.');
      }
    });
  }

  private namespace(value: unknown, window: WindowEntry): unknown {
    if (Array.isArray(value)) return value.map(item => this.namespace(item, window));
    if (!value || typeof value !== 'object') return value;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'text' && typeof item === 'string') {
        try { output[key] = JSON.stringify(this.namespace(JSON.parse(item), window)); }
        catch { output[key] = item; }
      } else if (typeof item === 'string' && (key in targetKinds || (key === 'id' &&
        Object.values(window.snapshot).some(entities => entities.some((entity: { id: string }) => entity.id === item)))))
        output[key] = globalId(window.id, item);
      else output[key] = this.namespace(item, window);
    }
    // Results always retain the socket owner, never a claimed result window.
    if ('windowId' in output || 'sessionId' in output || 'tabId' in output || 'transferId' in output) output.windowId = window.id;
    return output;
  }

  close(): void {
    clearInterval(this.timer);
    for (const window of this.windows.values()) this.disconnect(window.id, window.epoch);
    this.removeAllListeners();
  }
}

function validateSnapshot(snapshot: Snapshot): void {
  for (const entities of Object.values(snapshot)) if (new Set(entities.map(entity => entity.id)).size !== entities.length)
    throw new HubError('INVALID_SNAPSHOT', 'Duplicate entity IDs.');
  const tabs = new Set(snapshot.tabs.map(tab => tab.id));
  if (snapshot.sessions.some(session => !tabs.has(session.tabId))) throw new HubError('INVALID_SNAPSHOT', 'Pane refers to an unknown tab.');
}
export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function textResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
function decodeResult(result: unknown): unknown {
  const text = (result as { content?: { type: string; text?: string }[] })?.content?.find(item => item.type === 'text')?.text;
  try { return text ? JSON.parse(text) : result; } catch { return result; }
}
