import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.31.196.0',24],['192.52.193.0',24],['192.88.99.0',24],['192.168.0.0',16],['192.175.48.0',24],['198.18.0.0',15],['198.51.100.0',24],
  ['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::',128],['::1',128],['::ffff:0:0',96],['64:ff9b::',96],['64:ff9b:1::',48],
  ['100::',64],['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20],['fc00::',7],['fe80::',10],['ff00::',8]] as const) blocked.addSubnet(address,prefix,'ipv6');
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  if (family === 6 && !/^[23][0-9a-f]{3}:/i.test(address)) return false;
  return !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** Pin a public DNS result into the actual TLS connection, eliminating DNS rebinding and redirects. */
export async function safeMetadataFetch(input: string | URL, options?: RequestInit): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new Error('Metadata URL must use public HTTPS port 443.');
  if (options?.method && options.method !== 'GET') throw new Error('Only metadata GET is supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let dnsTimeout: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([lookup(host, { all: true }), new Promise<never>((_resolve, reject) => {
    dnsTimeout = setTimeout(() => reject(new Error('Metadata DNS lookup timed out.')), 2500);
  })]).finally(() => clearTimeout(dnsTimeout));
  if (!addresses.length || addresses.some(record => !publicAddress(record.address))) throw new Error('Metadata hostname is not public.');
  const address = addresses[0];
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: 'GET', headers: { accept: 'application/json' },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      signal: AbortSignal.timeout(2500), rejectUnauthorized: true,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('Metadata redirects and non-200 responses are forbidden.')); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 64 * 1024) { req.destroy(new Error('Metadata body too large.')); } else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        if (size > 64 * 1024) return;
        const headers = new Headers();
        for (const key of ['content-type','cache-control','expires']) if (typeof res.headers[key] === 'string') headers.set(key, res.headers[key]);
        resolve(new Response(Buffer.concat(chunks), { status: 200, headers }));
      });
    });
    req.on('error', reject); req.end();
  });
}

export async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON content type required.');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) throw new Error('Request too large.'); chunks.push(Buffer.from(chunk)); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required.');
  return value as Record<string, unknown>;
}
export function redirectAllowed(uri: string) {
  try { const url = new URL(uri); return !url.username && !url.password && !url.hash &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))); }
  catch { return false; }
}
