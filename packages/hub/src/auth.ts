import Provider, { errors, type Configuration, type ClientMetadata } from 'oidc-provider';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON, AuthenticatorTransport } from '@simplewebauthn/server';
import { generateKeyPair, exportJWK } from 'jose';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parse as parseForm } from 'node:querystring';
import type { PublicAuth } from '../../../shared/auth-contract.js';
import { HubError, SCOPES, type HubConfig, type Principal } from '../../../shared/protocol.js';
import { openStore, secret, digest, type AuthStore } from './auth/store.js';
import { safeMetadataFetch, jsonBody, redirectAllowed } from './auth/security.js';
import { html, page, browserHelpers } from './auth/ui.js';

type OwnerSession = { csrf: string; owner: boolean; enroll: boolean; generation: number };
type CredentialRow = { id: string; public_key: string; counter: number; transports: string | null };
type GrantRow = { id: string; client_id: string; scopes: string; windows: string | null; created: number; expires: number; revoked: number };
type Pending = { uid: string; fingerprint: string; clientId: string; clientName: string; redirect: string; scopes: string[];
  approvalCode: string; approvalSecret: string; grantId?: string; denied?: boolean; expires: number };
const COOKIE = '__Host-tabby_owner';
const OWNER = 'owner';
const FIVE_MINUTES = 5 * 60 * 1000;
const GRANT_TTL = 30 * 24 * 60 * 60 * 1000;

function same(a: unknown, b: unknown) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function normalizeClient(input: Record<string, unknown>, clientId = secret()): ClientMetadata {
  const redirects = input.redirect_uris;
  if (!Array.isArray(redirects) || !redirects.length || redirects.length > 10 || redirects.some(uri => typeof uri !== 'string' || !redirectAllowed(uri))) throw new Error('Register exact HTTPS or localhost callback URLs.');
  if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') throw new Error('Only public PKCE clients are supported.');
  if (input.grant_types && (!Array.isArray(input.grant_types) || input.grant_types.some(value => !['authorization_code','refresh_token'].includes(String(value))))) throw new Error('Only authorization_code and refresh_token grants are supported.');
  if (input.response_types && (!Array.isArray(input.response_types) || input.response_types.some(value => value !== 'code'))) throw new Error('Only code responses are supported.');
  return { client_id: clientId, client_name: typeof input.client_name === 'string' ? input.client_name.slice(0, 128) : 'MCP agent',
    redirect_uris: redirects as string[], token_endpoint_auth_method: 'none', grant_types: ['authorization_code','refresh_token'], response_types: ['code'] };
}

