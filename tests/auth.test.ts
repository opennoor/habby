import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createPublicAuth } from '../packages/hub/src/auth.js';

test('public authentication publishes configured prefix discovery and refuses loopback bearer bypass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabby-auth-'));
  const auth = await createPublicAuth({ stateDir: dir, trustedPort: 0, satellitePort: 0, publicPort: 0,
    publicUrl: 'https://hub.example/tabby/mcp' });
  const server = createServer((req, res) => void auth.handle(req, res).then(async handled => {
    if (!handled) { try { await auth.authenticate(req); res.end('ok'); } catch { res.writeHead(401); res.end(); } }
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const metadata = await (await fetch(base + '/.well-known/oauth-protected-resource/tabby/mcp')).json();
    assert.equal(metadata.resource, 'https://hub.example/tabby/mcp');
    assert.deepEqual(metadata.authorization_servers, ['https://hub.example/tabby/oauth']);
    const discovery = await (await fetch(base + '/.well-known/oauth-authorization-server/tabby/oauth')).json();
    assert.equal(discovery.issuer, 'https://hub.example/tabby/oauth');
    assert.equal(discovery.authorization_endpoint, 'https://hub.example/tabby/oauth/auth');
    assert.equal(discovery.token_endpoint, 'https://hub.example/tabby/oauth/token');
    assert.equal(discovery.client_id_metadata_document_supported, true);
    assert.deepEqual(discovery.code_challenge_methods_supported, ['S256']);
    assert.equal((await fetch(base + '/mcp')).status, 401);
    const link = new URL(await auth.enrollmentLink());
    assert.equal(link.origin, 'https://hub.example');
    assert.equal(link.pathname, '/tabby/owner/enroll');
    assert(link.searchParams.get('code'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await auth.close(); await rm(dir, { recursive: true, force: true }); }
});

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { registerPublicClient } from '../packages/hub/src/auth.js';
import { digest } from '../packages/hub/src/auth/store.js';
import { publicAddress, safeMetadataFetch } from '../packages/hub/src/auth/security.js';

const HASH = (value: Uint8Array | string) => createHash('sha256').update(value).digest();
const ORIGIN = 'https://hub.example';
const RESOURCE = ORIGIN + '/tabby/mcp';
function cbor(value: string | Buffer | Map<unknown, unknown>): Buffer {
  const length = (major: number, n: number) => n < 24 ? Buffer.from([major << 5 | n]) : n < 256 ? Buffer.from([major << 5 | 24,n]) : Buffer.from([major << 5 | 25,n >> 8,n & 255]);
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([length(3,bytes.length),bytes]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([length(2,value.length),value]);
  return Buffer.concat([length(5,value.size), ...[...value].flatMap(([key,v]) => [cbor(key as string),cbor(v as Buffer)])]);
}
function syntheticPasskey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const id = randomBytes(32);
  const cose = Buffer.concat([Buffer.from('a5010203262001215820','hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820','hex'), Buffer.from(jwk.y!, 'base64url')]);
  let counter = 0;
  return {
    id: id.toString('base64url'),
    registration(challenge: string, origin = ORIGIN) {
      const client = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
      const authData = Buffer.concat([HASH('hub.example'), Buffer.from([0x45,0,0,0,0]), Buffer.alloc(16), Buffer.from([0,id.length]), id, cose]);
      const attestation = cbor(new Map([['fmt','none'],['authData',authData],['attStmt',new Map()]]));
      return { id: id.toString('base64url'), rawId: id.toString('base64url'), type: 'public-key', response: { clientDataJSON: client.toString('base64url'), attestationObject: attestation.toString('base64url'), transports: ['internal'] }, clientExtensionResults: {} };
    },
    authentication(challenge: string, origin = ORIGIN) {
      const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const count = Buffer.alloc(4); count.writeUInt32BE(++counter);
      const authData = Buffer.concat([HASH('hub.example'), Buffer.from([0x05]), count]);
      const signature = sign('sha256', Buffer.concat([authData,HASH(client)]), privateKey);
      return { id: id.toString('base64url'), rawId: id.toString('base64url'), type: 'public-key', response: { clientDataJSON: client.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url'), userHandle: Buffer.from('owner').toString('base64url') }, clientExtensionResults: {} };
    },
  };
}
async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'tabby-auth-'));
  const config = { stateDir, trustedPort: 0, satellitePort: 0, publicPort: 0, publicUrl: RESOURCE };
  let auth = await createPublicAuth(config);
  const server = createServer((req,res) => void auth.handle(req,res).then(async handled => {
    if (handled) return;
    try { const principal = await auth.authenticate(req); res.end(JSON.stringify(principal)); }
    catch (error) { res.writeHead(401); res.end(JSON.stringify({ error: String(error) })); }
  }));
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  function browser() {
    const jar = new Map<string,string>();
    return {
      async request(path: string, init: RequestInit = {}) {
        const url = path.startsWith(ORIGIN) ? path.slice(ORIGIN.length) : path;
        const headers = new Headers(init.headers);
        if (jar.size) headers.set('cookie',[...jar].map(([key,value])=>key+'='+value).join('; '));
        const result = await fetch(base+url,{ ...init, headers, redirect:'manual' });
        for (const cookie of result.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const idx=pair.indexOf('='); jar.set(pair.slice(0,idx),pair.slice(idx+1)); }
        return result;
      },
      post(path: string, body: unknown, csrf: string) { return this.request(path,{ method:'POST',headers:{ 'content-type':'application/json',origin:ORIGIN },body:JSON.stringify({ ...(body as object),csrf }) }); },
    };
  }
  async function csrf(browserClient: ReturnType<typeof browser>, path = '/tabby/owner/login') {
    const result=await browserClient.request(path); const body=await result.text();
    const match=/const CSRF="([^"]+)"/.exec(body); assert(match,body); return match[1];
  }
  async function enroll(client: ReturnType<typeof browser>, key = syntheticPasskey()) {
    const link=await auth.enrollmentLink();
    const result=await client.request(link); assert.equal(result.status,303,await result.text());
    const token=await csrf(client,'/tabby/owner/enroll');
    const opts=await (await client.post('/tabby/owner/register/options',{},token)).json(); assert(opts.challenge);
    const registered=await client.post('/tabby/owner/register/verify',{response:key.registration(opts.challenge)},token);
    assert.equal(registered.status,200,await registered.clone().text());
    return { key, csrf:token, link, registration:await registered.json() };
  }
  return { config, base, browser, csrf, enroll, server, get auth(){ return auth; }, async restart(){ await auth.close(); auth=await createPublicAuth(config); },
    async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await auth.close();await rm(stateDir,{recursive:true,force:true});} };
}

