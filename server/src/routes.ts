import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import Docker from 'dockerode';
import { Instance } from './types.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import
{
  getAllInstances,
  getArchivedInstances,
  getInstance,
  getInstanceByName,
  createInstance,
  updateInstance,
  deleteInstance,
  archiveInstance,
  restoreArchivedInstance,
  allocatePorts,
  getBackupConfig,
  createBackupConfig,
  updateBackupConfig,
  deleteBackupConfig,
  getBackupHistory,
  getBackupHistoryById,
  getBackupSettings,
  updateBackupSettings,
  updateBackupHistory,
  getBackupSyncStatus,
  BackupHistory,
  getBackupDestinations,
  getBackupDestination,
  createBackupDestination,
  updateBackupDestination,
  deleteBackupDestination
} from './db.js';
import
{
  createAndStartInstance,
  startInstance,
  stopInstance,
  removeInstance,
  syncInstanceStatuses,
  getContainerLogs,
  ensureImages,
  pullImage,
  getContainerByRole
} from './docker.js';
import
{
  listTables,
  getTableSchema,
  executeQuery,
  createBackup,
  restoreBackup,
  exportTable,
  importTable,
  listExtensions,
  loadExtension
} from './postgres.js';
import
{
  backupDatabase,
  backupVolume,
  restoreDatabase,
  restoreVolume,
  performBackup
} from './backup.js';
import
{
  scheduleInstanceBackup,
  unscheduleInstanceBackup,
  refreshBackupScheduler
} from './scheduler.js';
import { isAuthEnabled, createSession } from './auth.js';
import { addTunnelRoutes, isTunnelEnabled, getInstanceHostnames, getTunnelDomain, removeTunnelRoutes } from './tunnel.js';
import { randomUUID } from 'crypto';
import { getTraefikStatus } from './traefik.js';
import * as postgres from './postgres.js';
import { readFileSync, promises as fsPromises } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import path from 'path';

