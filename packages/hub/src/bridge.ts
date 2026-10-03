import { StreamableHTTPClientTransport, type JSONRPCMessage } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Readable, Writable } from 'node:stream';
import { MAX_FRAME_BYTES } from '../../../shared/protocol.js';

export interface BridgeOptions {
  token?: string;
  input?: Readable;
  output?: Writable;
  onerror?: (error: Error) => void;
  signal?: AbortSignal;
}
/** Transparent transport bridge: IDs, protocol claims, notifications and subscriptions are unchanged. */
export async function runBridge(url: string, options: BridgeOptions = {}): Promise<void> {
  const target = new URL(url);
  if (target.username || target.password || target.hash) throw new Error('Bridge URL must not contain credentials or a fragment.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && (local || !options.token))) throw new Error('Bearer tokens require HTTPS except on loopback.');
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Bridge requires an HTTP MCP URL.');
  const stdio = new StdioServerTransport(options.input ?? process.stdin, options.output ?? process.stdout, { maxBufferSize: MAX_FRAME_BYTES });
  const http = new StreamableHTTPClientTransport(target, {
    requestInit: options.token ? { headers: { Authorization: `Bearer ${options.token}` } } : undefined,
    // A dropped mutating request must never be replayed by the bridge.
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const pending = new Set<string | number>();
  let closed = false;
  let complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  const report = options.onerror ?? ((error: Error) => process.stderr.write(`Tabby Hub bridge: ${error.message}\n`));
  const close = async () => {
    if (closed) return;
    closed = true;
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    options.signal?.removeEventListener('abort', stop);
    try { await Promise.allSettled([http.close(), stdio.close()]); } finally { complete(); }
  };
  const stop = () => { void close(); };
  let queuedBytes = 0;
  let outbound = Promise.resolve();
  const send = (message: JSONRPCMessage): Promise<void> => {
    const size = Buffer.byteLength(JSON.stringify(message));
    if (queuedBytes + size > MAX_FRAME_BYTES) {
      const error = new Error('Bridge output buffer limit reached; closing a slow reader.');
      report(error); stop(); return Promise.reject(error);
    }
    queuedBytes += size;
    const written = outbound.then(() => { if (!closed) return stdio.send(message); });
    outbound = written.catch(() => {}).finally(() => { queuedBytes -= size; });
    return written;
  };
  http.onclose = stop;
  stdio.onclose = stop;
  http.onerror = error => { if (!closed) report(error); };
  stdio.onerror = error => { report(error); stop(); };
  http.onmessage = message => {
    if ('id' in message && message.id !== undefined && !('method' in message)) {
      pending.delete(message.id);
      if ('result' in message && message.result && typeof message.result === 'object' && 'protocolVersion' in message.result && typeof message.result.protocolVersion === 'string') http.setProtocolVersion(message.result.protocolVersion);
    }
    void send(message).catch(error => { if (!closed) report(error); stop(); });
  };
  stdio.onmessage = (message: JSONRPCMessage) => {
    if (closed) return;
    const request = 'method' in message && 'id' in message;
    if (request && pending.size >= 64) {
      void send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Bridge outstanding-request limit reached.' } }).catch(stop);
      return;
    }
    if (request) pending.add(message.id);
    void http.send(message).catch(async error => {
      if (closed) return;
      if (request && pending.delete(message.id) && !closed) {
        // HTTP failure cannot establish whether a shell/file mutation took effect.
        await send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'HTTP request failed; execution outcome may be unknown. Inspect the target before retrying.' } }).catch(report);
      }
      report(error);
    });
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    await http.start();
    if (options.signal?.aborted) await close();
    if (!closed) await stdio.start();
    await done;
  } catch (error) { await close(); throw error; }
}
