import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import Docker from 'dockerode';
import { Instance } from './types.js';
import { getAllInstances, getInstance, createInstance, deleteInstance, allocatePorts, updateInstance } from './db.js';
import { createAndStartInstance, startInstance, stopInstance, removeInstance, getContainerLogs } from './docker.js';
import { removeTunnelRoutes, isTunnelEnabled, getTunnelDomain, getInstanceHostnames } from './tunnel.js';
import { createSession, isAuthEnabled } from './auth.js';
import { getTraefikStatus } from './traefik.js';

const docker = new Docker();

// Generate a random subdomain
function generateSubdomain (): string
{
  const adjectives = ['swift', 'bright', 'calm', 'eager', 'fresh', 'gentle', 'happy', 'jolly', 'kind', 'lively', 'merry', 'nice', 'peaceful', 'quick', 'smart', 'witty'];
  const nouns = ['bear', 'cat', 'deer', 'eagle', 'fox', 'goose', 'hawk', 'lion', 'monkey', 'owl', 'panda', 'rabbit', 'tiger', 'wolf', 'zebra'];

  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 999);

  return `${adj}-${noun}-${num}`;
}

const router = Router();

// Login
router.post('/login', (req: Request, res: Response) => {
  if (!isAuthEnabled()) {
    res.json({ token: 'no-auth' });
    return;
  }
  const { password } = req.body;
  if (password !== process.env.AUTH_PASSWORD) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  const token = createSession();
  res.json({ token });
});

// Helper: enrich instance with tunnel URLs
function withTunnel(instance: Instance) {
  if (!isTunnelEnabled()) return instance;
  const hostnames = getInstanceHostnames(instance);
  return {
    ...instance,
    tunnel_backend: `https://${hostnames.backend}`,
    tunnel_site: `https://${hostnames.site}`,
    tunnel_dashboard: `https://${hostnames.dashboard}`,
  };
}

// Health check
router.get('/health', async (_req: Request, res: Response) =>
{
  const traefikStatus = await getTraefikStatus();
  res.json({
    ok: true,
    tunnel: isTunnelEnabled(),
    tunnel_domain: getTunnelDomain(),
    domain: process.env.DOMAIN || null,
    traefik: traefikStatus,
  });
});

// List all instances
router.get('/instances', (_req: Request, res: Response) => {
  const instances = getAllInstances().map(withTunnel);
  res.json(instances);
});

// Get single instance
router.get('/instances/:id', (req: Request, res: Response) => {
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }
  res.json(withTunnel(instance));
});

// Create instance
router.post('/instances', (req: Request, res: Response) => {
  const { name, extra_env } = req.body;
  const instanceName = name || `instance-${Date.now()}`;
  const id = uuidv4();
  const instanceSecret = crypto.randomBytes(32).toString('hex');
  const ports = allocatePorts();

  // Auto-generate subdomains if not provided
  const finalExtraEnv = extra_env || {};
  if (!finalExtraEnv.SUBDOMAIN) {
    finalExtraEnv.SUBDOMAIN = generateSubdomain();
  }
  if (!finalExtraEnv.DASHBOARD_SUBDOMAIN) {
    finalExtraEnv.DASHBOARD_SUBDOMAIN = generateSubdomain();
  }

  const instance = createInstance({
    id,
    name: instanceName,
    status: 'creating',
    backend_port: ports.backendPort,
    site_proxy_port: ports.siteProxyPort,
    dashboard_port: ports.dashboardPort,
    volume_name: `convexer-${instanceName}`,
    instance_name: instanceName,
    instance_secret: instanceSecret,
    extra_env: JSON.stringify(finalExtraEnv),
  });

  // Start creation in background
  createAndStartInstance(instance).catch(err => {
    console.error(`Background creation failed for ${instanceName}:`, err);
  });

  res.status(201).json(instance);
});