export async function createPublicAuth(config: HubConfig, options: { deferOriginCommit?: boolean } = {}): Promise<PublicAuth> {
  if (!config.publicUrl) throw new Error('Set the final public HTTPS MCP URL before enabling public authentication.');
  const resource = new URL(config.publicUrl);
  if (resource.protocol !== 'https:' || resource.username || resource.password || resource.search || resource.hash || !resource.pathname.endsWith('/mcp')) throw new Error('publicUrl must be a clean HTTPS MCP URL ending in /mcp.');
  const base = resource.pathname.slice(0, -4);
  const origin = resource.origin;
  const issuerPath = base + '/oauth';
  const issuer = origin + issuerPath;
  const metadataPath = '/.well-known/oauth-protected-resource' + resource.pathname;
  const store = await openStore(config.stateDir);
  const generation = () => store.get<number>('owner-generation') ?? 0;
  if (store.get<string>('public-origin') && store.get<string>('public-origin') !== origin) { store.close(); throw new Error('Public hostname changed. Restore the enrolled origin or explicitly migrate owner credentials.'); }

  let keys = store.get<string[]>('cookie-keys');
  if (!keys) { keys = [secret(), secret()]; store.set('cookie-keys', keys); }
  let jwks = store.get<{ keys: Record<string, unknown>[] }>('jwks');
  if (!jwks) {
    const { privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    jwks = { keys: [{ ...await exportJWK(privateKey), use: 'sig', alg: 'RS256', kid: secret() }] };
    store.set('jwks', jwks);
  }
  const preregistered = store.get<ClientMetadata[]>('static-clients') ?? [];
  const providerConfiguration: Configuration = {
    adapter: model => store.adapter(model),
    clients: preregistered,
    jwks: jwks as Configuration['jwks'],
    cookies: { keys, short: { secure: true, httpOnly: true, sameSite: 'lax' }, long: { secure: true, httpOnly: true, sameSite: 'lax' } },
    features: {
      devInteractions: { enabled: false }, userinfo: { enabled: false },
      revocation: { enabled: true }, registration: { enabled: true }, registrationManagement: { enabled: false },
      clientIdMetadataDocument: { enabled: true, ack: 'draft-02',
        allowFetch: (_ctx, id) => { try { const u = new URL(id); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; } catch { return false; } },
        allowClient: (_ctx, client) => client.tokenEndpointAuthMethod === 'none' && Boolean(client.redirectUris?.length) && client.redirectUris!.every(redirectAllowed),
        cacheDuration: { min: 30, max: 300 },
      },
      resourceIndicators: { enabled: true,
        getResourceServerInfo: (_ctx, indicator) => {
          if (indicator !== resource.href) throw new errors.InvalidTarget('Only this Hub resource is allowed.');
          return { scope: SCOPES.join(' '), audience: resource.href, accessTokenFormat: 'opaque', accessTokenTTL: 300 };
        },
        defaultResource: () => { throw new errors.InvalidTarget('The resource parameter is required.'); },
        useGrantedResource: () => false,
      },
    },
    responseTypes: ['code'], scopes: ['openid', 'offline_access'],
    pkce: { required: () => true },
    rotateRefreshToken: true,
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    ttl: { AccessToken: 300, AuthorizationCode: 60, Interaction: 300, Grant: GRANT_TTL / 1000,
      RefreshToken: 7 * 24 * 3600, Session: 12 * 3600, RegistrationAccessToken: 3600 },
    interactions: { url: (_ctx, interaction) => origin + base + '/interaction/' + interaction.uid },
    findAccount: async (_ctx, id) => id === OWNER && store.get<boolean>('owner-enabled') ? { accountId: OWNER, claims: async () => ({ sub: OWNER }) } : undefined,
    renderError: (ctx, _out, error) => { ctx.type = 'html'; ctx.body = page('Authorization denied', `<p>${html(error.message)}</p>`); },
  };
  // oidc-provider's fetch option is present in v9 runtime but absent from DefinitelyTyped.
  Object.assign(providerConfiguration, { fetch: safeMetadataFetch, fetchResponseBodyLimits: { 'client_id metadata document': 64 * 1024 } });
  const provider = new Provider(issuer, providerConfiguration);
  provider.proxy = true;
  provider.on('grant.revoked', (_ctx, grantId) => store.revokeGrant(grantId));
  provider.use(async (ctx, next) => {
    ctx.mountPath = issuerPath;
    await next();
  });
  const callback = provider.callback();
  const rates = new Map<string, { count: number; start: number }>();
  const limit = (req: IncomingMessage, bucket: string, max = 30, global = false) => {
    const key = `${bucket}:${global ? 'all' : req.socket.remoteAddress ?? 'unknown'}`; const now = Date.now();
    const old = rates.get(key); const value = old && now - old.start < 60_000 ? old : { count: 0, start: now };
    if (!old && rates.size >= 1024) {
      for (const [key, value] of rates) if (now - value.start >= 60_000) rates.delete(key);
      if (rates.size >= 1024) throw new HubError('RATE_LIMITED', 'Too many attempts. Wait one minute.');
    }
    value.count++; rates.set(key, value);
    if (value.count > max) throw new HubError('RATE_LIMITED', 'Too many attempts. Wait one minute.');
  };
  function secureHeaders(req: IncomingMessage) {
    req.headers.host = resource.host;
    req.headers['x-forwarded-host'] = resource.host;
    req.headers['x-forwarded-proto'] = 'https';
    delete req.headers.forwarded; delete req.headers['x-forwarded-for'];
  }
  function reply(res: ServerResponse, status: number, value: unknown, type = 'application/json') {
    res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    res.end(type === 'application/json' ? JSON.stringify(value) : String(value));
  }
  function redirect(res: ServerResponse, url: string) { res.writeHead(303, { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); }
  function browserSession(req: IncomingMessage, res: ServerResponse, create = false): { session: OwnerSession; key: string } | undefined {
    const match = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='));
    const token = match?.slice(COOKIE.length + 1);
    const key = token ? 'session:' + digest(token) : '';
    const session = key ? store.get<OwnerSession>(key) : undefined;
    if (session && session.generation === generation()) return { session, key };
    if (!create) return undefined;
    limit(req, 'browser-session');
    limit(req, 'browser-session-global', 120, true);
    const fresh = secret(); const nextKey = 'session:' + digest(fresh);
    const next = { owner: false, enroll: false, csrf: secret(), generation: generation() };
    store.set(nextKey, next, Date.now() + 15 * 60_000);
    res.setHeader('Set-Cookie', `${COOKIE}=${fresh}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200`);
    return { session: next, key: nextKey };
  }
  function requireCurrent(session: OwnerSession) {
    if (session.generation !== generation()) throw new Error('Owner authentication changed. Start again.');
  }
  function requireOwner(session: OwnerSession | undefined) {
    if (!session?.owner || !store.get<boolean>('owner-enabled')) throw new Error('Owner passkey sign-in is required.');
    requireCurrent(session);
  }
  function browserScript(session: OwnerSession, extra: string) {
    return `const BASE=${JSON.stringify(base)};const CSRF=${JSON.stringify(session.csrf)};${browserHelpers}${extra}`;
  }
  function credentials() { return store.db.prepare('SELECT * FROM credentials').all() as CredentialRow[]; }
  function ownerPage(res: ServerResponse, enroll: boolean, context: { session: OwnerSession; key: string }) {
    if (context.session.owner || enroll) {
      if (!context.session.owner && !context.session.enroll) throw new Error('Use the one-use enrollment link created on the host.');
      reply(res, 200, page('Owner passkeys', `<p>Register a passkey for ${html(resource.hostname)}. Add a second passkey for recovery.</p><button onclick="passkey('register')">Add passkey</button><p><a id="continue" href="${html(base)}/owner" hidden>Continue to agent management</a></p>`, browserScript(context.session, '')), 'text/html');
    } else {
      reply(res, 200, page('Owner sign-in', `<p>Sign in with a passkey to approve agents and manage their access.</p><button onclick="passkey('authenticate')">Sign in with passkey</button><details><summary>Recover with an offline code</summary><input id="recovery" autocomplete="off" placeholder="Recovery code"><button onclick="recover()">Recover</button></details>`, browserScript(context.session, `async function recover(){try{await post(BASE+'/owner/recover',{code:document.getElementById('recovery').value});location.href=BASE+'/owner/enroll';}catch(e){message.textContent=e.message;}}`)), 'text/html');
    }
  }
  async function pendingFromInteraction(req: IncomingMessage, res: ServerResponse): Promise<Pending> {
    secureHeaders(req);
    const details = await provider.interactionDetails(req, res);
    const uid = details.uid; const params = details.params;
    if (store.get<boolean>('finished:' + uid)) throw new Error('This authorization request was already completed.');
    const fingerprint = digest(JSON.stringify(params));
    const scopes = String(params.scope ?? '').split(' ').filter(scope => SCOPES.includes(scope as typeof SCOPES[number]));
    if (!scopes.length || params.resource !== resource.href) throw new Error('Request must target this Hub and include Hub permissions.');
    const existing = store.get<Pending>('pending:' + uid);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new Error('Authorization transaction changed.'); return existing; }
    const client = await provider.Client.find(String(params.client_id));
    if (!client) throw new Error('Unknown agent client.');
    const pending: Pending = { uid, fingerprint, clientId: client.clientId, clientName: client.clientName || client.clientId,
      redirect: String(params.redirect_uri), scopes, approvalCode: randomBytes(6).toString('hex').toUpperCase(), approvalSecret: secret(), expires: Date.now() + FIVE_MINUTES };
    store.set('pending:' + uid, pending, pending.expires);
    store.set('phone:' + digest(pending.approvalSecret), uid, pending.expires);
    store.set('phone-code:' + digest(pending.approvalCode), uid, pending.expires);
    return pending;
  }
  function phonePending(url: URL): Pending {
    const code = url.searchParams.get('code') ?? '';
    const uid = store.get<string>('phone:' + digest(code)) ?? store.get<string>('phone-code:' + digest(code.trim().toUpperCase()));
    const value = uid && store.get<Pending>('pending:' + uid);
    if (!value) throw new Error('Approval link expired or does not exist.');
    return value;
  }
  async function approve(pending: Pending, input: Record<string, unknown>) {
    if (pending.grantId || pending.denied) throw new Error('This request was already decided.');
    const selected = input.scopes;
    if (!Array.isArray(selected) || !selected.length || selected.some(scope => typeof scope !== 'string' || !pending.scopes.includes(scope))) throw new Error('Select only permissions requested by this agent.');
    const windows = input.windows;
    if (windows !== undefined && (!Array.isArray(windows) || windows.length > 100 || windows.some(value => typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)))) throw new Error('Window restrictions must be window IDs returned by Hub discovery.');
    const ownerGeneration = generation();
    const grant = new provider.Grant({ accountId: OWNER, clientId: pending.clientId });
    grant.addResourceScope(resource.href, selected as string[]);
    grant.rejectResourceScope(resource.href, pending.scopes.filter(scope => !selected.includes(scope)));
    pending.grantId = await grant.save();
    if (generation() !== ownerGeneration || !store.get<boolean>('owner-enabled')) { await grant.destroy(); throw new Error('Owner authentication changed. Start a new approval.'); }
    store.db.prepare('INSERT INTO grants VALUES(?,?,?,?,?,?,0)').run(pending.grantId, pending.clientId, JSON.stringify(selected),
      windows === undefined ? null : JSON.stringify(windows), Date.now(), Date.now() + GRANT_TTL);
    store.db.prepare("UPDATE oauth SET expires=NULL WHERE model='Client' AND key=?").run(digest(pending.clientId));
    store.set('pending:' + pending.uid, pending, pending.expires);
  }
  function consentContent(pending: Pending, phone: boolean, signedIn: boolean) {
    const scopes = pending.scopes.map(scope => `<label><input type="checkbox" name="scope" value="${html(scope)}" checked>${html(scope)}</label>`).join('');
    return `<p><strong>${html(pending.clientName)}</strong> requests access to ${html(resource.hostname)}.</p><p>Client: <code>${html(pending.clientId)}</code><br>Callback: <code>${html(pending.redirect)}</code><br>Grant expires in 30 days. Access tokens expire in 5 minutes.</p><p>Terminal write permits arbitrary commands as the terminal user.</p>${scopes}<label>Optional allowed window IDs (comma separated; blank allows all)<input id="windows" placeholder="Window IDs from list_windows"></label>${signedIn ? '<button onclick="approve()">Approve selected permissions</button> <button onclick="deny()">Deny</button>' : '<button onclick="passkey(\'authenticate\')">Sign in with passkey</button>'}${phone ? '<p>After approving, return to the original agent browser. Its callback will finish there.</p>' : `<p>Approve from a phone: <a href="${html(base)}/approve?code=${html(pending.approvalSecret)}">Open approval link</a></p><div id="qr"></div><p>Approval code: <code>${html(pending.approvalCode)}</code> (expires in 5 minutes).</p><p>Keep this page open until your phone approves.</p>`}`;
  }
  async function principalForToken(token: string): Promise<Principal> {
    const manual = store.db.prepare('SELECT grant_id,expires FROM manual_tokens WHERE hash=?').get(digest(token)) as { grant_id: string; expires: number } | undefined;
    let grantId: string | undefined; let scopes: string[]; let expiresAt: number;
    if (manual) { grantId = manual.grant_id; scopes = []; expiresAt = manual.expires; }
    else {
      const access = await provider.AccessToken.find(token);
      if (!access || access.accountId !== OWNER || access.aud !== resource.href || !access.grantId || access.isSenderConstrained()) throw new Error('Invalid token.');
      grantId = access.grantId; scopes = String(access.scope ?? '').split(' '); expiresAt = (access.exp ?? 0) * 1000;
    }
    const grant = store.db.prepare('SELECT * FROM grants WHERE id=?').get(grantId) as GrantRow | undefined;
    if (!grant || grant.revoked || grant.expires <= Date.now() || expiresAt <= Date.now() || !store.get<boolean>('owner-enabled')) throw new Error('Expired or revoked token.');
    const allowed = JSON.parse(grant.scopes) as string[];
    scopes = manual ? allowed : scopes.filter(scope => allowed.includes(scope));
    if (!scopes.length) throw new Error('No Hub permissions.');
    return { id: grant.id, scopes, windows: grant.windows === null ? undefined : JSON.parse(grant.windows) as string[], expiresAt: Math.min(expiresAt, grant.expires), token };
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    let url: URL;
    try { url = new URL(req.url ?? '/', origin); } catch { reply(res, 400, { error: 'Invalid URL.' }); return true; }
    let path = url.pathname;
    // Only the configured proxy mount may be stripped. Do not derive external URLs from request headers.
    if (base && !path.startsWith(base + '/') && ['/oauth','/owner','/interaction','/approve'].some(prefix => path === prefix || path.startsWith(prefix + '/'))) path = base + path;
    const discovery = path === '/.well-known/oauth-authorization-server' + issuerPath || path === issuerPath + '/.well-known/openid-configuration' || path === '/.well-known/openid-configuration' + issuerPath;
    const relevant = path === metadataPath || discovery || path.startsWith(issuerPath + '/') || path === base + '/owner' || path.startsWith(base + '/owner/') || path.startsWith(base + '/interaction/') || path === base + '/approve';
    if (!relevant) return false;
    try {
      if (req.headers.origin && req.headers.origin !== origin) { reply(res, 403, { error: 'Untrusted browser origin.' }); return true; }
      if (path === metadataPath) {
        reply(res, 200, { resource: resource.href, resource_name: 'Tabby Hub', authorization_servers: [issuer], scopes_supported: SCOPES, bearer_methods_supported: ['header'] }); return true;
      }
      if (discovery || path.startsWith(issuerPath + '/')) {
        secureHeaders(req);
        if (path === issuerPath + '/auth') limit(req, 'authorization', 60);
        if (path === issuerPath + '/reg' && req.method === 'POST') {
          limit(req, 'registration', 10);
          const body = await jsonBody(req);
          const normalized = normalizeClient(body);
          // Delegate protocol registration/registration tokens to oidc-provider after narrow validation.
          (req as IncomingMessage & { body?: unknown }).body = { ...normalized, client_id: undefined };
        }
        if ([issuerPath + '/auth', issuerPath + '/token'].includes(path)) {
          let parameters: URLSearchParams = url.searchParams;
          if (req.method === 'POST') {
            if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new Error('Form content type required.');
            const chunks: Buffer[] = []; let length = 0;
            for await (const chunk of req) { length += chunk.length; if (length > 56 * 1024) throw new Error('Request too large.'); chunks.push(Buffer.from(chunk)); }
            parameters = new URLSearchParams(Buffer.concat(chunks).toString());
            (req as IncomingMessage & { body?: unknown }).body = parseForm(parameters.toString());
          }
          if (parameters.getAll('resource').length !== 1 || parameters.get('resource') !== resource.href) {
            reply(res, 400, { error: 'invalid_target', error_description: 'The exact Hub resource parameter is required.' }); return true;
          }
        }
        req.url = discovery ? '/.well-known/oauth-authorization-server' : path.slice(issuerPath.length) + url.search;
        await callback(req, res); return true;
      }
      if (req.method === 'GET' && path === base + '/owner/enroll' && url.searchParams.has('code')) {
        limit(req, 'enrollment', 10);
        const bootstrapKey = 'bootstrap:' + digest(url.searchParams.get('code')!);
        const valid = store.get<{ generation: number }>(bootstrapKey);
        if (!valid || valid.generation !== generation()) throw new Error('Enrollment link expired or was already used.');
        const context = browserSession(req, res, true)!;
        store.take(bootstrapKey); context.session.enroll = true;
        store.set(context.key, context.session, Date.now() + 10 * 60_000);
        redirect(res, origin + base + '/owner/enroll'); return true;
      }
      const context = browserSession(req, res, true)!;
      let input: Record<string, unknown> = {};
      if (req.method === 'POST') {
        if (req.headers.origin !== origin) throw new Error('Origin header required.');
        input = await jsonBody(req);
        requireCurrent(context.session);
        if (!same(input.csrf, context.session.csrf)) throw new Error('CSRF validation failed.');
        limit(req, 'owner');
      }
      if (path.startsWith(base + '/owner/register/')) {
        if (!context.session.enroll) requireOwner(context.session);
        if (req.method !== 'POST') throw new Error('POST required.');
        if (path.endsWith('/options')) {
          const opts = await generateRegistrationOptions({ rpName: 'Tabby Hub', rpID: resource.hostname, userName: 'Tabby Hub owner',
            userID: new TextEncoder().encode(OWNER), attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            excludeCredentials: credentials().map(row => ({ id: row.id, transports: row.transports ? JSON.parse(row.transports) : undefined })) });
          requireCurrent(context.session);
          store.set('challenge:' + context.key, { kind: 'register', value: opts.challenge }, Date.now() + FIVE_MINUTES);
          reply(res, 200, opts);
        } else if (path.endsWith('/verify')) {
          const challenge = store.take<{ kind: string; value: string }>('challenge:' + context.key);
          if (!challenge || challenge.kind !== 'register') throw new Error('Registration challenge expired or was already used.');
          const verified = await verifyRegistrationResponse({ response: input.response as RegistrationResponseJSON, expectedChallenge: challenge.value,
            expectedOrigin: origin, expectedRPID: resource.hostname, requireUserVerification: true });
          requireCurrent(context.session);
          if (!verified.verified) throw new Error('Passkey verification failed.');
          const credential = verified.registrationInfo.credential;
          store.db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?)').run(credential.id, Buffer.from(credential.publicKey).toString('base64url'), credential.counter, JSON.stringify(credential.transports ?? []), Date.now());
          context.session.owner = true; context.session.enroll = false; store.set(context.key, context.session, Date.now() + 12 * 3600_000);
          const initial = !store.get<boolean>('owner-enabled'); store.set('owner-enabled', true);
          let recoveryCodes: string[] | undefined;
          if (initial) { store.db.prepare("DELETE FROM owner_state WHERE key LIKE 'recovery:%'").run(); recoveryCodes = Array.from({ length: 8 }, () => randomBytes(12).toString('hex')); for (const code of recoveryCodes) store.set('recovery:' + digest(code), true); }
          reply(res, 200, { ok: true, recoveryCodes });
        } else throw new Error('Unknown registration action.');
        return true;
      }
      if (path.startsWith(base + '/owner/authenticate/')) {
        if (req.method !== 'POST') throw new Error('POST required.');
        if (path.endsWith('/options')) {
          const opts = await generateAuthenticationOptions({ rpID: resource.hostname, userVerification: 'required',
            allowCredentials: credentials().map(row => ({ id: row.id, transports: row.transports ? JSON.parse(row.transports) : undefined })) });
          requireCurrent(context.session);
          store.set('challenge:' + context.key, { kind: 'authenticate', value: opts.challenge }, Date.now() + FIVE_MINUTES); reply(res, 200, opts);
        } else if (path.endsWith('/verify')) {
          const challenge = store.take<{ kind: string; value: string }>('challenge:' + context.key);
          if (!challenge || challenge.kind !== 'authenticate') throw new Error('Authentication challenge expired or was already used.');
          const response = input.response as AuthenticationResponseJSON;
          const credential = credentials().find(row => row.id === response?.id);
          if (!credential || !store.get<boolean>('owner-enabled')) throw new Error('Unknown owner passkey.');
          const verified = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.value, expectedOrigin: origin, expectedRPID: resource.hostname,
            requireUserVerification: true, credential: { id: credential.id, publicKey: new Uint8Array(Buffer.from(credential.public_key, 'base64url')), counter: credential.counter,
              transports: credential.transports ? JSON.parse(credential.transports) as AuthenticatorTransport[] : undefined } });
          requireCurrent(context.session);
          if (!verified.verified) throw new Error('Passkey verification failed.');
          store.db.prepare('UPDATE credentials SET counter=? WHERE id=?').run(verified.authenticationInfo.newCounter, credential.id);
          context.session.owner = true; store.set(context.key, context.session, Date.now() + 12 * 3600_000); reply(res, 200, { ok: true });
        } else throw new Error('Unknown authentication action.');
        return true;
      }
      if (path === base + '/owner/recover' && req.method === 'POST') {
        if (typeof input.code !== 'string' || !store.take<boolean>('recovery:' + digest(input.code.trim()))) throw new Error('Recovery code is invalid or was used.');
        // Recovery revokes every agent and owner browser session before enrolling a replacement passkey.
        store.db.prepare('DELETE FROM credentials').run();
        const next = generation() + 1; store.set('owner-generation', next); store.set('owner-enabled', false);
        for (const row of store.db.prepare('SELECT id FROM grants').all() as { id: string }[]) store.revokeGrant(row.id);
        context.session = { csrf: secret(), owner: false, enroll: true, generation: next };
        store.set(context.key, context.session, Date.now() + 10 * 60_000); reply(res, 200, { ok: true }); return true;
      }
      if (path.startsWith(base + '/interaction/') || path === base + '/approve') {
        const phone = path === base + '/approve'; if (phone) limit(req, 'approval');
        const pending = phone ? phonePending(url) : await pendingFromInteraction(req, res);
        if (!phone && path.slice((base + '/interaction/').length).split('/')[0] !== pending.uid) throw new Error('Interaction does not match this browser.');
        if (req.method === 'GET' && (phone || path === base + '/interaction/' + pending.uid)) {
          const route = phone ? base + '/approve' + url.search : base + '/interaction/' + pending.uid;
          const js = browserScript(context.session, `const ROUTE=${JSON.stringify(route)};async function approve(){try{const windows=document.getElementById('windows').value.trim();await post(ROUTE,{action:'approve',scopes:[...document.querySelectorAll('input[name=scope]:checked')].map(i=>i.value),...(windows?{windows:windows.split(',').map(s=>s.trim())}:{})});${phone ? "message.textContent='Approved. Return to the original agent browser.';" : "await finish();"}}catch(e){message.textContent=e.message;}}async function deny(){await post(ROUTE,{action:'deny'});${phone ? "message.textContent='Denied.';" : "await finish();"}}async function finish(){const result=await post(ROUTE+'/finish',{});location.href=result.returnTo;}${phone ? '' : "setInterval(async()=>{try{const r=await fetch(ROUTE+'/status');const state=await r.json();if(state.decided)await finish();}catch{}},1500);fetch(ROUTE+'/qr').then(r=>r.text()).then(svg=>{if(svg.startsWith('<svg'))document.getElementById('qr').innerHTML=svg;});"}`);
          reply(res, 200, page('Approve agent', consentContent(pending, phone, context.session.owner), js), 'text/html'); return true;
        }
        if (!phone && path.endsWith('/status') && req.method === 'GET') { reply(res, 200, { decided: Boolean(pending.grantId || pending.denied) }); return true; }
        if (!phone && path.endsWith('/qr') && req.method === 'GET') {
          const QR = await import('qrcode');
          reply(res, 200, await QR.toString(origin + base + '/approve?code=' + pending.approvalSecret, { type: 'svg', errorCorrectionLevel: 'M' }), 'image/svg+xml'); return true;
        }
        if (!phone && path.endsWith('/finish') && req.method === 'POST') {
          if (!pending.grantId && !pending.denied) throw new Error('Owner decision is pending.');
          const result = pending.denied ? { error: 'access_denied', error_description: 'Owner denied access.' } :
            { login: { accountId: OWNER, remember: false, amr: ['passkey'] }, consent: { grantId: pending.grantId } };
          const returnTo = await provider.interactionResult(req, res, result, { mergeWithLastSubmission: false });
          store.set('finished:' + pending.uid, true, pending.expires);
          store.take('pending:' + pending.uid); store.take('phone:' + digest(pending.approvalSecret)); store.take('phone-code:' + digest(pending.approvalCode));
          reply(res, 200, { returnTo }); return true;
        }
        if (req.method === 'POST') {
          requireOwner(context.session);
          if (input.action === 'approve') await approve(pending, input);
          else if (input.action === 'deny') { pending.denied = true; store.set('pending:' + pending.uid, pending, pending.expires); }
          else throw new Error('Unknown approval action.');
          reply(res, 200, { ok: true }); return true;
        }
        throw new Error('Unsupported interaction request.');
      }
      if (req.method === 'GET' && path === base + '/owner/enroll') { ownerPage(res, true, context); return true; }
      if (req.method === 'GET' && path === base + '/owner/login') { ownerPage(res, false, context); return true; }
      if (req.method === 'GET' && path === base + '/owner') {
        if (!context.session.owner) { ownerPage(res, false, context); return true; }
        const grants = store.db.prepare('SELECT * FROM grants WHERE revoked=0 AND expires>? ORDER BY created DESC').all(Date.now()) as GrantRow[];
        const rows = grants.map(grant => `<li><strong>${html(grant.client_id)}</strong><p>${html(JSON.parse(grant.scopes).join(', '))}</p><small>Expires ${html(new Date(grant.expires).toISOString())}</small><p><button data-id="${html(grant.id)}" onclick="revoke(this.dataset.id)">Revoke agent</button></p></li>`).join('');
        reply(res, 200, page('Agent access', `<ul>${rows || '<li>No approved agents.</li>'}</ul><p><a href="${html(base)}/owner/enroll">Add a second passkey</a></p><details><summary>Approve from an agent approval code</summary><input id="approval-code"><button onclick="location.href=BASE+'/approve?code='+encodeURIComponent(document.getElementById('approval-code').value)">Open request</button></details><details><summary>Create a compatibility token</summary><label>Name<input id="name"></label>${SCOPES.map(scope => `<label><input type="checkbox" name="manual-scope" value="${scope}">${scope}</label>`).join('')}<label>Expires in hours (maximum 24)<input id="hours" type="number" value="1" min="1" max="24"></label><button onclick="manual()">Create token</button><pre id="token"></pre><p>The token is shown once. Store it privately.</p></details><details><summary>Register a client in advance</summary><label>Name<input id="client-name"></label><label>Exact callback URL<input id="redirect"></label><button onclick="registerClient()">Register client</button><pre id="client"></pre></details><button onclick="logout()">Sign out</button>`, browserScript(context.session, `async function revoke(id){await post(BASE+'/owner/revoke',{id});location.reload();}async function manual(){try{const r=await post(BASE+'/owner/token',{name:document.getElementById('name').value,scopes:[...document.querySelectorAll('input[name=manual-scope]:checked')].map(i=>i.value),hours:Number(document.getElementById('hours').value)});document.getElementById('token').textContent=r.token;}catch(e){message.textContent=e.message;}}async function registerClient(){try{const r=await post(BASE+'/owner/clients',{client_name:document.getElementById('client-name').value,redirect_uris:[document.getElementById('redirect').value]});document.getElementById('client').textContent=JSON.stringify(r,null,2);}catch(e){message.textContent=e.message;}}async function logout(){await post(BASE+'/owner/logout',{});location.reload();}`)), 'text/html'); return true;
      }
      requireOwner(context.session);
      if (req.method !== 'POST') throw new Error('Unknown owner route.');
      if (path === base + '/owner/revoke') { if (typeof input.id !== 'string') throw new Error('Grant ID required.'); store.revokeGrant(input.id); reply(res, 200, { ok: true }); }
      else if (path === base + '/owner/logout') { store.take(context.key); res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`); reply(res, 200, { ok: true }); }
      else if (path === base + '/owner/token') {
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 128 || !Array.isArray(input.scopes) || !input.scopes.length || input.scopes.some(scope => !SCOPES.includes(scope as typeof SCOPES[number]))) throw new Error('Token name and valid permissions required.');
        if (typeof input.hours !== 'number' || !Number.isInteger(input.hours) || input.hours < 1 || input.hours > 24) throw new Error('Token lifetime must be 1–24 hours.');
        const id = secret(); const token = secret(); const expires = Date.now() + input.hours * 3600_000;
        store.db.prepare('INSERT INTO grants VALUES(?,?,?,?,?,?,0)').run(id, input.name, JSON.stringify(input.scopes), null, Date.now(), expires);
        store.db.prepare('INSERT INTO manual_tokens VALUES(?,?,?)').run(digest(token), id, expires);
        reply(res, 200, { token, expiresAt: expires });
      } else if (path === base + '/owner/clients') {
        const metadata = normalizeClient(input);
        await store.adapter('Client').upsert(metadata.client_id, metadata, undefined);
        try { if (!await provider.Client.find(metadata.client_id)) throw new Error('Registration failed.'); }
        catch (error) { await store.adapter('Client').destroy(metadata.client_id); throw error; }
        reply(res, 200, metadata);
      } else throw new Error('Unknown owner action.');
      return true;
    } catch (error) {
      if (!res.headersSent) reply(res, error instanceof HubError && error.code === 'RATE_LIMITED' ? 429 : 400, { error: error instanceof Error ? error.message : 'Request denied.' });
      else if (!res.writableEnded) res.end();
      return true;
    }
  }
  const commitOrigin = () => {
    const enrolled = store.get<string>('public-origin');
    if (enrolled && enrolled !== origin) throw new Error('Public hostname changed. Restore the enrolled origin or explicitly migrate owner credentials.');
    store.set('public-origin', origin);
  };
  if (!options.deferOriginCommit) {
    try { commitOrigin(); } catch (error) { store.close(); throw error; }
  }
  return {
    commitOrigin,
    handle,
    async authenticate(req) {
      const url = new URL(req.url ?? '/', origin);
      if (url.searchParams.has('access_token')) throw new HubError('UNAUTHENTICATED', 'Bearer tokens must be sent in the Authorization header.');
      const header = req.headers.authorization;
      if (!header || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(header)) throw new HubError('UNAUTHENTICATED', 'Public access requires a bearer token.');
      try { return await principalForToken(header.slice(7)); } catch { throw new HubError('UNAUTHENTICATED', 'Invalid, expired or revoked bearer token.'); }
    },
    async isAuthorized(principal) {
      if (!principal.token) return false;
      try { const current = await principalForToken(principal.token); return current.id === principal.id && current.scopes.length === principal.scopes.length && current.scopes.every(scope => principal.scopes.includes(scope)); } catch { return false; }
    },
    async enrollmentLink() {
      const code = secret(); store.set('bootstrap:' + digest(code), { generation: generation() }, Date.now() + 10 * 60_000);
      return origin + base + '/owner/enroll?code=' + code;
    },
    async close() { store.close(); },
  };
}

/** Local CLI pre-registration; never reachable through the unauthenticated agent listener. */
export async function registerPublicClient(config: HubConfig, metadata: Record<string, unknown>) {
  const normalized = normalizeClient(metadata);
  const store = await openStore(config.stateDir);
  try { await store.adapter('Client').upsert(normalized.client_id, normalized, undefined); return normalized; }
  finally { store.close(); }
}