test('owner recovery replaces old passkeys rather than re-enabling a lost key', async () => {
  const f = await fixture();
  try {
    const owner = f.browser(); const initial = await f.enroll(owner);
    const recovered = await owner.post('/tabby/owner/recover', { code: initial.registration.recoveryCodes[0] }, initial.csrf);
    assert.equal(recovered.status, 200);
    const replacement = syntheticPasskey(); const csrf = await f.csrf(owner, '/tabby/owner/enroll');
    const options = await (await owner.post('/tabby/owner/register/options', {}, csrf)).json();
    const registration = await owner.post('/tabby/owner/register/verify', { response: replacement.registration(options.challenge) }, csrf);
    assert.equal(registration.status, 200, await registration.clone().text());
    const stale = f.browser(); const staleCsrf = await f.csrf(stale);
    const authentication = await (await stale.post('/tabby/owner/authenticate/options', {}, staleCsrf)).json();
    assert(!authentication.allowCredentials.some((credential: { id: string }) => credential.id === initial.key.id));
    const denied = await stale.post('/tabby/owner/authenticate/verify', {
      response: initial.key.authentication(authentication.challenge),
    }, staleCsrf);
    assert.equal(denied.status, 400);
    const nextOptions = await (await stale.post('/tabby/owner/authenticate/options', {}, staleCsrf)).json();
    const allowed = await stale.post('/tabby/owner/authenticate/verify', {
      response: replacement.authentication(nextOptions.challenge),
    }, staleCsrf);
    assert.equal(allowed.status, 200, await allowed.clone().text());
  } finally { await f.close(); }
});