// Start instance
router.post('/instances/:id/start', async (req: Request, res: Response) => {
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }
  try {
    await startInstance(instance);
    res.json(getInstance(instance.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Stop instance
router.post('/instances/:id/stop', async (req: Request, res: Response) => {
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }
  try {
    await stopInstance(instance);
    res.json(getInstance(instance.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Soft delete — remove from DB only, leave containers running
router.post('/instances/:id/forget', (req: Request, res: Response) => {
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }
  deleteInstance(instance.id);
  res.status(204).send();
});

// Full delete — remove containers, volumes, tunnel routes, and DB row
router.delete('/instances/:id', async (req: Request, res: Response) => {
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const errors: string[] = [];

  // Each step is best-effort so delete always completes
  try { await removeInstance(instance); } catch (err: any) {
    console.warn(`Failed to remove containers:`, err.message);
    errors.push(`containers: ${err.message}`);
  }

  try { removeTunnelRoutes(instance); } catch (err: any) {
    console.warn(`Failed to remove tunnel routes:`, err.message);
    errors.push(`tunnel: ${err.message}`);
  }

  deleteInstance(instance.id);

  if (errors.length) {
    res.json({ deleted: true, warnings: errors });
  } else {
    res.status(204).send();
  }
});

// Get logs
router.get('/instances/:id/logs', async (req: Request, res: Response) => {
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const container = req.query.container as string || 'backend';
  const tail = parseInt(req.query.tail as string) || 200;
  const containerId = container === 'dashboard'
    ? instance.dashboard_container_id
    : instance.backend_container_id;

  if (!containerId) {
    res.status(404).json({ error: `No ${container} container found` });
    return;
  }

  try {
    const logs = await getContainerLogs(containerId, tail);
    res.json({ logs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update instance settings (extra_env)
router.put('/instances/:id/settings', async (req: Request, res: Response) =>
{
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const { extra_env } = req.body;

  // Store new extra_env
  const updated = updateInstance(instance.id, {
    extra_env: extra_env ? JSON.stringify(extra_env) : null,
  });

  if (!updated) {
    res.status(500).json({ error: 'Failed to update instance' });
    return;
  }

  // Stop and remove backend container
  try {
    if (instance.backend_container_id) {
      const container = docker.getContainer(instance.backend_container_id);
      await container.stop();
      await container.remove();
    }
  } catch (err: any) {
    console.warn('Failed to stop/remove backend:', err.message);
  }

  // Recreate backend with new env
  try {
    await createAndStartInstance(updated);
  } catch (err: any) {
    console.error('Failed to recreate backend:', err.message);
    res.status(500).json({ error: err.message });
    return;
  }

  res.json(getInstance(instance.id));
});

// Get instance stats (CPU, memory, disk)
router.get('/instances/:id/stats', async (req: Request, res: Response) =>
{
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  if (!instance.backend_container_id) {
    res.status(404).json({ error: 'No backend container found' });
    return;
  }

  try {
    const container = docker.getContainer(instance.backend_container_id);
    const stats = await container.stats({ stream: false });

    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuPercent = (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100;

    const memoryUsage = stats.memory_stats.usage || 0;
    const memoryLimit = stats.memory_stats.limit || 0;
    const memoryMb = memoryUsage / (1024 * 1024);
    const memoryLimitMb = memoryLimit / (1024 * 1024);

    // Get volume size
    let volumeSizeBytes = 0;
    try {
      const volume = docker.getVolume(instance.volume_name);
      const info = await volume.inspect();
      if (info.Mountpoint) {
        const fs = await import('fs');
        const stats = fs.statSync(info.Mountpoint);
        volumeSizeBytes = stats.size;
      }
    } catch (err) {
      // Volume size unavailable
    }

    res.json({
      cpu_percent: Math.round(cpuPercent * 100) / 100,
      memory_mb: Math.round(memoryMb),
      memory_limit_mb: Math.round(memoryLimitMb),
      volume_size_bytes: volumeSizeBytes,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Version endpoints
const CURRENT_VERSION = '0.1.0'; // Should be updated with actual version

// Get current version
router.get('/version', (_req: Request, res: Response) =>
{
  res.json({
    current_version: CURRENT_VERSION,
  });
});

// Check for updates (simulated - would check GitHub API in production)
router.get('/version/check', async (_req: Request, res: Response) =>
{
  try {
    // In production, this would check GitHub API for latest release
    // For now, we'll simulate checking against a hardcoded "latest" version
    const LATEST_VERSION = '0.2.0'; // Example latest version

    // Simple semantic version comparison
    const hasUpdate = compareVersions(CURRENT_VERSION, LATEST_VERSION);

    res.json({
      current_version: CURRENT_VERSION,
      latest_version: LATEST_VERSION,
      has_update: hasUpdate,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger update (would pull from main branch in production)
router.post('/version/update', async (_req: Request, res: Response) =>
{
  try {
    // In production, this would:
    // 1. Pull latest from main branch
    // 2. Run npm install / pnpm install
    // 3. Restart the server

    // For now, we'll simulate the update
    console.log('Update triggered - would pull from main branch');

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: compare semantic versions
function compareVersions (current: string, latest: string): boolean
{
  const currentParts = current.split('.').map(Number);
  const latestParts = latest.split('.').map(Number);

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const currentPart = currentParts[i] || 0;
    const latestPart = latestParts[i] || 0;

    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }

  return false;
}

export default router;
