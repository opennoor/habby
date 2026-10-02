import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const SCOPES = ['terminal:read', 'terminal:write', 'terminal:manage', 'files:read', 'files:write'] as const;
export type Scope = typeof SCOPES[number];
export interface Principal {
  id: string;
  scopes: readonly string[];
  windows?: readonly string[];
  expiresAt?: number;
  token?: string;
}
export const LOCAL_PRINCIPAL: Principal = { id: 'trusted-local', scopes: SCOPES };

const id = z.string().min(1).max(256);
const metadata = z.record(z.unknown());
const entity = z.object({ id, title: z.string().max(1024).optional() }).passthrough();
export const snapshotSchema = z.object({
  tabs: z.array(entity).max(4096),
  sessions: z.array(entity.extend({ tabId: id })).max(4096),
  profiles: z.array(entity).max(4096),
  transfers: z.array(entity).max(4096),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const registerSchema = z.object({
  type: z.literal('register'), protocol: z.literal(PROTOCOL_VERSION), windowId: z.string().uuid(),
  resumeToken: id.optional(), metadata, capabilities: z.array(z.string().max(100)).max(128),
  snapshot: snapshotSchema,
}).strict();
export type Registration = z.infer<typeof registerSchema>;
export const wireMessageSchema = z.discriminatedUnion('type', [
  registerSchema,
  z.object({ type: z.literal('registered'), windowId: id, epoch: id, resumeToken: id }).strict(),
  z.object({ type: z.literal('request'), id, windowId: id, epoch: id, operation: id,
    params: metadata, timeoutMs: z.number().int().min(1).max(300000), principal: z.object({
      id, scopes: z.array(z.string()), windows: z.array(z.string()).optional(),
    }).strict() }).strict(),
  z.object({ type: z.literal('response'), id, windowId: id, epoch: id,
    result: z.unknown().optional(), error: z.object({ code: id, message: z.string().max(2048) }).optional(),
  }).strict(),
  z.object({ type: z.literal('event'), windowId: id, epoch: id, sequence: z.number().int().nonnegative(),
    event: z.enum(['snapshot', 'output', 'command', 'transfer']), data: z.unknown(),
  }).strict(),
  z.object({ type: z.literal('heartbeat'), windowId: id, epoch: id }).strict(),
  z.object({ type: z.literal('cancel'), id, windowId: id, epoch: id }).strict(),
  z.object({ type: z.literal('resnapshot'), windowId: id, epoch: id }).strict(),
]);
export type WireMessage = z.infer<typeof wireMessageSchema>;
export class HubError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'HubError'; }
}

export function globalId(windowId: string, localId: string): string {
  return `${windowId}/${encodeURIComponent(localId)}`;
}
export function parseGlobalId(value: string): { windowId: string; localId: string } {
  const slash = value.indexOf('/');
  if (slash < 1) throw new HubError('INVALID_TARGET', 'Use an ID returned by Hub discovery.');
  try {
    const windowId = z.string().uuid().parse(value.slice(0, slash));
    const localId = decodeURIComponent(value.slice(slash + 1));
    if (!localId) throw new Error();
    return { windowId, localId };
  } catch { throw new HubError('INVALID_TARGET', 'Malformed global target ID.'); }
}

export interface HubConfig {
  stateDir: string;
  trustedPort: number;
  satellitePort: number;
  publicPort: number;
  publicUrl?: string;
  trustedHosts?: string[];
}
export interface SatelliteTrust {
  url: string;
  certificate: string;
  spkiPin: string;
  credential: string;
}