test('owner recovery rejects an already-started request from the old browser session', async () => {
  const f = await fixture();
  try {
    const owner = f.browser(); const initial = await f.enroll(owner);
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const started = new Promise<void>(resolve => f.server.once('request', req => req.once('data', () => resolve())));
    const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; controller.enqueue(Buffer.from('{')); } });
    const pending = owner.request('/tabby/owner/token', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN }, body: stream, duplex: 'half',
    } as RequestInit);
    await started;
    assert.equal((await owner.post('/tabby/owner/recover', { code: initial.registration.recoveryCodes[0] }, initial.csrf)).status, 200);
    const csrf = await f.csrf(owner, '/tabby/owner/enroll');
    const options = await (await owner.post('/tabby/owner/register/options', {}, csrf)).json();
    assert.equal((await owner.post('/tabby/owner/register/verify', { response: syntheticPasskey().registration(options.challenge) }, csrf)).status, 200);
    body.enqueue(Buffer.from(JSON.stringify({ csrf: initial.csrf, name: 'stale', scopes: ['terminal:write'], hours: 1 }).slice(1)));
    body.close();
    assert.equal((await pending).status, 400);
    const db = new DatabaseSync(join(f.config.stateDir, 'auth.sqlite'));
    try { assert.equal((db.prepare("SELECT count(*) AS n FROM grants WHERE client_id='stale'").get() as any).n, 0); }
    finally { db.close(); }
  } finally { await f.close(); }
});

test('one-use enrollment uses real passkey verification, enforces CSRF/origin, and persists credentials', async () => {
  const f=await fixture();
  try {
    const owner=f.browser(); const enrolled=await f.enroll(owner);
    assert.equal(enrolled.registration.recoveryCodes.length,8);
    assert.equal((await f.browser().request(enrolled.link)).status,400);
    assert.equal((await owner.post('/tabby/owner/register/options',{},'wrong')).status,400);
    assert.equal((await owner.request('/tabby/owner/register/options',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:JSON.stringify({csrf:enrolled.csrf})})).status,403);
    await f.restart();
    const fresh=f.browser(); const csrf=await f.csrf(fresh);
    const opts=await (await fresh.post('/tabby/owner/authenticate/options',{},csrf)).json();
    assert.equal(opts.allowCredentials[0].id,enrolled.key.id);
    const bad=await fresh.post('/tabby/owner/authenticate/verify',{response:enrolled.key.authentication(opts.challenge,'https://evil.example')},csrf);
    assert.equal(bad.status,400);
    assert.equal((await fresh.post('/tabby/owner/authenticate/verify',{response:enrolled.key.authentication(opts.challenge)},csrf)).status,400,'failed challenge must also be consumed');
    const retry=await (await fresh.post('/tabby/owner/authenticate/options',{},csrf)).json();
    const login=await fresh.post('/tabby/owner/authenticate/verify',{response:enrolled.key.authentication(retry.challenge)},csrf);
    assert.equal(login.status,200,await login.text());
    const db=new DatabaseSync(join(f.config.stateDir,'auth.sqlite'));
    const row=db.prepare('SELECT counter FROM credentials WHERE id=?').get(enrolled.key.id);assert.equal(row?.counter,3);db.close();
  } finally {await f.close();}
});

