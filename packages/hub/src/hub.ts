import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { McpServer, createMcpHandler, isCallToolResult, type AuthInfo } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { TOOLS, authorize } from '../../../shared/catalog.js';
import { HubError, LOCAL_PRINCIPAL, MAX_FRAME_BYTES, wireMessageSchema,
  type HubConfig, type Principal } from '../../../shared/protocol.js';
import type { PublicAuth, PublicAuthFactory } from '../../../shared/auth-contract.js';
import { equalSecret, textResult, WindowRegistry } from './registry.js';
import { initializeState, validatePublicUrl, writePrivateJson } from './state.js';
import { join } from 'node:path';

export interface HubHandle {
  config: HubConfig;
  registry: WindowRegistry;
  close(): Promise<void>;
}

export async function startHub(config: HubConfig, options: { authFactory?: PublicAuthFactory } = {}): Promise<HubHandle> {
  const state = await initializeState(config.stateDir, config);
  const registry = new WindowRegistry();
  let publicAuth: PublicAuth | undefined;
  let publicServer: Server | undefined;
  let publicHandler: ReturnType<typeof createMcpHandler> | undefined;
  let enablingPublic: Promise<void> | undefined;
  let publicReady = false;
  const peers = new Set<WebSocket>();
  const bindings = new Map<WebSocket, { windowId: string; epoch: string }>();
  const handlers = new Set<ReturnType<typeof createMcpHandler>>();
  const sockets = new Set<import('node:net').Socket>();
  const track = (server: Server) => server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const makeMcp = (publicAccess: boolean) => {
    const handler = createMcpHandler(context => {
      const principal = publicAccess ? context.authInfo?.extra?.principal as Principal : LOCAL_PRINCIPAL;
      if (!principal) throw new HubError('UNAUTHORIZED', 'Public MCP requires a verified token.');
      const server = new McpServer({ name: 'Tabby Hub', version: '0.1.0' });
      for (const tool of TOOLS) {
        try { authorize(principal, tool.name); } catch { continue; }
        server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema,
          annotations: { readOnlyHint: tool.name !== 'get_session_environment' && tool.scopes.every(scope => scope.endsWith(':read')), openWorldHint: true } },
        async (params, context) => {
          try {
            if (publicAccess && (!publicAuth || !await publicAuth.isAuthorized(principal)))
              throw new HubError('UNAUTHORIZED', 'Agent grant is expired or revoked.');
            const result = await registry.call(tool.name, params as Record<string, unknown>, principal, context.mcpReq.signal);
            if (!isCallToolResult(result)) throw new HubError('INVALID_RESULT', 'Satellite returned an invalid MCP tool result.');
            return result;
          } catch (error) {
            return { ...textResult({ code: error instanceof HubError ? error.code : 'INVALID_REQUEST',
              message: error instanceof Error ? error.message : 'Operation failed.' }), isError: true };
          }
        });
      }
      return server;
    }, { maxRequestBodySize: MAX_FRAME_BYTES, maxSubscriptions: 64,
      onerror: error => process.stderr.write(`MCP transport: ${error.message}\n`) });
    handlers.add(handler);
    return handler;
  };
  const trustedHandler = makeMcp(false);
  const trustedNode = toNodeHandler(trustedHandler, { maxRequestBodySize: MAX_FRAME_BYTES });
  const trustedServer = createServer((req, res) => void routeTrusted(req, res).catch(error => respondError(res, error)));
  track(trustedServer);
  async function routeTrusted(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!trustedRequest(req, config)) return json(res, 403, { error: 'Untrusted Host or browser Origin.' });
    if (req.url === '/health' && req.method === 'GET') return json(res, 200, { name: 'Tabby Hub', version: '0.1.0', alive: true });
    if (req.url !== '/mcp') return json(res, 404, { error: 'Not found.' });
    await trustedNode(req, res);
  }

  const secureServer = createSecureServer({ key: state.privateKey, cert: state.trust.certificate, minVersion: 'TLSv1.2' },
    (req, res) => void routeAdmin(req, res).catch(error => respondError(res, error)));
  track(secureServer);
  async function routeAdmin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!localSocket(req) || req.headers.origin || !equalSecret(bearer(req), state.adminCredential))
      return json(res, 401, { error: 'Local administrator credential required.' });
    if (req.url === '/admin/status' && req.method === 'GET') return json(res, 200, {
      pid: process.pid, config, windows: registry.list(LOCAL_PRINCIPAL),
    });
    if (req.url === '/admin/enroll' && req.method === 'POST') {
      if (!publicAuth) throw new HubError('PUBLIC_NOT_CONFIGURED', 'Configure a public HTTPS URL first.');
      return json(res, 200, { url: await publicAuth.enrollmentLink() });
    }
    if (req.url === '/admin/configure' && req.method === 'POST') {
      const body = await readSmallJson(req);
      if (typeof body.publicUrl !== 'string') throw new Error('publicUrl is required.');
      validatePublicUrl(body.publicUrl);
      if (config.publicUrl && config.publicUrl !== body.publicUrl) throw new Error('Changing an enrolled public origin requires a separate owner migration.');
      const previousUrl = config.publicUrl;
      config.publicUrl = body.publicUrl;
      try { await enablePublic(true, previousUrl); } catch (error) { config.publicUrl = previousUrl; throw error; }
      return json(res, 200, { url: await publicAuth!.enrollmentLink() });
    }
    if (req.url === '/admin/trusted-hosts' && req.method === 'POST') {
      const body = await readSmallJson(req);
      if (!Array.isArray(body.hosts) || body.hosts.length > 16 || !body.hosts.every(host => typeof host === 'string' && /^[a-zA-Z0-9.:[\]-]{1,253}$/.test(host))) throw new Error('Invalid trusted hosts.');
      config.trustedHosts = body.hosts;
      await writePrivateJson(join(config.stateDir, 'config.json'), config);
      return json(res, 200, { updated: true });
    }
    return json(res, 404, { error: 'Not found.' });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  secureServer.on('upgrade', (req, socket, head) => {
    if (req.url !== '/satellite' || !localSocket(req) || req.headers.origin ||
      !equalSecret(bearer(req), state.trust.credential) || peers.size >= 256) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', (socket: WebSocket) => {
    peers.add(socket);
    let binding: { windowId: string; epoch: string } | undefined;
    const registrationDeadline = setTimeout(() => socket.close(1008, 'Registration required.'), 5000).unref();
    socket.on('message', buffer => {
      try {
        const message = wireMessageSchema.parse(JSON.parse(buffer.toString()));
        if (!binding) {
            if (message.type !== 'register') throw new HubError('INVALID_MESSAGE', 'Registration required.');
            const registration = message;
          const result = registry.register(registration, message => {
            const serialized = JSON.stringify(message);
            if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount + Buffer.byteLength(serialized) > MAX_FRAME_BYTES)
              throw new HubError('BACKPRESSURE', 'Satellite socket cannot accept the operation.');
            socket.send(serialized);
          });
          binding = { windowId: registration.windowId, epoch: result.epoch };
          bindings.set(socket, binding);
          clearTimeout(registrationDeadline);
          socket.send(JSON.stringify({ type: 'registered', windowId: binding.windowId, ...result }));
        } else registry.receive(binding.windowId, binding.epoch, message);
      } catch { socket.close(1008, 'Invalid protocol message or window binding.'); }
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => { clearTimeout(registrationDeadline); peers.delete(socket); bindings.delete(socket); if (binding) registry.disconnect(binding.windowId, binding.epoch); });
  });
  registry.on('offline', windowId => {
    for (const [socket, binding] of bindings) if (binding.windowId === windowId) socket.terminate();
  });

  async function enablePublic(persistConfig = false, previousUrl?: string): Promise<void> {
    if (enablingPublic) return enablingPublic;
    if (publicServer || !config.publicUrl) return;
    enablingPublic = openPublic(persistConfig, previousUrl).catch(async error => {
      publicReady = false;
      publicServer?.close(); publicServer = undefined;
      if (publicHandler) { await publicHandler.close(); handlers.delete(publicHandler); publicHandler = undefined; }
      await publicAuth?.close(); publicAuth = undefined;
      throw error;
    }).finally(() => { enablingPublic = undefined; });
    return enablingPublic;
  }
  async function openPublic(persistConfig: boolean, previousUrl?: string): Promise<void> {
    const factory = options.authFactory ?? (await import('./auth.js')).createPublicAuth;
    publicAuth = await factory(config, { deferOriginCommit: true });
    publicHandler = makeMcp(true);
    const nodeHandler = toNodeHandler(publicHandler, { maxRequestBodySize: MAX_FRAME_BYTES });
    publicServer = createServer((req, res) => void routePublic(req, res).catch(error => respondError(res, error)));
    track(publicServer);
    const publicUrl = new URL(config.publicUrl!);
    async function routePublic(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (!publicReady) return json(res, 503, { error: 'Public setup is not committed.' });
      if (req.headers.origin && req.headers.origin !== publicUrl.origin)
        return json(res, 403, { error: 'Browser origin rejected.' });
      if (await publicAuth!.handle(req, res)) return;
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path !== '/mcp' && path !== publicUrl.pathname) return json(res, 404, { error: 'Not found.' });
      let principal: Principal;
      try { principal = await publicAuth!.authenticate(req); }
      catch {
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${publicUrl.origin}/.well-known/oauth-protected-resource${publicUrl.pathname}"`);
        return json(res, 401, { error: 'Public MCP requires an authorized agent token.' });
      }
      const auth: AuthInfo = { token: principal.token ?? '', clientId: principal.id, scopes: [...principal.scopes],
        ...(principal.expiresAt ? { expiresAt: Math.floor(principal.expiresAt / 1000) } : {}),
        resource: new URL(config.publicUrl!), extra: { principal } };
      (req as IncomingMessage & { auth: AuthInfo }).auth = auth;
      let checking = false;
      const interval = setInterval(() => {
        if (checking) return;
        checking = true;
        void publicAuth!.isAuthorized(principal).then(valid => { if (!valid) res.destroy(); })
          .catch(() => res.destroy()).finally(() => { checking = false; });
      }, 1000).unref();
      const clear = () => clearInterval(interval);
      res.once('close', clear); res.once('finish', clear);
      try { await nodeHandler(req, res); } finally { if (res.writableEnded) clear(); }
    }
    await listen(publicServer, config.publicPort);
    if (persistConfig) await writePrivateJson(join(config.stateDir, 'config.json'), config);
    try { publicAuth.commitOrigin(); }
    catch (error) {
      if (persistConfig) await writePrivateJson(join(config.stateDir, 'config.json'), { ...config, publicUrl: previousUrl });
      throw error;
    }
    publicReady = true;
  }

  let closing: Promise<void> | undefined;
  async function close(): Promise<void> {
    return closing ??= (async () => {
      await enablingPublic?.catch(() => {});
      registry.close();
      for (const peer of peers) peer.terminate();
      await Promise.all([...handlers].map(handler => handler.close()));
      for (const socket of sockets) socket.destroy();
      await Promise.all([trustedServer, secureServer, publicServer].filter(Boolean).map(server => new Promise<void>(resolve => server!.close(() => resolve()))));
      wss.close();
      await publicAuth?.close();
    })();
  }
  try {
    await listen(trustedServer, config.trustedPort);
    await listen(secureServer, config.satellitePort);
    await enablePublic();
  } catch (error) { await close(); throw error; }
  return { config, registry, close };
}

function trustedRequest(req: IncomingMessage, config: HubConfig): boolean {
  let host: string;
  try { host = new URL(`http://${req.headers.host}`).hostname; } catch { return false; }
  const permitted = new Set(['127.0.0.1', 'localhost', '[::1]', ...(config.trustedHosts ?? [])]);
  if (!permitted.has(host)) return false;
  if (!req.headers.origin) return true;
  try { const origin = new URL(req.headers.origin); return permitted.has(origin.hostname) && origin.port === String(config.trustedPort) && origin.protocol === 'http:'; }
  catch { return false; }
}
function localSocket(req: IncomingMessage): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
}
function bearer(req: IncomingMessage): string { return req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : ''; }
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function respondError(res: ServerResponse, error: unknown): void {
  json(res, 500, { error: error instanceof HubError ? error.code : 'INTERNAL_ERROR' });
}
async function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error('Request too large.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}