const execAsync = promisify(exec);
const docker = new Docker();

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Read version from root package.json (single source of truth).
// Falls back to server/package.json if the root isn't present (e.g. local dev runs).
function readCurrentVersion (): string
{
  const candidates = [
    join(__dirname, '../../package.json'), // root package.json (Docker runtime & monorepo)
    join(__dirname, '../package.json'),    // server/package.json (fallback)
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf-8'));
      if (pkg?.version) return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return '0.0.0';
}
const CURRENT_VERSION = readCurrentVersion();

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
    name: req.body.name || `instance-${Date.now()}`,
    status: 'creating',
    backend_port: ports.backendPort,
    site_proxy_port: ports.siteProxyPort,
    dashboard_port: ports.dashboardPort,
    postgres_port: ports.postgresPort,
    betterauth_port: ports.betterauthPort,
    volume_name: `convexer-${instanceName}`,
    postgres_volume_name: `convexer-postgres-${instanceName}`,
    postgres_password: crypto.randomBytes(32).toString('hex'),
    instance_name: instanceName,
    instance_secret: instanceSecret,
    extra_env: req.body.extra_env ? JSON.stringify(req.body.extra_env) : null,
    pinned_version: null,
    detected_version: null,
    health_check_timeout: 300000,
    postgres_health_check_timeout: 60000,
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

// Delete — back up, remove containers/volumes/tunnel, then archive (soft delete)
router.delete('/instances/:id', async (req: Request, res: Response) => {
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const warnings: string[] = [];
  const backupResults: Record<string, any> = {};

  // Step 1: Take backups while containers are still accessible
  try {
    const dbBackupId = randomUUID();
    backupResults.database = await backupDatabase(instance, dbBackupId, 'Pre-deletion');
  } catch (err: any) {
    console.warn(`Pre-deletion DB backup failed for ${instance.name}:`, err.message);
    backupResults.database = { success: false, error: err.message };
  }

  try {
    const volBackupId = randomUUID();
    backupResults.volume = await backupVolume(instance, volBackupId, 'Pre-deletion');
  } catch (err: any) {
    console.warn(`Pre-deletion volume backup failed for ${instance.name}:`, err.message);
    backupResults.volume = { success: false, error: err.message };
  }

  // Step 2: Remove containers and volumes
  try { await removeInstance(instance); } catch (err: any) {
    console.warn(`Failed to remove containers:`, err.message);
    warnings.push(`containers: ${err.message}`);
  }

  try { removeTunnelRoutes(instance); } catch (err: any) {
    console.warn(`Failed to remove tunnel routes:`, err.message);
    warnings.push(`tunnel: ${err.message}`);
  }

  // Step 3: Archive (soft delete — keeps DB row + backup files)
  archiveInstance(instance.id);

  res.json({
    archived: true,
    warnings: warnings.length ? warnings : undefined,
    backups: backupResults,
  });
});

// List archived instances
router.get('/archived-instances', (_req: Request, res: Response) =>
{
  const archived = getArchivedInstances();
  const withHistory = archived.map(instance =>
  {
    const history = getBackupHistory(instance.id, 10);
    return { ...instance, backup_history: history };
  });
  res.json(withHistory);
});

// Permanently delete an archived instance (removes DB row + backup files)
router.delete('/archived-instances/:id', async (req: Request, res: Response) =>
{
  const instance = getInstance(req.params.id as string);
  if (!instance || !instance.archived_at) {
    res.status(404).json({ error: 'Archived instance not found' });
    return;
  }

  // Delete backup files from disk
  const history = getBackupHistory(instance.id, 1000);
  for (const backup of history) {
    if (backup.file_path) {
      try { await fsPromises.unlink(backup.file_path); } catch { /* already gone */ }
    }
  }
  // Remove backup directory
  const backupDir = path.join(process.env.DATA_DIR || process.cwd(), 'backups', instance.id);
  try { await fsPromises.rm(backupDir, { recursive: true, force: true }); } catch { /* dir may not exist */ }

  deleteInstance(instance.id);
  res.status(204).send();
});

// Restore an archived instance
router.post('/archived-instances/:id/restore', async (req: Request, res: Response) =>
{
  const instance = getInstance(req.params.id as string);
  if (!instance || !instance.archived_at) {
    res.status(404).json({ error: 'Archived instance not found' });
    return;
  }

  // Check for naming conflicts with active instances
  let finalName = instance.name;
  let conflict = getInstanceByName(instance.name);

  // Generate a random name if there's a conflict
  if (conflict) {
    const adjectives = ['swift', 'calm', 'bright', 'eager', 'gentle', 'happy', 'kind', 'lively', 'proud', 'wise'];
    const nouns = ['bear', 'fox', 'hawk', 'lion', 'owl', 'tiger', 'wolf', 'eagle', 'deer', 'rabbit'];
    const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
    const randomSuffix = Math.floor(Math.random() * 1000);
    finalName = `${randomAdj}-${randomNoun}-${randomSuffix}`;
  }

  // Unarchive the instance (set archived_at to null, update name if needed)
  const restored = restoreArchivedInstance(instance.id, conflict ? finalName : undefined);
  if (!restored) {
    res.status(500).json({ error: 'Failed to restore instance' });
    return;
  }

  // Get the updated instance
  const updatedInstance = getInstance(instance.id);
  if (!updatedInstance) {
    res.status(500).json({ error: 'Failed to retrieve restored instance' });
    return;
  }

  // Recreate containers and volumes
  try {
    await createAndStartInstance(updatedInstance);
  } catch (err: any) {
    console.error('Failed to recreate instance:', err);
    res.status(500).json({ error: err.message });
    return;
  }

  res.json({
    instance: updatedInstance,
    renamed: conflict ? finalName : undefined,
  });
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

  try {
    const containerObj = await getContainerByRole(instance, container as 'backend' | 'dashboard' | 'postgres' | 'betterauth');
    if (!containerObj) {
      res.status(404).json({ error: `No ${container} container found` });
      return;
    }
    const containerId = (await containerObj.inspect()).Id;
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

  try {
    const containerObj = await getContainerByRole(instance, container as 'backend' | 'dashboard' | 'postgres' | 'betterauth');
    if (!containerObj) {
      res.status(404).json({ error: `No ${container} container found` });
      return;
    }
    const containerId = (await containerObj.inspect()).Id;
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

  try {
    const containerObj = await getContainerByRole(instance, container as 'backend' | 'dashboard' | 'postgres' | 'betterauth');
    if (!containerObj) {
      res.status(404).json({ error: `No ${container} container found` });
      return;
    }
    await containerObj.restart();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/instances/:id/health-check-settings', async (req: Request, res: Response) =>
{
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const { health_check_timeout, postgres_health_check_timeout } = req.body;

  const updated = updateInstance(instance.id, {
    health_check_timeout: health_check_timeout,
    postgres_health_check_timeout: postgres_health_check_timeout,
  });

  res.json(updated);
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
    const container = await getContainerByRole(instance, 'backend');
    if (container) {
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

// Upgrade instance to specific Convex version
router.post('/instances/:id/upgrade', async (req: Request, res: Response) =>
{
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const { targetVersion } = req.body;
  if (!targetVersion) {
    res.status(400).json({ error: 'targetVersion is required' });
    return;
  }

  try {
    // Pull and validate target images before making any destructive changes
    const tag = targetVersion === 'latest' ? 'latest' : targetVersion;
    const backendImage = `ghcr.io/get-convex/convex-backend:${tag}`;
    const dashboardImage = `ghcr.io/get-convex/convex-dashboard:${tag}`;
    try {
      await pullImage(backendImage);
      await pullImage(dashboardImage);
    } catch (pullErr: any) {
      res.status(400).json({ error: `Failed to pull version "${targetVersion}": ${pullErr.message}` });
      return;
    }

    // Create pre-upgrade backup
    const backupId = uuidv4();
    const { backupDatabase, backupVolume } = await import('./backup.js');

    const dbBackup = await backupDatabase(instance, backupId, 'Pre-upgrade backup');
    if (!dbBackup.success) {
      res.status(500).json({ error: `Pre-upgrade backup failed: ${dbBackup.error}` });
      return;
    }

    const volumeBackupId = uuidv4();
    const volBackup = await backupVolume(instance, volumeBackupId, 'Pre-upgrade backup');
    if (!volBackup.success) {
      res.status(500).json({ error: `Pre-upgrade volume backup failed: ${volBackup.error}` });
      return;
    }

    // Update pinned version
    updateInstance(instance.id, { pinned_version: targetVersion });

    // Stop and recreate backend/dashboard with new version
    try {
      const backend = await getContainerByRole(instance, 'backend');
      if (backend) {
        await backend.stop();
        await backend.remove();
      }
    } catch (err: any) {
      console.warn('Failed to stop/remove backend:', err.message);
    }

    try {
      const dashboard = await getContainerByRole(instance, 'dashboard');
      if (dashboard) {
        await dashboard.stop();
        await dashboard.remove();
      }
    } catch (err: any) {
      console.warn('Failed to stop/remove dashboard:', err.message);
    }

    // Recreate with new version
    const updated = getInstance(instance.id);
    if (updated) {
      await createAndStartInstance(updated);

      // Update detected version after successful upgrade
      updateInstance(instance.id, { detected_version: targetVersion });
    }

    res.json({
      success: true,
      message: 'Instance upgraded successfully',
      backupIds: [backupId, volumeBackupId]
    });
  } catch (err: any) {
    console.error('Upgrade failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get instance stats (CPU, memory, disk, network)
router.get('/instances/:id/stats', async (req: Request, res: Response) =>
{
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  try {
    const container = await getContainerByRole(instance, 'backend');
    if (!container) {
      res.status(404).json({ error: 'No backend container found' });
      return;
    }
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
    const GITHUB_REPO = process.env.GITHUB_REPO;
    if (!GITHUB_REPO) {
      res.status(400).json({ error: 'GITHUB_REPO environment variable not set' });
      return;
    }
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Optional, for higher rate limits / private repos

    const baseHeaders: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'convexer-updater',
    };
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

    const doFetch = (withAuth: boolean) => fetch(url, {
      headers: withAuth && GITHUB_TOKEN
        ? { ...baseHeaders, Authorization: `Bearer ${GITHUB_TOKEN}` }
        : baseHeaders,
    });

    let response = await doFetch(true);
    // If the configured token is invalid/expired, retry unauthenticated —
    // this repo is public so the call still succeeds.
    if (response.status === 401 && GITHUB_TOKEN) {
      console.warn('GitHub token rejected (401). Retrying without auth.');
      response = await doFetch(false);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GitHub API error: ${response.status} ${response.statusText} ${body.slice(0, 200)}`);
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

// Trigger update - spawns an ephemeral host-side updater container that
// pulls from git, rebuilds the image, and restarts the stack via docker compose.
//
// Requires:
//   - /var/run/docker.sock mounted (already present for instance management)
//   - HOST_PROJECT_PATH env var set to the absolute path of the repo on the host
//     (e.g. /home/convexer) so we can bind-mount it into the updater container.
//
// The updater container runs detached and outlives this container's restart,
// which is why we return before it finishes.
router.post('/version/update', async (_req: Request, res: Response) =>
{
  const hostProjectPath = process.env.HOST_PROJECT_PATH;
  console.log(`[update] HOST_PROJECT_PATH: ${hostProjectPath}`);

  if (!hostProjectPath) {
    console.error('[update] HOST_PROJECT_PATH is not configured');
    res.status(500).json({
      error: 'HOST_PROJECT_PATH is not configured. Set it in docker-compose.yml to the host path of the repo (e.g. /home/convexer).',
    });
    return;
  }

  const branch = process.env.UPDATE_BRANCH || 'main';
  const updaterImage = process.env.UPDATER_IMAGE || 'docker:27-cli';
  console.log(`[update] Branch: ${branch}, Updater image: ${updaterImage}`);

  // Blue-green deployment script:
  // 1. Build new image with :pending tag (old container keeps running)
  // 2. Start new container on port 4001 as convexer-pending
  // 3. Health check the new container
  // 4. If healthy: stop old, rename new, done
  // 5. If unhealthy: remove new, keep old running, exit with error
  const script = `
set -eu
apk add --no-cache git curl >/dev/null
cd /repo
mkdir -p /repo/server/data

echo "[updater] saving current commit for rollback"
git rev-parse HEAD > /repo/server/data/.rollback_commit || true

echo "[updater] changing git remote to HTTPS"
git remote set-url origin https://github.com/\${GITHUB_REPO}.git

echo "[updater] git fetch and pull"
git fetch origin
git checkout ${branch}
git pull origin ${branch}

echo "[updater] building new image as convexer-convexer:pending"
docker build -t convexer-convexer:pending --target builder -f Dockerfile . 2>&1 | tee /repo/server/data/.update_logs || {
  echo "[updater] BUILD FAILED - rolling back git"
  git checkout $(cat /repo/server/data/.rollback_commit) || true
  echo "[updater] old container still running"
  exit 1
}
docker build -t convexer-convexer:pending -f Dockerfile . 2>&1 | tee -a /repo/server/data/.update_logs || {
  echo "[updater] BUILD FAILED - rolling back git"
  git checkout $(cat /repo/server/data/.rollback_commit) || true
  echo "[updater] old container still running"
  exit 1
}

echo "[updater] starting new container on port 4001 as convexer-pending"
docker rm -f convexer-pending 2>/dev/null || true
docker run -d --name convexer-pending \\
  --network convexer-net \\
  -p 4001:4000 \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v convexer-data:/app/server/data \\
  -v convexer-ssh:/root/.ssh \\
  -v convexer-backups:/app/server/data/backups \\
  -e DATA_DIR=/app/server/data \\
  -e DOMAIN=\${DOMAIN} \\
  -e HOST_PROJECT_PATH=\${HOST_PROJECT_PATH:-/home/convexer} \\
  -e UPDATE_BRANCH=\${UPDATE_BRANCH:-main} \\
  -e GITHUB_REPO=\${GITHUB_REPO} \\
  -e GITHUB_TOKEN=\${GITHUB_TOKEN} \\
  convexer-convexer:pending

echo "[updater] waiting for new container to start..."
sleep 5

echo "[updater] health checking new container on port 4001"
HEALTH_OK=0
for i in 1 2 3 4 5; do
  if curl -sf http://localhost:4001/api/health >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  echo "[updater] health check attempt $i failed, retrying..."
  sleep 3
done

if [ "$HEALTH_OK" = "0" ]; then
  echo "[updater] HEALTH CHECK FAILED - rolling back"
  docker logs convexer-pending --tail 50 || true
  docker rm -f convexer-pending || true
  docker rmi convexer-convexer:pending || true
  echo "[updater] rolling back git to previous commit"
  git checkout $(cat /repo/server/data/.rollback_commit) || true
  echo "[updater] old container still running on port 4000"
  exit 1
fi

echo "[updater] health check passed! swapping containers..."

echo "[updater] stopping old container"
docker stop convexer 2>/dev/null || true
docker rm convexer 2>/dev/null || true

echo "[updater] stopping pending container to rebind port"
docker stop convexer-pending

echo "[updater] removing old image tag"
docker rmi convexer-convexer:latest 2>/dev/null || true

echo "[updater] tagging pending as latest (keeping pending tag for rollback)"
docker tag convexer-convexer:pending convexer-convexer:latest

echo "[updater] starting final container"
docker run -d --name convexer \\
  --network convexer-net \\
  -p 4000:4000 \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v convexer-data:/app/server/data \\
  -v convexer-ssh:/root/.ssh \\
  -v convexer-backups:/app/server/data/backups \\
  -e DATA_DIR=/app/server/data \\
  -e DOMAIN=\${DOMAIN} \\
  -e HOST_PROJECT_PATH=\${HOST_PROJECT_PATH:-/home/convexer} \\
  -e UPDATE_BRANCH=\${UPDATE_BRANCH:-main} \\
  --restart unless-stopped \\
  --label "traefik.enable=true" \\
  --label "traefik.http.routers.convexer.rule=Host(\\\`\${DOMAIN}\\\`)" \\
  --label "traefik.http.routers.convexer.entrypoints=web" \\
  --label "traefik.http.services.convexer.loadbalancer.server.port=4000" \\
  convexer-convexer:latest || {
  echo "[updater] FAILED TO START FINAL CONTAINER - rolling back"
  echo "[updater] restarting pending container on port 4000 as fallback"
  docker rm -f convexer 2>/dev/null || true
  docker run -d --name convexer \\
    --network convexer-net \\
    -p 4000:4000 \\
    -v /var/run/docker.sock:/var/run/docker.sock \\
    -v convexer-data:/app/server/data \\
    -v convexer-ssh:/root/.ssh \\
    -v convexer-backups:/app/server/data/backups \\
    -e DATA_DIR=/app/server/data \\
    -e DOMAIN=\${DOMAIN} \\
    -e HOST_PROJECT_PATH=\${HOST_PROJECT_PATH:-/home/convexer} \\
    -e UPDATE_BRANCH=\${UPDATE_BRANCH:-main} \\
    --restart unless-stopped \\
    --label "traefik.enable=true" \\
    --label "traefik.http.routers.convexer.rule=Host(\\\`\${DOMAIN}\\\`)" \\
    --label "traefik.http.routers.convexer.entrypoints=web" \\
    --label "traefik.http.services.convexer.loadbalancer.server.port=4000" \\
    convexer-convexer:pending
  echo "[updater] rolling back git to previous commit"
  git checkout $(cat /repo/server/data/.rollback_commit) || true
  echo "[updater] fallback container running on port 4000"
  exit 1
}

echo "[updater] waiting for final container to start..."
sleep 5

echo "[updater] health checking final container on port 4000"
HEALTH_OK=0
for i in 1 2 3 4 5; do
  if curl -sf http://localhost:4000/api/health >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  echo "[updater] health check attempt $i failed, retrying..."
  sleep 3
done

if [ "$HEALTH_OK" = "0" ]; then
  echo "[updater] FINAL CONTAINER HEALTH CHECK FAILED - rolling back"
  docker logs convexer --tail 50 || true
  echo "[updater] restarting pending container as fallback"
  docker rm -f convexer || true
  docker run -d --name convexer \\
    --network convexer-net \\
    -p 4000:4000 \\
    -v /var/run/docker.sock:/var/run/docker.sock \\
    -v convexer-data:/app/server/data \\
    -v convexer-ssh:/root/.ssh \\
    -v convexer-backups:/app/server/data/backups \\
    -e DATA_DIR=/app/server/data \\
    -e DOMAIN=\${DOMAIN} \\
    -e HOST_PROJECT_PATH=\${HOST_PROJECT_PATH:-/home/convexer} \\
    -e UPDATE_BRANCH=\${UPDATE_BRANCH:-main} \\
    --restart unless-stopped \\
    --label "traefik.enable=true" \\
    --label "traefik.http.routers.convexer.rule=Host(\\\`\${DOMAIN}\\\`)" \\
    --label "traefik.http.routers.convexer.entrypoints=web" \\
    --label "traefik.http.services.convexer.loadbalancer.server.port=4000" \\
    convexer-convexer:pending
  echo "[updater] rolling back git to previous commit"
  git checkout $(cat /repo/server/data/.rollback_commit) || true
  echo "[updater] fallback container running on port 4000"
  exit 1
fi

echo "[updater] cleaning up"
docker rm -f convexer-pending 2>/dev/null || true
docker rmi convexer-convexer:pending 2>/dev/null || true

echo "[updater] blue-green deploy complete!"
`;

  try {
    console.log('[update] Starting updater container...');

    // Ensure the image is present locally. dockerode.createContainer does NOT
    // auto-pull, so we pull explicitly. This is idempotent — fast no-op once
    // the image is cached.
    const images = await docker.listImages({ filters: JSON.stringify({ reference: [updaterImage] }) });
    if (images.length === 0) {
      console.log(`[update] Pulling ${updaterImage}...`);
      await new Promise<void>((resolve, reject) =>
      {
        docker.pull(updaterImage, (err: any, stream: NodeJS.ReadableStream) =>
        {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (pErr: any) => pErr ? reject(pErr) : resolve());
        });
      });
      console.log(`[update] Pulled ${updaterImage}.`);
    }

    const container = await docker.createContainer({
      Image: updaterImage,
      Cmd: ['sh', '-c', script],
      WorkingDir: '/repo',
      Tty: false,
      Env: [
        `GITHUB_REPO=${process.env.GITHUB_REPO || 'malipetek/convexer'}`,
        `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''}`,
        `DOMAIN=${process.env.DOMAIN || ''}`,
        `HOST_PROJECT_PATH=${process.env.HOST_PROJECT_PATH || '/home/convexer'}`,
        `UPDATE_BRANCH=${process.env.UPDATE_BRANCH || 'main'}`,
      ],
      HostConfig: {
        AutoRemove: false, // Temporarily disabled for debugging
        NetworkMode: 'host', // needed for health check to reach localhost:4001
        Binds: [
          '/var/run/docker.sock:/var/run/docker.sock',
          `${hostProjectPath}:/repo`,
        ],
      },
      Labels: { 'convexer.role': 'updater' },
    });

    await container.start();
    console.log(`[update] Updater container ${container.id.slice(0, 12)} started.`);

    res.status(202).json({
      success: true,
      message: 'Update started. The server will restart shortly.',
      updater_container_id: container.id,
    });
  } catch (err: any) {
    console.error('[update] Failed to start updater:', err);
    res.status(500).json({ error: err.message });
  }
});

// Tail logs of the most recent updater container (for UI progress display).
router.get('/version/update/logs', async (_req: Request, res: Response) =>
{
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: ['convexer.role=updater'] }),
    });
    if (containers.length === 0) {
      res.json({ running: false, logs: '' });
      return;
    }
    // Most recent first
    containers.sort((a, b) => b.Created - a.Created);
    const info = containers[0];
    const container = docker.getContainer(info.Id);
    const buf = await container.logs({ stdout: true, stderr: true, tail: 500 });
    const logs = Buffer.isBuffer(buf) ? buf.toString('utf-8') : String(buf);
    res.json({
      running: info.State === 'running',
      state: info.State,
      status: info.Status,
      logs,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Check update status (success or failure)
router.get('/version/update/status', async (_req: Request, res: Response) =>
{
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: ['convexer.role=updater'] }),
    });
    if (containers.length === 0) {
      res.json({ running: false, success: null });
      return;
    }
    // Most recent first
    containers.sort((a, b) => b.Created - a.Created);
    const info = containers[0];

    if (info.State === 'running') {
      res.json({ running: true, success: null });
      return;
    }

    // Container has stopped, check exit code
    const container = docker.getContainer(info.Id);
    const containerInfo = await container.inspect();
    const exitCode = containerInfo.State.ExitCode;
    const success = exitCode === 0;

    res.json({ running: false, success, exitCode });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get saved update logs
router.get('/version/update/logs/saved', async (_req: Request, res: Response) =>
{
  try {
    const fs = await import('fs');
    const path = await import('path');
    const dataDir = process.env.DATA_DIR || '/app/server/data';
    // Prefer host-data mount (where the updater container actually writes),
    // fall back to DATA_DIR for backwards-compat.
    const candidates = [
      '/app/host-data/.update_logs',
      path.join(dataDir, '.update_logs'),
    ];

    for (const logsPath of candidates) {
      if (fs.existsSync(logsPath)) {
        const logs = fs.readFileSync(logsPath, 'utf-8');
        res.json({ logs, exists: true });
        return;
      }
    }
    res.json({ logs: '', exists: false });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Check if rollback is available
router.get('/version/rollback/status', async (_req: Request, res: Response) =>
{
  try {
    const fs = await import('fs');
    const path = await import('path');
    const dataDir = process.env.DATA_DIR || '/app/server/data';
    const rollbackCommitPath = path.join(dataDir, '.rollback_commit');

    if (fs.existsSync(rollbackCommitPath)) {
      const rollbackCommit = fs.readFileSync(rollbackCommitPath, 'utf-8').trim();
      res.json({ available: true, commit: rollbackCommit });
    } else {
      res.json({ available: false, commit: null });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Perform rollback to previous version
router.post('/version/rollback', async (_req: Request, res: Response) =>
{
  try {
    const hostProjectPath = process.env.HOST_PROJECT_PATH || '/home/convexer';
    const branch = process.env.UPDATE_BRANCH || 'main';
    const updaterImage = process.env.UPDATER_IMAGE || 'docker:27-cli';

    const fs = await import('fs');
    const path = await import('path');
    const dataDir = process.env.DATA_DIR || '/app/server/data';
    const rollbackCommitPath = path.join(dataDir, '.rollback_commit');

    if (!fs.existsSync(rollbackCommitPath)) {
      res.status(400).json({ error: 'No rollback commit found' });
      return;
    }

    const rollbackCommit = fs.readFileSync(rollbackCommitPath, 'utf-8').trim();

    // Script to rollback to previous commit
    const script = [
      'set -eu',
      'apk add --no-cache git >/dev/null',
      'cd /repo',
      'mkdir -p /repo/server/data',
      'echo "[rollback] checking out previous commit"',
      `git checkout ${rollbackCommit}`,
      'echo "[rollback] stopping and removing all convexer containers"',
      'docker compose -p convexer down --remove-orphans 2>/dev/null || true',
      'docker rm -f convexer convexer-traefik convexer-pending 2>/dev/null || true',
      'echo "[rollback] docker rmi convexer-convexer:latest"',
      'docker rmi convexer-convexer:latest convexer-convexer:pending 2>/dev/null || true',
      'echo "[rollback] docker compose build"',
      'docker compose -p convexer build --no-cache 2>&1 | tee /repo/server/data/.rollback_logs',
      'echo "[rollback] force-removing containers before up"',
      'docker rm -f convexer convexer-traefik 2>/dev/null || true',
      'echo "[rollback] docker compose up -d"',
      'docker compose -p convexer up -d',
      'echo "[rollback] removing rollback commit file"',
      'rm /repo/server/data/.rollback_commit',
      'echo "[rollback] done"',
    ].join(' && ');

    // Pull the updater image
    const images = await docker.listImages({ filters: JSON.stringify({ reference: [updaterImage] }) });
    if (images.length === 0) {
      console.log(`[rollback] Pulling ${updaterImage}...`);
      await new Promise<void>((resolve, reject) =>
      {
        docker.pull(updaterImage, (err: any, stream: NodeJS.ReadableStream) =>
        {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (pErr: any) => pErr ? reject(pErr) : resolve());
        });
      });
      console.log(`[rollback] Pulled ${updaterImage}.`);
    }

    const container = await docker.createContainer({
      Image: updaterImage,
      Cmd: ['sh', '-c', script],
      WorkingDir: '/repo',
      Tty: false,
      HostConfig: {
        AutoRemove: true,
        Binds: [
          '/var/run/docker.sock:/var/run/docker.sock',
          `${hostProjectPath}:/repo`,
        ],
      },
      Labels: { 'convexer.role': 'updater' },
    });

    await container.start();
    console.log(`[rollback] Rollback container ${container.id.slice(0, 12)} started.`);

    res.status(202).json({
      success: true,
      message: 'Rollback started. The server will restart shortly.',
      updater_container_id: container.id,
    });
  } catch (err: any) {
    console.error('[rollback] Failed to start rollback:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get server stats from Docker
router.get('/server/stats', async (_req: Request, res: Response) =>
{
  try {
    const info = await docker.info();
    const version = await docker.version();
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    const os = await import('os');

    // Get system uptime
    const uptime = os.uptime();

    // Get CPU load averages
    const loadavg = os.loadavg();

    // Get memory info
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Get disk usage
    let diskUsage: any[] = [];
    try {
      const { stdout } = await execAsync('df -h');
      const lines = stdout.split('\n').slice(1);
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 6 && parts[0] !== '' && !parts[0].startsWith('/dev/loop')) {
          diskUsage.push({
            filesystem: parts[0],
            size: parts[1],
            used: parts[2],
            available: parts[3],
            usage_percent: parts[4],
            mountpoint: parts[5],
          });
        }
      }
    } catch (err) {
      // Disk stats unavailable
    }

    // Get Docker system disk usage
    let dockerDiskUsage: any = {};
    try {
      const { stdout } = await execAsync('docker system df');
      const lines = stdout.split('\n');
      if (lines.length > 1) {
        const header = lines[0].split(/\s+/);
        const types = ['Images', 'Containers', 'Local Volumes', 'Build Cache'];
        for (let i = 1; i < lines.length && i - 1 < types.length; i++) {
          const parts = lines[i].split(/\s+/).filter(p => p);
          if (parts.length >= 4) {
            dockerDiskUsage[types[i - 1].toLowerCase().replace(' ', '_')] = {
              total_size: parts[1],
              active: parts[2],
              size: parts[3],
              reclaimable: parts[4] || '',
            };
          }
        }
      }
    } catch (err) {
      // Docker disk stats unavailable
    }

    // Get network interfaces
    const networkInterfaces = os.networkInterfaces();

    // Get Docker storage driver
    const storageDriver = info.Driver;

    // Get Docker server address
    const serverAddress = info.ServerVersion;

    res.json({
      // Docker info
      server_version: version.Version,
      api_version: version.ApiVersion,
      docker_server_address: serverAddress,
      storage_driver: storageDriver,
      os: info.OperatingSystem,
      kernel_version: info.KernelVersion,
      architecture: info.Architecture,

      // CPU
      cpus: info.NCPU,
      load_average_1m: loadavg[0],
      load_average_5m: loadavg[1],
      load_average_15m: loadavg[2],

      // Memory
      memory_total: totalMem,
      memory_used: usedMem,
      memory_free: freeMem,
      memory_total_gb: (totalMem / (1024 * 1024 * 1024)).toFixed(2),
      memory_used_gb: (usedMem / (1024 * 1024 * 1024)).toFixed(2),
      memory_free_gb: (freeMem / (1024 * 1024 * 1024)).toFixed(2),
      memory_usage_percent: ((usedMem / totalMem) * 100).toFixed(1),

      // Docker containers
      containers_running: info.ContainersRunning,
      containers_paused: info.ContainersPaused,
      containers_stopped: info.ContainersStopped,
      containers_total: info.Containers,
      images: info.Images,

      // Docker volumes and networks
      volumes: info.Volumes,
      networks: info.Networks,

      // System
      uptime_seconds: uptime,
      uptime_formatted: formatUptime(uptime),
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),

      // Disk usage
      disk_usage: diskUsage,

      // Docker disk usage
      docker_disk_usage: dockerDiskUsage,

      // Network interfaces
      network_interfaces: Object.keys(networkInterfaces).map(iface => ({
        name: iface,
        addresses: networkInterfaces[iface]?.map(addr => ({
          family: addr.family,
          address: addr.address,
          netmask: addr.netmask,
          internal: addr.internal,
        })) || [],
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function formatUptime (seconds: number): string
{
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else {
    return `${minutes}m`;
  }
}

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

// Backup configuration routes
router.get('/instances/:id/backup/config', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const config = getBackupConfig(id);
    res.json({ config });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/instances/:id/backup/config', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const instance = getInstance(id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    const existingConfig = getBackupConfig(id);
    const configData = req.body;

    if (existingConfig) {
      const updated = updateBackupConfig(id, configData);
      if (configData.schedule) {
        scheduleInstanceBackup(id, configData.schedule);
      }
      res.json({ config: updated });
    } else {
      const newConfig = createBackupConfig({
        id: uuidv4(),
        instance_id: id,
        enabled: configData.enabled ?? 1,
        schedule: configData.schedule || '0 2 * * 0',
        retention_days: configData.retention_days || 30,
        backup_types: configData.backup_types || 'database,volume',
        local_path: configData.local_path,
        rsync_target: configData.rsync_target,
        s3_bucket: configData.s3_bucket,
        s3_region: configData.s3_region,
        s3_access_key: configData.s3_access_key,
        s3_secret_key: configData.s3_secret_key,
        s3_endpoint: configData.s3_endpoint,
      });
      if (newConfig.enabled) {
        scheduleInstanceBackup(id, newConfig.schedule);
      }
      res.json({ config: newConfig });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/instances/:id/backup/config', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    unscheduleInstanceBackup(id);
    deleteBackupConfig(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/instances/:id/backup/history', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const limit = parseInt(req.query.limit as string) || 50;
    const history = getBackupHistory(id, limit);
    res.json({ history });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/instances/:id/backup/trigger', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const instance = getInstance(id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    const backupType = req.body.type || 'database,volume';
    const backupId = uuidv4();

    if (backupType.includes('database')) {
      const result = await backupDatabase(instance, backupId);
      if (!result.success) {
        res.status(500).json({ error: result.error });
        return;
      }
    }

    if (backupType.includes('volume')) {
      const volumeBackupId = uuidv4();
      const result = await backupVolume(instance, volumeBackupId);
      if (!result.success) {
        res.status(500).json({ error: result.error });
        return;
      }
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/instances/:id/backup/restore', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const instance = getInstance(id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    const { backupId, force } = req.body;
    if (!backupId) {
      res.status(400).json({ error: 'backupId is required' });
      return;
    }

    const entry = getBackupHistoryById(backupId);
    if (!entry) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }
    if (entry.status !== 'completed') {
      res.status(400).json({ error: 'Backup is not in completed state' });
      return;
    }
    if (!entry.file_path) {
      res.status(400).json({ error: 'Backup has no file path' });
      return;
    }

    const fs = await import('fs/promises');
    try { await fs.access(entry.file_path); } catch {
      res.status(404).json({ error: 'Backup file not found on disk' });
      return;
    }

    if (entry.backup_type !== 'database' && entry.backup_type !== 'volume') {
      res.status(400).json({ error: `Unknown backup type: ${entry.backup_type}` });
      return;
    }

    // Version compatibility check
    const backupVersion = entry.convex_version || 'unknown';
    const currentVersion = instance.detected_version || instance.pinned_version || 'unknown';

    if (backupVersion !== currentVersion && backupVersion !== 'unknown' && currentVersion !== 'unknown') {
      if (!force) {
        res.status(409).json({
          error: 'Version mismatch',
          warning: `Backup created with Convex version ${backupVersion}, but instance is currently running ${currentVersion}.`,
          backupVersion,
          currentVersion,
          requiresForce: true
        });
        return;
      }
    }

    // Auto-snapshot current state before overwriting
    const snapshotIds: string[] = [];
    if (entry.backup_type === 'database') {
      const snapshotId = uuidv4();
      const snap = await backupDatabase(instance, snapshotId, 'Pre-restore snapshot');
      if (snap.success) snapshotIds.push(snapshotId);
      else { res.status(500).json({ error: `Pre-restore snapshot failed: ${snap.error}` }); return; }
    } else if (entry.backup_type === 'volume') {
      const snapshotId = uuidv4();
      const snap = await backupVolume(instance, snapshotId, 'Pre-restore snapshot');
      if (snap.success) snapshotIds.push(snapshotId);
      else { res.status(500).json({ error: `Pre-restore snapshot failed: ${snap.error}` }); return; }
    }

    // Stop backend + dashboard so they release DB/volume handles and stale cache
    const docker = new Docker();
    const toStop = ['dashboard', 'backend'] as const;
    for (const role of toStop) {
      try {
        const container = await getContainerByRole(instance, role);
        if (container) await container.stop({ t: 10 });
      } catch (e: any) { if (!e.message?.includes('not running') && e.statusCode !== 304 && e.statusCode !== 404) throw e; }
    }

    let restoreErr: Error | null = null;
    try {
      if (entry.backup_type === 'database') {
        await restoreDatabase(instance, entry.file_path);
      } else {
        await restoreVolume(instance, entry.file_path);
      }
    } catch (e: any) {
      restoreErr = e;
    }

    // Always attempt to start containers back up
    const toStart = ['backend', 'dashboard'] as const;
    for (const role of toStart) {
      try {
        const container = await getContainerByRole(instance, role);
        if (container) await container.start();
      } catch (e: any) { if (!e.message?.includes('already started') && e.statusCode !== 304 && e.statusCode !== 404) console.error('restart failed:', e.message); }
    }

    if (restoreErr) {
      res.status(500).json({ error: restoreErr.message, snapshotIds });
      return;
    }

    // Mark the restored backup with restore timestamp and link pre-restore snapshot
    updateBackupHistory(entry.id, {
      restored_at: new Date().toISOString(),
      pre_restore_snapshot_id: snapshotIds[0] || undefined,
    });

    res.json({ success: true, snapshotIds, versionWarning: backupVersion !== currentVersion ? `Restored from version ${backupVersion} to ${currentVersion}` : undefined });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Backup details endpoint
router.get('/backups/:id/details', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const entry = getBackupHistoryById(id);
    if (!entry) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }

    const syncStatus = getBackupSyncStatus(id);
    let preRestoreBackup: BackupHistory | undefined = undefined;
    if (entry.pre_restore_snapshot_id) {
      preRestoreBackup = getBackupHistoryById(entry.pre_restore_snapshot_id);
    }

    res.json({
      backup: entry,
      syncStatus,
      preRestoreBackup,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete local backup file (keep metadata)
router.delete('/backups/:id/local', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const entry = getBackupHistoryById(id);
    if (!entry) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }

    if (!entry.file_path) {
      res.status(400).json({ error: 'Backup has no local file' });
      return;
    }

    const fs = await import('fs/promises');
    await fs.unlink(entry.file_path);

    updateBackupHistory(id, { file_path: undefined });

    res.json({ success: true });
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Local file not found' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

// Backup destinations routes
router.get('/instances/:id/destinations', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const destinations = getBackupDestinations(id);
    res.json({ destinations });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/instances/:id/destinations', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { randomUUID } = await import('crypto');
    const destination = createBackupDestination({
      id: randomUUID(),
      instance_id: id,
      destination_type: req.body.destination_type,
      ...req.body,
    });
    res.json({ destination });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/destinations/:id', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const destination = updateBackupDestination(id, req.body);
    res.json({ destination });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/destinations/:id', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const success = deleteBackupDestination(id);
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Global backup settings routes
router.get('/backup/settings', async (_req: Request, res: Response) =>
{
  try {
    const settings = getBackupSettings();
    res.json({ settings });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/backup/settings', async (req: Request, res: Response) =>
{
  try {
    const settings = updateBackupSettings(req.body);
    if (settings.enabled) {
      const { scheduleGlobalBackup } = await import('./scheduler.js');
      scheduleGlobalBackup(settings.default_schedule);
    } else {
      const { unscheduleGlobalBackup } = await import('./scheduler.js');
      unscheduleGlobalBackup();
    }
    res.json({ settings });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// SSH key management for rsync
router.get('/backup/ssh-key', async (_req: Request, res: Response) =>
{
  try {
    const os = await import('os');
    const fs = await import('fs/promises');
    const sshDir = path.join(os.homedir(), '.ssh');
    const keyPath = path.join(sshDir, 'id_ed25519');
    const pubKeyPath = keyPath + '.pub';

    await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });

    let exists = false;
    try {
      await fs.access(pubKeyPath);
      exists = true;
    } catch { }

    if (!exists) {
      await execAsync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -C "convexer-backup@$(hostname)"`);
    }

    const publicKey = await fs.readFile(pubKeyPath, 'utf-8');
    res.json({ publicKey: publicKey.trim() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Test backup destination connectivity (rsync, koofr, webdav)
router.post('/backup/test-destination', async (req: Request, res: Response) =>
{
  try {
    const { destination_type, rsync_target, koofr_email, koofr_password, webdav_url, webdav_user, webdav_password, remote_subfolder } = req.body;

    if (destination_type === 'rsync') {
      if (!rsync_target) {
        res.status(400).json({ error: 'rsync_target is required' });
        return;
      }
      const target = remote_subfolder
        ? `${rsync_target.replace(/\/$/, '')}/${remote_subfolder.replace(/^\/+|\/+$/g, '')}`
        : rsync_target;
      const { stdout, stderr } = await execAsync(
        `rsync -avzn --timeout=10 -e "ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10" /etc/hostname "${target}/"`,
        { timeout: 15000 }
      );
      res.json({ success: true, output: stdout + stderr });
      return;
    }

    if (destination_type === 'koofr' || destination_type === 'webdav') {
      const url = destination_type === 'koofr' ? 'https://app.koofr.net/dav/Koofr' : webdav_url;
      const user = destination_type === 'koofr' ? koofr_email : webdav_user;
      const pass = destination_type === 'koofr' ? koofr_password : webdav_password;

      if (!url || !user || !pass) {
        res.status(400).json({ error: 'Missing credentials' });
        return;
      }

      const { stdout: obscured } = await execAsync(`rclone obscure "${pass.replace(/"/g, '\\"')}"`);
      const obscuredPass = obscured.trim();
      const remote = `:webdav,url="${url}",vendor="other",user="${user}",pass="${obscuredPass}":`;
      const remotePath = remote_subfolder
        ? `${remote}${remote_subfolder.replace(/^\/+|\/+$/g, '')}`
        : remote;

      const { stdout, stderr } = await execAsync(
        `rclone lsd "${remotePath}" --config /dev/null --contimeout 10s --timeout 15s`,
        { timeout: 20000 }
      );
      res.json({ success: true, output: stdout + stderr || 'Connected successfully' });
      return;
    }

    res.status(400).json({ error: 'Unknown destination_type' });
  } catch (err: any) {
    res.status(500).json({ error: err.message, stderr: err.stderr });
  }
});

// Container info for an instance
router.get('/instances/:id/containers', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const instance = getInstance(id);
    if (!instance) { res.status(404).json({ error: 'Instance not found' }); return; }

    const roles: Array<'backend' | 'dashboard' | 'postgres' | 'betterauth'> = ['backend', 'dashboard', 'postgres', 'betterauth'];

    const containers = await Promise.all(roles.map(async (role) =>
    {
      const containerName = `convexer-${role}-${instance.name}`;
      try {
        // Use getContainerByRole which looks up by name first and auto-syncs DB
        const c = await getContainerByRole(instance, role);
        if (!c) {
          return { role, name: containerName, image: null, status: 'not found', running: false, startedAt: null, restartCount: 0, ports: [] };
        }
        const info = await c.inspect();
        const portBindings = info.HostConfig?.PortBindings || {};
        const ports = Object.entries(portBindings).map(([containerPort, bindings]: [string, any]) => ({
          containerPort,
          hostPort: bindings?.[0]?.HostPort,
        }));
        return {
          role,
          name: info.Name.replace(/^\//, ''),
          image: info.Config.Image,
          status: info.State.Status,
          running: info.State.Running,
          startedAt: info.State.StartedAt,
          restartCount: info.RestartCount,
          ports,
        };
      } catch {
        return { role, name: containerName, image: null, status: 'not found', running: false, startedAt: null, restartCount: 0, ports: [] };
      }
    }));

    res.json({ containers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Instance duplication endpoint
router.post('/instances/:id/duplicate', async (req: Request, res: Response) =>
{
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const sourceInstance = getInstance(id);
    if (!sourceInstance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    const { newName } = req.body;
    if (!newName) {
      res.status(400).json({ error: 'New instance name is required' });
      return;
    }

    // Check if name is already taken
    const { getAllInstances } = await import('./db.js');
    const existingInstance = getAllInstances().find(i => i.name === newName);
    if (existingInstance) {
      res.status(400).json({ error: 'Instance name already exists' });
      return;
    }

    // Create backup of source instance
    const { randomUUID } = await import('crypto');
    const dbBackupId = randomUUID();
    const volBackupId = randomUUID();

    const dbResult = await backupDatabase(sourceInstance, dbBackupId);
    if (!dbResult.success) {
      res.status(500).json({ error: `Database backup failed: ${dbResult.error}` });
      return;
    }

    const volResult = await backupVolume(sourceInstance, volBackupId);
    if (!volResult.success) {
      res.status(500).json({ error: `Volume backup failed: ${volResult.error}` });
      return;
    }

    // Allocate ports for new instance
    const ports = allocatePorts();

    // Build new extra_env: copy source env but regenerate subdomain keys
    const sourceEnv = sourceInstance.extra_env ? JSON.parse(sourceInstance.extra_env) : {};
    const domain = process.env.DOMAIN || '';
    const newExtraEnv = {
      ...sourceEnv,
      BACKEND_DOMAIN: domain ? `${newName}.${domain}` : newName,
      SITE_DOMAIN: domain ? `${newName}-site.${domain}` : `${newName}-site`,
      DASHBOARD_DOMAIN: domain ? `${newName}-dash.${domain}` : `${newName}-dash`,
    };

    // Create new instance
    const { admin_key: _, instance_secret: __, ...rest } = sourceInstance;
    const newInstance = createInstance({
      id: uuidv4(),
      name: newName,
      status: 'creating',
      backend_port: ports.backendPort,
      site_proxy_port: ports.siteProxyPort,
      dashboard_port: ports.dashboardPort,
      postgres_port: ports.postgresPort,
      betterauth_port: ports.betterauthPort,
      volume_name: `convexer-${newName}-data`,
      postgres_volume_name: `convexer-postgres-${newName}`,
      postgres_password: crypto.randomBytes(32).toString('hex'),
      instance_name: newName,
      instance_secret: crypto.randomBytes(32).toString('hex'),
      extra_env: JSON.stringify(newExtraEnv),
      pinned_version: sourceInstance.pinned_version,
      detected_version: null,
      health_check_timeout: sourceInstance.health_check_timeout || 300000,
      postgres_health_check_timeout: sourceInstance.postgres_health_check_timeout || 60000,
    });

    // Create and start new instance; restore DB + volume after postgres is ready but before backend starts
    await createAndStartInstance(newInstance, async () =>
    {
      if (dbResult.filePath) {
        const sql = await (await import('fs/promises')).readFile(dbResult.filePath, 'utf-8');
        await restoreBackup(newInstance, sql);
      }
      if (volResult.filePath) {
        const { restoreVolume } = await import('./backup.js');
        await restoreVolume(newInstance, volResult.filePath);
      }
    });

    res.json({ instance: getInstance(newInstance.id) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Monitoring container logs
const MONITORING_CONTAINERS: Record<string, string> = {
  'umami': 'convexer-umami',
  'umami-db': 'convexer-umami-db',
  'glitchtip-web': 'convexer-glitchtip-web',
  'glitchtip-worker': 'convexer-glitchtip-worker',
  'glitchtip-db': 'convexer-glitchtip-db',
  'glitchtip-redis': 'convexer-glitchtip-redis',
};

router.get('/monitoring/logs', async (req: Request, res: Response) =>
{
  const container = req.query.container as string;
  const tail = parseInt(req.query.tail as string) || 300;
  const containerName = MONITORING_CONTAINERS[container];
  if (!containerName) {
    res.status(400).json({ error: `Unknown container: ${container}. Valid: ${Object.keys(MONITORING_CONTAINERS).join(', ')}` });
    return;
  }
  try {
    const logs = await getContainerLogs(containerName, tail);
    res.json({ logs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Monitoring stack status
router.get('/monitoring/status', async (_req: Request, res: Response) =>
{
  const domain = process.env.DOMAIN || '';
  const umamiUrl = domain ? `http://umami.${domain}` : 'http://localhost:3000';
  const glitchtipUrl = domain ? `http://glitchtip.${domain}` : 'http://localhost:8000';

  const containers = [
    { key: 'umami', name: 'convexer-umami' },
    { key: 'umami_db', name: 'convexer-umami-db' },
    { key: 'glitchtip_web', name: 'convexer-glitchtip-web' },
    { key: 'glitchtip_worker', name: 'convexer-glitchtip-worker' },
    { key: 'glitchtip_db', name: 'convexer-glitchtip-db' },
    { key: 'glitchtip_redis', name: 'convexer-glitchtip-redis' },
  ];

  const statuses: Record<string, { running: boolean; status: string }> = {};
  for (const { key, name } of containers) {
    try {
      const info = await docker.getContainer(name).inspect();
      statuses[key] = { running: info.State.Running, status: info.State.Status };
    } catch {
      statuses[key] = { running: false, status: 'not found' };
    }
  }

  // Check if admin accounts exist
  let umamiAdminExists = false;
  let glitchtipAdminExists = false;

  try {
    const umamiDb = docker.getContainer('convexer-umami-db');
    const exec = await umamiDb.exec({
      Cmd: ['psql', '-U', 'umami', '-d', 'umami', '-t', '-c', 'SELECT COUNT(*) FROM "user" WHERE role = \'admin\''],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const output = await new Promise<string>((resolve) =>
    {
      let data = '';
      stream.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      stream.on('end', () => resolve(data));
    });
    umamiAdminExists = parseInt(output.replace(/\D/g, '') || '0', 10) > 0;
  } catch { /* ignore */ }

  try {
    const glitchtipDb = docker.getContainer('convexer-glitchtip-db');
    const exec = await glitchtipDb.exec({
      Cmd: ['psql', '-U', 'glitchtip', '-d', 'glitchtip', '-t', '-c', 'SELECT COUNT(*) FROM users_user WHERE is_superuser = true'],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const output = await new Promise<string>((resolve) =>
    {
      let data = '';
      stream.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      stream.on('end', () => resolve(data));
    });
    glitchtipAdminExists = parseInt(output.replace(/\D/g, '') || '0', 10) > 0;
  } catch { /* ignore */ }

  res.json({
    umami: {
      url: umamiUrl,
      running: statuses.umami.running,
      status: statuses.umami.status,
      db_status: statuses.umami_db.status,
      admin_exists: umamiAdminExists,
    },
    glitchtip: {
      url: glitchtipUrl,
      running: statuses.glitchtip_web.running,
      status: statuses.glitchtip_web.status,
      worker_status: statuses.glitchtip_worker.status,
      db_status: statuses.glitchtip_db.status,
      redis_status: statuses.glitchtip_redis.status,
      admin_exists: glitchtipAdminExists,
    },
  });
});

// Setup Umami admin account (change password)
router.post('/monitoring/umami/setup', async (req: Request, res: Response) =>
{
  try {
    const { password } = req.body;
    if (!password || password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    // Umami uses bcrypt for password hashing - we need to hash it properly
    // The default admin password is 'umami' - we'll update it via the database
    const bcrypt = await import('bcrypt');
    const hashedPassword = await bcrypt.hash(password, 10);

    const umamiDb = docker.getContainer('convexer-umami-db');
    const exec = await umamiDb.exec({
      Cmd: ['psql', '-U', 'umami', '-d', 'umami', '-c', `UPDATE "user" SET password = '${hashedPassword}' WHERE username = 'admin'`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve, reject) =>
    {
      const timeout = setTimeout(() =>
      {
        stream.destroy();
        resolve(); // Resolve anyway - the command likely succeeded
      }, 10000);
      stream.on('data', () => { }); // Consume data to prevent backpressure
      stream.on('end', () => { clearTimeout(timeout); resolve(); });
      stream.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });

    res.json({ success: true, message: 'Umami admin password updated. Login with username: admin' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Setup GlitchTip admin account
router.post('/monitoring/glitchtip/setup', async (req: Request, res: Response) =>
{
  try {
    const { email, password } = req.body;
    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'Valid email is required' });
      return;
    }
    if (!password || password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    // Use Django's createsuperuser with environment variables for non-interactive mode
    const glitchtipWeb = docker.getContainer('convexer-glitchtip-web');
    const exec = await glitchtipWeb.exec({
      Cmd: ['./manage.py', 'createsuperuser', '--noinput', '--email', email],
      Env: [`DJANGO_SUPERUSER_PASSWORD=${password}`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const output = await new Promise<string>((resolve) =>
    {
      let data = '';
      stream.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      stream.on('end', () => resolve(data));
    });

    if (output.includes('already exists') || output.includes('duplicate key')) {
      res.status(400).json({ error: 'An admin account with this email already exists' });
      return;
    }

    res.json({ success: true, message: `GlitchTip admin account created. Login with email: ${email}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