test('real OAuth PKCE code flow binds resource and phone approval to original browser, rotates and revokes persisted tokens', async () => {
  const f=await fixture();
  try {
    const phone=f.browser(); const enrollment=await f.enroll(phone);
    const registration=await phone.request('/oauth/reg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Desktop agent',redirect_uris:['http://localhost:49152/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
    assert.equal(registration.status,201,await registration.clone().text());
    const client=await registration.json();
    const verifier=randomBytes(48).toString('base64url');
    const challenge=HASH(verifier).toString('base64url');
    const params=new URLSearchParams({client_id:client.client_id,redirect_uri:client.redirect_uris[0],response_type:'code',scope:'terminal:read terminal:write',resource:RESOURCE,code_challenge:challenge,code_challenge_method:'S256',state:'desktop-bound'});
    const desktop=f.browser();
    const noPKCE=new URLSearchParams(params);noPKCE.delete('code_challenge');
    const invalid=await desktop.request('/oauth/auth?'+noPKCE);assert.equal(invalid.status,303);assert(new URL(invalid.headers.get('location')!).searchParams.get('error'));
    const noResource=new URLSearchParams(params);noResource.delete('resource');assert.equal((await desktop.request('/oauth/auth?'+noResource)).status,400);
    const start=await desktop.request('/oauth/auth?'+params);assert.equal(start.status,303,await start.text());
    const interaction=start.headers.get('location')!;assert(interaction.startsWith(ORIGIN+'/tabby/interaction/'),interaction);
    const consent=await desktop.request(interaction);const content=await consent.text();assert.equal(consent.status,200,content);
    const desktopCSRF=/const CSRF="([^"]+)"/.exec(content)![1];
    const approval=content.match(/href="(\/tabby\/approve\?code=[^"]+)"/)![1];
    const qr=await desktop.request(interaction+'/qr');assert.equal(qr.status,200);assert((await qr.text()).includes('<svg'));
    const stolen=f.browser();assert.equal((await stolen.post(interaction+'/finish',{},desktopCSRF)).status,400);
    const window='11111111-1111-4111-8111-111111111111';
    const approved=await phone.post(approval,{action:'approve',scopes:['terminal:read'],windows:[window]},enrollment.csrf);assert.equal(approved.status,200,await approved.text());
    const db = new DatabaseSync(join(f.config.stateDir, 'auth.sqlite'));
    assert.equal(db.prepare("SELECT expires FROM oauth WHERE model='Client' AND key=?").get(digest(client.client_id))?.expires, null);
    db.close();
    assert.equal((await phone.post(approval,{action:'approve',scopes:['terminal:write']},enrollment.csrf)).status,400);
    const status=await (await desktop.request(interaction+'/status')).json();assert.equal(status.decided,true);
    const finish=await desktop.post(interaction+'/finish',{},desktopCSRF);assert.equal(finish.status,200,await finish.clone().text());
    assert.equal((await desktop.post(interaction+'/finish',{},desktopCSRF)).status,400);
    let returned=await desktop.request((await finish.json()).returnTo);
    for(let i=0;i<5&&returned.status===303;i++){
      const location=returned.headers.get('location')!;
      if(location.startsWith('http://localhost:49152/'))break;
      returned=await desktop.request(location);
    }
    assert(returned.headers.get('location'), `resume status ${returned.status}: ${await returned.clone().text()}`);
    const callback=new URL(returned.headers.get('location')!);assert.equal(callback.origin,'http://localhost:49152');assert.equal(callback.searchParams.get('state'),'desktop-bound');
    assert(callback.searchParams.get('code'),callback.href);
    const tokenParameters=new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:callback.searchParams.get('code')!,redirect_uri:client.redirect_uris[0],code_verifier:verifier,resource:RESOURCE});
    const missing=new URLSearchParams(tokenParameters);missing.delete('resource');assert.equal((await desktop.request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:missing})).status,400);
    const wrongVerifier=new URLSearchParams(tokenParameters);wrongVerifier.set('code_verifier',randomBytes(48).toString('base64url'));
    assert.equal((await desktop.request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:wrongVerifier})).status,400);
    const wrongResource=new URLSearchParams(tokenParameters);wrongResource.set('resource','https://other.example/mcp');
    assert.equal((await desktop.request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:wrongResource})).status,400);
    const tokenResponse=await desktop.request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:tokenParameters});
    assert.equal(tokenResponse.status,200,await tokenResponse.clone().text());
    const token=await tokenResponse.json();assert.equal(token.token_type,'Bearer');assert.equal(token.scope,'terminal:read');assert(token.refresh_token);
    const access=await desktop.request('/mcp',{headers:{authorization:'Bearer '+token.access_token}});assert.equal(access.status,200,await access.clone().text());
    const principal=await access.json();assert.deepEqual(principal.windows,[window]);assert.deepEqual(principal.scopes,['terminal:read']);assert(await f.auth.isAuthorized(principal));
    await f.restart();assert(await f.auth.isAuthorized(principal));
    const refresh=new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,refresh_token:token.refresh_token,resource:RESOURCE});
    const refreshed=await desktop.request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:refresh});assert.equal(refreshed.status,200,await refreshed.clone().text());
    const rotated=await refreshed.json();assert.notEqual(rotated.refresh_token,token.refresh_token);
    const revoke=await phone.post('/owner/revoke',{id:principal.id},enrollment.csrf);assert.equal(revoke.status,200,await revoke.text());
    assert.equal(await f.auth.isAuthorized(principal),false);
    assert.equal((await desktop.request('/mcp',{headers:{authorization:'Bearer '+rotated.access_token}})).status,401);
    assert.equal((await desktop.request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:refresh})).status,400);
  } finally {await f.close();}
});

