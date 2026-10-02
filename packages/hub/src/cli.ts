#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { access } from 'node:fs/promises';
import { defaultStateDir } from '../../../shared/paths.js';
import { MAX_FRAME_BYTES, type HubConfig } from '../../../shared/protocol.js';
import { initializeState, readConfig } from './state.js';
import { startHub } from './hub.js';
import { installHub, uninstallHub, doctor } from './install.js';
import { runBridge } from './bridge.js';
import { exposeTailnet, exposeFunnel } from './exposure.js';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'state-dir': { type: 'string' }, 'plugin-dir': { type: 'string' },
    'trusted-port': { type: 'string' }, 'satellite-port': { type: 'string' }, 'public-port': { type: 'string' },
    'public-url': { type: 'string' }, url: { type: 'string' }, name: { type: 'string' },
    redirect: { type: 'string', multiple: true }, 'no-start': { type: 'boolean' },
    purge: { type: 'boolean' }, funnel: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const [command = 'start', subcommand] = positionals;
  if (values.help || command === 'help') { process.stdout.write(help); return; }
  const stateDir = resolve(values['state-dir'] ?? defaultStateDir());
  if (command === 'bridge') {
    let url = values.url;
    if (!url) { const config = await readConfig(stateDir); url = `http://127.0.0.1:${config.trustedPort}/mcp`; }
    await runBridge(url, { token: process.env.TABBY_HUB_TOKEN }); return;
  }
  if (command === 'uninstall') {
    const config = await readConfig(stateDir);
    print(await uninstallHub(config, { pluginDir: values['plugin-dir'], purge: values.purge })); return;
  }
  if (command === 'doctor') {
    try {
      const checks = await doctor(await readConfig(stateDir));
      print(checks); if (checks.some(check => !check.ok)) process.exitCode = 1;
    } catch (error) {
      print([{ name: 'config.json', ok: false, detail: error instanceof Error ? error.message : String(error) }]);
      process.exitCode = 1;
    }
    return;
  }
  const overrides: Partial<HubConfig> = {};
  for (const [flag, key] of [['trusted-port', 'trustedPort'], ['satellite-port', 'satellitePort'], ['public-port', 'publicPort']] as const)
    if (values[flag]) overrides[key] = Number(values[flag]);
  if (values['public-url']) overrides.publicUrl = values['public-url'];
  const state = await initializeState(stateDir, overrides);
  const config = state.config;
  if (command === 'start') {
    const hub = await startHub(config);
    process.stderr.write(`Tabby Hub listening at http://127.0.0.1:${config.trustedPort}/mcp\n`);
    let closing = false;
    const close = () => { if (!closing) { closing = true; void hub.close().catch(error => process.stderr.write(String(error) + '\n')); } };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  } else if (command === 'install') {
    const source = fileURLToPath(import.meta.url);
    const entrypoint = source.endsWith('.ts') ? fileURLToPath(new URL('../../../dist/packages/hub/src/cli.js', import.meta.url)) : source;
    await access(entrypoint);
    print(await installHub({ config, pluginDir: values['plugin-dir'], start: !values['no-start'], entrypoint }));
    process.stdout.write(`Restart Tabby windows to load the satellite. MCP: http://127.0.0.1:${config.trustedPort}/mcp\n`);
  } else if (command === 'status') print(await adminRequest(config, '/admin/status', 'GET'));
  else if (command === 'enroll') print(await adminRequest(config, '/admin/enroll', 'POST'));
  else if (command === 'client') {
    if (!values.name || !values.redirect?.length) throw new Error('client needs --name and at least one --redirect.');
    const { registerPublicClient } = await import('./auth.js');
    print(await registerPublicClient(config, { client_name: values.name, redirect_uris: values.redirect }));
  } else if (command === 'expose' && subcommand === 'tailnet') {
    const identity = await exposeTailnet(config);
    await adminRequest(config, '/admin/trusted-hosts', 'POST', { hosts: identity.hosts });
    process.stdout.write(`Tailnet MCP: http://${identity.ip.includes(':') ? '[' + identity.ip + ']' : identity.ip}:${config.trustedPort}/mcp\nRestrict this port with Tailscale grants for your intended devices.\n`);
  } else if (command === 'expose' && subcommand === 'public') {
    const publicUrl = values.url ?? config.publicUrl;
    if (!publicUrl) throw new Error('expose public needs --url https://HOST/PREFIX/mcp.');
    const result = await adminRequest(config, '/admin/configure', 'POST', { publicUrl });
    if (values.funnel) await exposeFunnel({ ...config, publicUrl });
    print(result);
    process.stdout.write(`Public MCP requires OAuth: ${publicUrl}\n`);
  } else throw new Error(`Unknown command: ${positionals.join(' ')}. Use --help.`);
}

async function adminRequest(config: HubConfig, path: string, method: string, body?: unknown): Promise<unknown> {
  const state = await initializeState(config.stateDir);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: config.satellitePort, path, method,
      ca: state.trust.certificate, checkServerIdentity: (hostname, certificate) => {
        const error = checkServerIdentity(hostname, certificate); if (error) return error;
        const publicKey = new X509Certificate(certificate.raw).publicKey.export({ type: 'spki', format: 'der' });
        const pin = 'sha256/' + createHash('sha256').update(publicKey).digest('base64');
        return pin === state.trust.spkiPin ? undefined : new Error('Hub certificate pin changed.');
      }, headers: { Authorization: `Bearer ${state.adminCredential}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > MAX_FRAME_BYTES) res.destroy(new Error('Admin response too large.')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode !== 200) reject(new Error(value.error ?? `Admin request failed (${res.statusCode}).`));
          else resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('Hub admin request timed out.')));
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
function print(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
const help = `Tabby Hub — one MCP endpoint for every Tabby window

  tabby-hub install [--plugin-dir PATH] [--no-start]
  tabby-hub start | status | doctor | uninstall [--purge]
  tabby-hub bridge [--url URL]   (optional TABBY_HUB_TOKEN environment variable)
  tabby-hub expose tailnet
  tabby-hub expose public --url https://HOST/PREFIX/mcp [--funnel]
  tabby-hub enroll
  tabby-hub client --name NAME --redirect CALLBACK [--redirect CALLBACK]

All commands accept --state-dir PATH. Ports: --trusted-port, --satellite-port, --public-port.
Public exposure and host installation happen only when their commands are run.
`;
void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
