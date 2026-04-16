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
import * as postgres from './postgres.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const docker = new Docker();

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
const CURRENT_VERSION = packageJson.version;

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
  const domain = process.env.DOMAIN || '';
  const finalExtraEnv = extra_env || {};
  if (!finalExtraEnv.BACKEND_DOMAIN) {
    finalExtraEnv.BACKEND_DOMAIN = domain ? `${instanceName}.${domain}` : instanceName;
  }
  if (!finalExtraEnv.SITE_DOMAIN) {
    finalExtraEnv.SITE_DOMAIN = domain ? `${instanceName}-site.${domain}` : `${instanceName}-site`;
  }
  if (!finalExtraEnv.DASHBOARD_DOMAIN) {
    finalExtraEnv.DASHBOARD_DOMAIN = domain ? `${instanceName}-dash.${domain}` : `${instanceName}-dash`;
  }

  const instance = createInstance({
    id,
    name: instanceName,
    status: 'creating',
    backend_port: ports.backendPort,
    site_proxy_port: ports.siteProxyPort,
    dashboard_port: ports.dashboardPort,
    postgres_port: ports.postgresPort,
    volume_name: `convexer-${instanceName}`,
    postgres_volume_name: `convexer-postgres-${instanceName}`,
    postgres_password: crypto.randomBytes(32).toString('hex'),
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

// Download logs
router.get('/instances/:id/logs/download', async (req: Request, res: Response) =>
{
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const container = req.query.container as string || 'backend';
  const containerId = container === 'dashboard'
    ? instance.dashboard_container_id
    : instance.backend_container_id;

  if (!containerId) {
    res.status(404).json({ error: `No ${container} container found` });
    return;
  }

  try {
    const logs = await getContainerLogs(containerId, 10000);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${instance.name}-${container}-logs-${Date.now()}.txt"`);
    res.send(logs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Restart container
router.post('/instances/:id/restart', async (req: Request, res: Response) =>
{
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const container = req.query.container as string || 'backend';
  const containerId = container === 'dashboard'
    ? instance.dashboard_container_id
    : instance.backend_container_id;

  if (!containerId) {
    res.status(404).json({ error: `No ${container} container found` });
    return;
  }

  try {
    const dockerContainer = docker.getContainer(containerId);
    await dockerContainer.restart();
    res.json({ success: true });
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

// Get instance stats (CPU, memory, disk, network)
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

    // Get network I/O
    let networkRxBytes = 0;
    let networkTxBytes = 0;
    if (stats.networks) {
      for (const iface of Object.values(stats.networks)) {
        networkRxBytes += iface.rx_bytes;
        networkTxBytes += iface.tx_bytes;
      }
    }

    // Get disk I/O
    let diskReadBytes = 0;
    let diskWriteBytes = 0;
    if (stats.blkio_stats && stats.blkio_stats.io_service_bytes_recursive) {
      for (const entry of stats.blkio_stats.io_service_bytes_recursive) {
        if (entry.op === 'read') diskReadBytes += entry.value;
        if (entry.op === 'write') diskWriteBytes += entry.value;
      }
    }

    // Get volume size
    let volumeSizeBytes = 0;
    try {
      const volume = docker.getVolume(instance.volume_name);
      const info = await volume.inspect();
      if (info.Mountpoint) {
        const fs = await import('fs');
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        // Use du to get actual disk usage
        try {
          const { stdout } = await execAsync(`du -sb ${info.Mountpoint}`);
          volumeSizeBytes = parseInt(stdout.split('\t')[0]);
        } catch {
          // Fallback to stat if du fails
          const stat = fs.statSync(info.Mountpoint);
          volumeSizeBytes = stat.size;
        }
      }
    } catch (err) {
      // Volume size unavailable
    }

    // Get system disk usage for the volume's mount point
    let systemDiskTotal = 0;
    let systemDiskUsed = 0;
    let systemDiskAvailable = 0;
    try {
      const volume = docker.getVolume(instance.volume_name);
      const info = await volume.inspect();
      if (info.Mountpoint) {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        const { stdout } = await execAsync(`df -B1 ${info.Mountpoint}`);
        const lines = stdout.split('\n');
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          systemDiskTotal = parseInt(parts[1]);
          systemDiskUsed = parseInt(parts[2]);
          systemDiskAvailable = parseInt(parts[3]);
        }
      }
    } catch (err) {
      // System disk stats unavailable
    }

    res.json({
      cpu_percent: Math.round(cpuPercent * 100) / 100,
      memory_mb: Math.round(memoryMb),
      memory_limit_mb: Math.round(memoryLimitMb),
      volume_size_bytes: volumeSizeBytes,
      network_rx_bytes: networkRxBytes,
      network_tx_bytes: networkTxBytes,
      disk_read_bytes: diskReadBytes,
      disk_write_bytes: diskWriteBytes,
      system_disk_total: systemDiskTotal,
      system_disk_used: systemDiskUsed,
      system_disk_available: systemDiskAvailable,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Version endpoints

// Get current version
router.get('/version', (_req: Request, res: Response) =>
{
  res.json({
    current_version: CURRENT_VERSION,
  });
});

// Check for updates using GitHub API
router.get('/version/check', async (_req: Request, res: Response) =>
{
  try {
    const GITHUB_REPO = process.env.GITHUB_REPO || 'malipetek/convexer';
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Optional, for higher rate limits

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
    };
    if (GITHUB_TOKEN) {
      headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    }

    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers,
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const release = await response.json();
    const latestVersion = release.tag_name.replace(/^v/, ''); // Remove 'v' prefix if present

    const hasUpdate = compareVersions(CURRENT_VERSION, latestVersion);

    res.json({
      current_version: CURRENT_VERSION,
      latest_version: latestVersion,
      has_update: hasUpdate,
      release_url: release.html_url,
      release_notes: release.body,
    });
  } catch (err: any) {
    console.error('Failed to check for updates:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Trigger update - pulls from git and rebuilds
router.post('/version/update', async (_req: Request, res: Response) =>
{
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    console.log('Starting update process...');

    // 1. Pull latest from git
    console.log('Pulling latest changes from git...');
    await execAsync('git fetch origin');
    await execAsync('git checkout main');
    await execAsync('git pull origin main');

    // 2. Install dependencies
    console.log('Installing dependencies...');
    await execAsync('npm install');

    // 3. Build client
    console.log('Building client...');
    await execAsync('npm run build');

    // 4. If running in Docker, we need to restart the container
    // This will be handled by the Docker restart policy or external orchestrator
    console.log('Update complete. Server will restart to apply changes.');

    res.json({ success: true, message: 'Update completed successfully' });
  } catch (err: any) {
    console.error('Update failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get server stats from Docker
router.get('/server/stats', async (_req: Request, res: Response) =>
{
  try {
    const info = await docker.info();
    const version = await docker.version();

    res.json({
      server_version: version.Version,
      api_version: version.ApiVersion,
      os: info.OperatingSystem,
      architecture: info.Architecture,
      cpus: info.NCPU,
      memory: info.MemTotal,
      containers_running: info.ContainersRunning,
      containers_total: info.Containers,
      images: info.Images,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PostgreSQL management endpoints
router.get('/instances/:id/postgres/tables', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const instance = getInstance(id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    const tables = await postgres.listTables(instance);
    res.json({ tables });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/instances/:id/postgres/tables/:name', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const instance = getInstance(id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    const schema = await postgres.getTableSchema(instance, name);
    res.json({ schema });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/instances/:id/postgres/query', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const instance = getInstance(id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    const { query } = req.body;
    if (!query) {
      res.status(400).json({ error: 'Query is required' });
      return;
    }
    const results = await postgres.executeQuery(instance, query);
    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/instances/:id/postgres/backup', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const instance = getInstance(id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    const backup = await postgres.createBackup(instance);
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${instance.name}-backup-${Date.now()}.sql"`);
    res.send(backup);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/instances/:id/postgres/restore', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const instance = getInstance(id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    const { sql } = req.body;
    if (!sql) {
      res.status(400).json({ error: 'SQL content is required' });
      return;
    }
    await postgres.restoreBackup(instance, sql);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/instances/:id/postgres/export', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const instance = getInstance(id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    const { table } = req.query;
    if (!table) {
      res.status(400).json({ error: 'Table name is required' });
      return;
    }
    const csv = await postgres.exportTable(instance, table as string);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${table}-export-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/instances/:id/postgres/import', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const instance = getInstance(id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    const { table, csv } = req.body;
    if (!table || !csv) {
      res.status(400).json({ error: 'Table name and CSV content are required' });
      return;
    }
    const inserted = await postgres.importTable(instance, table, csv);
    res.json({ success: true, inserted });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/instances/:id/postgres/extensions', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const instance = getInstance(id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    const extensions = await postgres.listExtensions(instance);
    res.json({ extensions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/instances/:id/postgres/extensions/:name', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const instance = getInstance(id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    await postgres.loadExtension(instance, name);
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