test('anonymous browser floods are bounded across routes without evicting owners or enrollment', async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.config.stateDir, 'auth.sqlite'));
  try {
    const owner = f.browser(); await f.enroll(owner);
    const enrolling = f.browser();
    assert.equal((await enrolling.request(await f.auth.enrollmentLink())).status, 303);
    const enrollCsrf = await f.csrf(enrolling, '/owner/enroll');
    assert.equal((await enrolling.post('/owner/register/options', {}, enrollCsrf)).status, 200);
    const protectedRows = db.prepare("SELECT key,value FROM owner_state WHERE key LIKE 'session:%'").all();
    assert.equal(protectedRows.length, 2);
    const insert = db.prepare('INSERT INTO owner_state VALUES(?,?,?)');
    for (let index = 0; index < 300; index++) {
      const key = 'session:flood-' + String(index).padStart(3, '0');
      insert.run(key, JSON.stringify({ owner: false, enroll: false, csrf: 'unused', generation: 0 }), Date.now() + 60_000 + index);
      insert.run('challenge:' + key, '{"kind":"authenticate","value":"unused"}', Date.now() + 60_000);
    }
    await f.restart();
    const returning = f.browser(); assert.equal((await returning.request('/owner/login')).status, 200, 'a legacy anonymous surplus must not lock out a new device');
    for (let index = 0; index < 35; index++) assert.equal((await returning.request('/owner/login')).status, 200, 'valid cookie must bypass fresh-session limits');
    const routes = ['/owner/login', '/owner/unknown', '/interaction/missing', '/approve?code=missing'];
    let rateLimited = 0;
    for (let index = 0; index < 35; index++) {
      const response = await f.browser().request(routes[index % routes.length]);
      if (response.status === 429) { rateLimited++; assert.equal(response.headers.get('set-cookie'), null); }
      else assert.ok([200, 400].includes(response.status), await response.clone().text());
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM owner_state WHERE key LIKE 'session:%'").get()?.n, 256);
    }
    assert.ok(rateLimited > 0, 'fresh anonymous HTTP sessions must be rate limited');
    for (const row of protectedRows) assert.equal(db.prepare('SELECT value FROM owner_state WHERE key=?').get(row.key)?.value, row.value);
    assert.ok(db.prepare("SELECT value FROM owner_state WHERE key LIKE 'challenge:session:%' AND json_extract(value,'$.kind')='register'").get(), 'enrollment challenge must survive');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM owner_state WHERE key LIKE 'challenge:session:%' AND NOT EXISTS (SELECT 1 FROM owner_state AS sessions WHERE sessions.key=substr(owner_state.key,11))").get()?.n, 0);
    assert.equal((await owner.request('/owner')).status, 200);
    assert.equal((await enrolling.request('/owner/enroll')).status, 200);
  } finally { db.close(); await f.close(); }
});

test('rate-limited enrollment preserves its one-use link for an existing browser', async () => {
  const f = await fixture();
  try {
    const returning = f.browser(); assert.equal((await returning.request('/owner/login')).status, 200);
    for (let index = 0; index < 29; index++) assert.equal((await f.browser().request('/owner/login')).status, 200);
    const link = await f.auth.enrollmentLink();
    assert.equal((await f.browser().request(link)).status, 429);
    assert.equal((await returning.request(link)).status, 303, 'creation rejection must not consume the enrollment link');
    assert.equal((await returning.request('/owner/enroll')).status, 200);
    assert.equal((await returning.request(link)).status, 400, 'successful enrollment still consumes the link exactly once');
  } finally { await f.close(); }
});

