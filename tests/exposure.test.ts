import test from 'node:test';
import assert from 'node:assert/strict';
import { exposeTailnet, funnelMappings, tailscaleIdentity } from '../packages/hub/src/exposure.js';
const config = { stateDir: '/tmp/unused', trustedPort: 4040, satellitePort: 3002, publicPort: 3003, publicUrl: 'https://host.tailnet.ts.net/tabby/mcp' };
const identity = { hosts: ['host.tailnet.ts.net'], dnsName: 'host.tailnet.ts.net', ip: '100.64.1.2' };
test('Funnel maps public listener and prefixed origin metadata; private Serve routes are preserved', () => {
  const mappings = funnelMappings(config, identity, {});
  assert.equal(mappings.length, 4);
  assert.equal(mappings[0].at(-1), 'http://127.0.0.1:3003/tabby');
  assert.match(mappings[1].at(-1)!, /well-known\/oauth-protected-resource\/tabby\/mcp/);
  assert.ok(mappings.every(mapping => !mapping.some(arg => arg.includes('4040') || arg.includes('3002'))));
  assert.throws(() => funnelMappings(config, identity, { TCP: { 443: { HTTPS: true } }, Web: { 'host.tailnet.ts.net:443': { Handlers: { '/private': { Proxy: 'http://127.0.0.1:9999' } } } } }));
});
test('direct Tailnet forwards only trusted agent port and rejects conflicting service', async () => {
  const commands: string[][] = [];
  const execute = async (args: string[]) => {
    commands.push(args);
    if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { Online: true, DNSName: 'host.tailnet.ts.net.' }, TailscaleIPs: ['100.64.1.2'] });
    return '{}';
  };
  await exposeTailnet(config, execute);
  assert.deepEqual(commands.at(-1), ['serve', '--bg', '--tcp=4040', 'tcp://127.0.0.1:4040']);
  await assert.rejects(exposeTailnet(config, async args => args[0] === 'status' ? await execute(args) : JSON.stringify({ TCP: { 4040: { TCPForward: '127.0.0.1:9999' } } })), /another service/);
});
test('Tailnet identities match URL hostname forms while keeping endpoint IPs raw', async () => {
  for (const ips of [['fd7a::1'], ['100.64.1.2', 'fd7a::1']]) {
    const identity = await tailscaleIdentity(async () => JSON.stringify({ BackendState: 'Running', Self: { Online: true, DNSName: 'host.tailnet.ts.net.' }, TailscaleIPs: ips }));
    for (const ip of ips) assert.ok(identity.hosts.includes(new URL(`http://${ip.includes(':') ? `[${ip}]` : ip}:4040/mcp`).hostname));
    assert.equal(identity.ip, ips[0]);
  }
});
