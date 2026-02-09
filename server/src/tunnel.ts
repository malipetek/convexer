import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { parse, stringify } from 'yaml';
import { Instance } from './types.js';

const CLOUDFLARED_CONFIG = process.env.TUNNEL_CONFIG_PATH
  || path.join(os.homedir(), '.cloudflared', 'config.yml');
const SYSTEM_CONFIG = '/etc/cloudflared/config.yml';
const TUNNEL_DOMAIN = process.env.TUNNEL_DOMAIN || '';

interface IngressRule {
  hostname?: string;
  service: string;
  [key: string]: unknown;
}

interface CloudflaredConfig {
  tunnel?: string;
  'credentials-file'?: string;
  ingress?: IngressRule[];
  [key: string]: unknown;
}

function readConfig(): CloudflaredConfig {
  const content = fs.readFileSync(CLOUDFLARED_CONFIG, 'utf-8');
  return parse(content) as CloudflaredConfig;
}

function writeConfig(config: CloudflaredConfig): void {
  const content = stringify(config, { lineWidth: 0 });
  fs.writeFileSync(CLOUDFLARED_CONFIG, content, 'utf-8');
}

function getTunnelName(): string {
  const config = readConfig();
  return config.tunnel || '';
}

function addDnsRecord(hostname: string): void {
  const tunnel = getTunnelName();
  if (!tunnel) {
    console.warn('No tunnel name in config, skipping DNS record');
    return;
  }
  try {
    execSync(`cloudflared tunnel route dns ${tunnel} ${hostname}`, { stdio: 'pipe' });
    console.log(`DNS record added: ${hostname}`);
  } catch (err: any) {
    const stderr = err.stderr?.toString() || '';
    if (stderr.includes('already exists')) {
      console.log(`DNS record already exists: ${hostname}`);
    } else {
      console.warn(`Failed to add DNS record for ${hostname}: ${stderr}`);
    }
  }
}

function applyAndRestart(): void {
  try {
    execSync(`sudo /bin/cp ${CLOUDFLARED_CONFIG} ${SYSTEM_CONFIG}`, { stdio: 'pipe' });
  } catch (err: any) {
    console.warn('Failed to copy cloudflared config:', err.stderr?.toString() || err.message);
  }
  try {
    execSync('sudo /bin/systemctl daemon-reload', { stdio: 'pipe' });
    execSync('sudo /bin/systemctl restart cloudflared', { stdio: 'pipe' });
  } catch (err: any) {
    console.warn('Failed to restart cloudflared:', err.stderr?.toString() || err.message);
  }
}

export function getTunnelDomain(): string {
  return TUNNEL_DOMAIN;
}

export function isTunnelEnabled(): boolean {
  return !!TUNNEL_DOMAIN && fs.existsSync(CLOUDFLARED_CONFIG);
}

export function getInstanceHostnames(instance: Instance): { backend: string; site: string; dashboard: string } {
  return {
    backend: `${instance.name}.${TUNNEL_DOMAIN}`,
    site: `${instance.name}-site.${TUNNEL_DOMAIN}`,
    dashboard: `${instance.name}-dash.${TUNNEL_DOMAIN}`,
  };
}

export function addTunnelRoutes(instance: Instance): void {
  if (!isTunnelEnabled()) return;

  const config = readConfig();
  if (!config.ingress) return;

  const hostnames = getInstanceHostnames(instance);

  // Remove catch-all (last rule), add our rules, put catch-all back
  const catchAll = config.ingress.pop()!;

  const existing = new Set(config.ingress.map(r => r.hostname));

  if (!existing.has(hostnames.backend)) {
    config.ingress.push({
      hostname: hostnames.backend,
      service: `http://localhost:${instance.backend_port}`,
    });
  }

  if (!existing.has(hostnames.site)) {
    config.ingress.push({
      hostname: hostnames.site,
      service: `http://localhost:${instance.site_proxy_port}`,
    });
  }

  if (!existing.has(hostnames.dashboard)) {
    config.ingress.push({
      hostname: hostnames.dashboard,
      service: `http://localhost:${instance.dashboard_port}`,
    });
  }

  config.ingress.push(catchAll);

  writeConfig(config);

  addDnsRecord(hostnames.backend);
  addDnsRecord(hostnames.site);
  addDnsRecord(hostnames.dashboard);

  applyAndRestart();
  console.log(`Tunnel routes added: ${hostnames.backend}, ${hostnames.site}, ${hostnames.dashboard}`);
}

export function removeTunnelRoutes(instance: Instance): void {
  if (!isTunnelEnabled()) return;

  const config = readConfig();
  if (!config.ingress) return;

  const hostnames = getInstanceHostnames(instance);
  const toRemove = new Set([hostnames.backend, hostnames.site, hostnames.dashboard]);

  config.ingress = config.ingress.filter(rule => !rule.hostname || !toRemove.has(rule.hostname));

  writeConfig(config);
  applyAndRestart();
  console.log(`Tunnel routes removed: ${hostnames.backend}, ${hostnames.site}, ${hostnames.dashboard}`);
}