test('anonymous client floods remain bounded and reclaim capacity without removing approved or local clients', async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.config.stateDir, 'auth.sqlite'));
  try {
    const local = await registerPublicClient(f.config, { client_name: 'Local', redirect_uris: ['http://localhost:4567/callback'] });
    const issued = Math.floor(Date.now() / 1000);
    const metadata = (id: string, time = issued) => ({ client_id: id, client_id_issued_at: time, client_name: id,
      redirect_uris: ['http://localhost:4567/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    const insert = db.prepare("INSERT INTO oauth VALUES('Client',?,?,NULL,NULL,NULL,NULL)");
    insert.run(digest('approved'), JSON.stringify(metadata('approved', issued - 7200)));
    db.prepare('INSERT INTO grants VALUES(?,?,?,?,?,?,0)').run('approved-grant', 'approved', '["terminal:read"]', null, Date.now(), Date.now() + 86400000);
    for (let index = 0; index < 254; index++) insert.run(digest('flood-' + index), JSON.stringify(metadata('flood-' + index)));
    const agent = f.browser();
    for (let index = 0; index < 8; index++) {
      const response = await agent.request('/oauth/reg', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Legitimate ' + index, redirect_uris: ['http://localhost:4567/callback'] }) });
      assert.equal(response.status, 201, await response.clone().text());
      const client = await response.json();
      assert.equal(db.prepare("SELECT expires FROM oauth WHERE model='Client' AND key=?").get(digest(client.client_id))?.expires, (client.client_id_issued_at + 3600) * 1000);
      assert.equal(db.prepare("SELECT count(*) AS n FROM oauth WHERE model='Client'").get()?.n, 256);
      for (const id of [local.client_id, 'approved']) assert.ok(db.prepare("SELECT key FROM oauth WHERE model='Client' AND key=?").get(digest(id)));
    }
    db.prepare("UPDATE oauth SET expires=NULL,payload=json_set(payload,'$.client_id_issued_at',CAST(? AS INTEGER)) WHERE model='Client' AND key NOT IN (?,?)").run(issued - 7200, digest(local.client_id), digest('approved'));
    await f.restart();
    assert.equal(db.prepare("SELECT count(*) AS n FROM oauth WHERE model='Client'").get()?.n, 2, 'expired legacy anonymous rows must be reclaimed across restart');
    assert.equal(db.prepare("SELECT expires FROM oauth WHERE model='Client' AND key=?").get(digest('approved'))?.expires, null);
    assert.equal(db.prepare("SELECT expires FROM oauth WHERE model='Client' AND key=?").get(digest(local.client_id))?.expires, null);
  } finally { db.close(); await f.close(); }
});

test('manual tokens and local pre-registration persist while SSRF and invalid redirects fail closed',async()=>{
  const f=await fixture();
  try{
    const owner=f.browser();const enrollment=await f.enroll(owner);
    const response=await owner.post('/owner/token',{name:'Headless test',hours:1,scopes:['files:read']},enrollment.csrf);assert.equal(response.status,200);
    const token=await response.json();
    await f.restart();const access=await owner.request('/mcp',{headers:{authorization:'Bearer '+token.token}});assert.equal(access.status,200);const principal=await access.json();assert.deepEqual(principal.scopes,['files:read']);
    const bad=await owner.request('/oauth/reg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:['http://evil.example/callback']})});assert.equal(bad.status,400);
    const pre=await registerPublicClient(f.config,{client_name:'Pre-registered',redirect_uris:['http://localhost:4567/callback']});assert(pre.client_id);
    await f.restart();
    assert.equal((await owner.request('/mcp?access_token='+token.token)).status,401);
    assert.equal((await owner.request('/mcp',{headers:{authorization:'Bearer '+randomBytes(32).toString('base64url')}})).status,401);
    const db=new DatabaseSync(join(f.config.stateDir,'auth.sqlite'));const stored=db.prepare('SELECT payload FROM oauth WHERE model=\'Client\' AND key=?').get(digest(pre.client_id));assert(stored);const tokenRow=db.prepare('SELECT hash FROM manual_tokens').get();assert.equal(tokenRow?.hash,digest(token.token));db.close();
    assert.equal(publicAddress('127.0.0.1'),false);assert.equal(publicAddress('100.64.0.1'),false);assert.equal(publicAddress('::ffff:127.0.0.1'),false);assert.equal(publicAddress('169.254.169.254'),false);assert.equal(publicAddress('2001:db8::1'),false);
    await assert.rejects(safeMetadataFetch('https://127.0.0.1/metadata'));await assert.rejects(safeMetadataFetch('http://example.com/metadata'));
    const recover=await owner.post('/owner/recover',{code:enrollment.registration.recoveryCodes[0]},enrollment.csrf);assert.equal(recover.status,200);assert.equal(await f.auth.isAuthorized(principal),false);
    const newCsrf=await f.csrf(owner,'/owner/enroll');assert.equal((await owner.post('/owner/recover',{code:enrollment.registration.recoveryCodes[0]},newCsrf)).status,400);
  }finally{await f.close();}
});

test('refresh-token reuse revokes its family and resource-server verification rejects wrong audiences and expiry',async()=>{
  const f=await fixture();
  try{
    const owner=f.browser();const enrollment=await f.enroll(owner);
    const client=await registerPublicClient(f.config,{client_name:'Replay test',redirect_uris:['http://localhost:4200/callback']});
    const desktop=f.browser();const verifier=randomBytes(48).toString('base64url');
    const params=new URLSearchParams({client_id:client.client_id,redirect_uri:client.redirect_uris[0],response_type:'code',scope:'terminal:read',resource:RESOURCE,code_challenge:HASH(verifier).toString('base64url'),code_challenge_method:'S256'});
    const start=await desktop.request('/oauth/auth?'+params);assert.equal(start.status,303);const interaction=start.headers.get('location')!;
    const consent=await (await desktop.request(interaction)).text();const csrf=/const CSRF="([^"]+)"/.exec(consent)![1];const approval=consent.match(/href="(\/tabby\/approve\?code=[^"]+)"/)![1];
    assert.equal((await owner.post(approval,{action:'approve',scopes:['terminal:read']},enrollment.csrf)).status,200);
    const finish=await (await desktop.post(interaction+'/finish',{},csrf)).json();const redirect=await desktop.request(finish.returnTo);const callback=new URL(redirect.headers.get('location')!);assert(callback.searchParams.get('code'));
    const original=await (await desktop.request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:callback.searchParams.get('code')!,redirect_uri:client.redirect_uris[0],code_verifier:verifier,resource:RESOURCE})})).json();assert(original.refresh_token);
    const refresh=new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,refresh_token:original.refresh_token,resource:RESOURCE});
    const rotated=await (await desktop.request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:refresh})).json();assert(rotated.access_token);
    const access=await desktop.request('/mcp',{headers:{authorization:'Bearer '+rotated.access_token}});assert.equal(access.status,200);const principal=await access.json();assert(await f.auth.isAuthorized(principal));
    assert.equal((await desktop.request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:refresh})).status,400);
    assert.equal(await f.auth.isAuthorized(principal),false,'reuse must revoke newly issued family access tokens');
    assert.equal((await desktop.request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,refresh_token:rotated.refresh_token,resource:RESOURCE})})).status,400);
    const db=new DatabaseSync(join(f.config.stateDir,'auth.sqlite'));
    const grant='fixture-grant';const now=Date.now();db.prepare('INSERT INTO grants VALUES(?,?,?,?,?,?,0)').run(grant,'fixture-client',JSON.stringify(['terminal:read']),null,now,now+60_000);
    const token=randomBytes(32).toString('base64url');const payload={kind:'AccessToken',accountId:'owner',clientId:client.client_id,grantId:grant,scope:'terminal:read',aud:'https://wrong.example/mcp',iat:Math.floor(now/1000),exp:Math.floor(now/1000)+60};
    db.prepare('INSERT INTO oauth VALUES(?,?,?,?,?,?,?)').run('AccessToken',digest(token),JSON.stringify(payload),now+60_000,grant,null,null);
    assert.equal((await desktop.request('/mcp',{headers:{authorization:'Bearer '+token}})).status,401);
    payload.aud=RESOURCE;db.prepare('UPDATE oauth SET payload=? WHERE key=?').run(JSON.stringify(payload),digest(token));assert.equal((await desktop.request('/mcp',{headers:{authorization:'Bearer '+token}})).status,200);
    payload.exp=Math.floor(now/1000)-60;db.prepare('UPDATE oauth SET payload=? WHERE key=?').run(JSON.stringify(payload),digest(token));assert.equal((await desktop.request('/mcp',{headers:{authorization:'Bearer '+token}})).status,401);db.close();
  }finally{await f.close();}
});
