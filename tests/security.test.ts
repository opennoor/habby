import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, request } from 'node:https';
import { once } from 'node:events';
import vm from 'node:vm';
import ts from 'typescript';
import selfsigned from 'selfsigned';
import { publicAddress } from '../packages/hub/src/auth/security.ts';

test('metadata address validation separates public IPv4 from blocked IPv6 mapped addresses', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '192.0.2.1', '::1', '::ffff:8.8.8.8', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1'])
    assert.equal(publicAddress(address), false, address);
});

test('metadata DNS pinning uses a scalar lookup with native Node TLS address selection', async t => {
  const certificate = await selfsigned.generate([{ name: 'commonName', value: 'metadata.example' }], {
    days: 1, keySize: 2048, extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'metadata.example' }] }],
  });
  const server = createServer({ key: certificate.private, cert: certificate.cert }, (req, res) => {
    assert.equal(req.headers.host, 'metadata.example');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"client_name":"local fixture"}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as any).port;
  const source = readFileSync(new URL('../packages/hub/src/auth/security.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as any }, require = createRequire(import.meta.url);
  let lookups = 0, connects = 0;
  const injected: Record<string, unknown> = {
    'node:dns/promises': { lookup: async (host: string) => {
      assert.equal(host, 'metadata.example'); lookups++;
      return [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }];
    } },
    'node:https': { request: (url: URL, options: any, callback: any) => {
      assert.equal(url.hostname, 'metadata.example'); assert.equal(options.rejectUnauthorized, true);
      // Only the test's connection address/CA change; Node's real family-selection and TLS paths run.
      return request(url, { ...options, port, ca: certificate.cert, agent: false, autoSelectFamily: true,
        headers: { ...options.headers, host: url.hostname },
        lookup: (host: string, lookupOptions: any, done: any) => options.lookup(host, lookupOptions,
          (error: Error | null, address: string, family: number) => {
            assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); connects++;
            done(null, '127.0.0.1', family);
          }),
      }, callback);
    } },
  };
  vm.runInNewContext(output, { module, exports: module.exports, require: (name: string) => injected[name] ?? require(name),
    URL, Headers, Response, Buffer, AbortSignal, setTimeout, clearTimeout });
  const response = await module.exports.safeMetadataFetch('https://metadata.example/client.json');
  assert.deepEqual(await response.json(), { client_name: 'local fixture' });
  assert.equal(lookups, 1); assert.equal(connects, 1);
});
