import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HubConfig } from '../../../shared/protocol.js';

type Execute = (args: string[]) => Promise<string>;
const execute: Execute = async args => (await promisify(execFile)('tailscale', args, { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout;
export interface TailnetIdentity { hosts: string[]; dnsName: string; ip: string }

export async function tailscaleIdentity(run: Execute = execute): Promise<TailnetIdentity> {
  const status = JSON.parse(await run(['status', '--json']));
  if (status.BackendState !== 'Running' || !status.Self?.Online) throw new Error('Connect this host to Tailscale first.');
  const dnsName = String(status.Self.DNSName ?? '').replace(/\.$/, '');
  const ips: string[] = status.TailscaleIPs ?? status.Self.TailscaleIPs ?? [];
  if (!dnsName || !ips.length || !ips.every(ip => /^[a-fA-F0-9:.]+$/.test(ip))) throw new Error('Tailscale did not provide a valid host identity.');
  return { hosts: [dnsName, dnsName.split('.')[0], ...ips.map(ip => ip.includes(':') ? `[${ip}]` : ip)], dnsName, ip: ips.find(ip => !ip.includes(':')) ?? ips[0] };
}
export async function exposeTailnet(config: HubConfig, run: Execute = execute): Promise<TailnetIdentity> {
  const identity = await tailscaleIdentity(run);
  const existing = JSON.parse(await run(['serve', 'status', '--json']));
  const forwarding = existing.TCP?.[String(config.trustedPort)];
  const destination = `127.0.0.1:${config.trustedPort}`;
  if (forwarding && forwarding.TCPForward !== destination) throw new Error('The Tailnet port belongs to another service. Existing mappings were preserved.');
  await run(['serve', '--bg', `--tcp=${config.trustedPort}`, `tcp://${destination}`]);
  return identity;
}

/** Plan first so every conflict is detected before adding any mapping. */
export function funnelMappings(config: HubConfig, identity: TailnetIdentity, existing: any): string[][] {
  if (!config.publicUrl) throw new Error('Configure the authenticated public listener first.');
  const url = new URL(config.publicUrl);
  if (url.hostname !== identity.dnsName || !['', '443', '8443', '10000'].includes(url.port))
    throw new Error('Funnel URL must use this host’s Tailscale DNS name and an allowed Funnel HTTPS port.');
  const port = url.port || '443';
  if (existing.TCP?.[port] && !existing.TCP[port].HTTPS) throw new Error('This Funnel port belongs to a different service.');
  const authority = `${url.hostname}:${port}`;
  const handlers = existing.Web?.[authority]?.Handlers ?? {};
  // Funnel makes every handler on an HTTPS port public. Never publish an existing private Serve service.
  if (Object.keys(handlers).length && !existing.AllowFunnel?.[authority])
    throw new Error('This HTTPS port hosts private Serve handlers. Choose a separate Funnel port.');
  const base = url.pathname.slice(0, -4);
  const issuer = base + '/oauth';
  const paths = [...new Set([base || '/', '/.well-known/oauth-protected-resource' + url.pathname,
    '/.well-known/oauth-authorization-server' + issuer, '/.well-known/openid-configuration' + issuer])];
  const backend = `http://127.0.0.1:${config.publicPort}`;
  return paths.map(path => {
    // A target URL path restores the path stripped by the Funnel mount point.
    const target = backend + (path === '/' ? '' : path);
    if (handlers[path] && handlers[path].Proxy !== target) throw new Error(`Funnel path ${path} belongs to another service.`);
    return ['funnel', '--bg', `--https=${port}`, `--set-path=${path}`, target];
  });
}
export async function exposeFunnel(config: HubConfig, run: Execute = execute): Promise<void> {
  const identity = await tailscaleIdentity(run);
  const existing = JSON.parse(await run(['funnel', 'status', '--json']));
  const commands = funnelMappings(config, identity, existing);
  for (const command of commands) await run(command);
}
