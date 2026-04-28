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
  deleteBackupDestination,
  getPushConfig,
  upsertPushConfig,
  getPushDeliveryLogs,
  createPushDeliveryLog,
  createUpdateJob,
  getLatestUpdateJob,
  getUpdateJob,
  updateUpdateJob,
  appendUpdateJobLog,
  createActionAuditLog
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
  getContainerByRole,
  removeBetterAuthSidecar,
  createBetterAuthSidecar
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
import { sendPush, supportedPushProviders, PushProvider } from './push.js';
import { AppError, asError, err, ok } from './http.js';
import { createInstanceSchema, parseOrThrow, postgresQuerySchema, repairCleanupSchema, rollbackSchema, toExtraEnvJson, updateAppSchema, updateHealthCheckSchema, updateSettingsSchema } from './validation.js';

const execAsync = promisify(exec);
const docker = new Docker();
const CONVEX_BACKEND_IMAGE = 'ghcr.io/get-convex/convex-backend';
const CONVEX_DASHBOARD_IMAGE = 'ghcr.io/get-convex/convex-dashboard';
const BETTERAUTH_IMAGE = 'convexer-better-auth-sidecar:latest';

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

type InstanceContainerRole = 'backend' | 'dashboard' | 'betterauth';
type UpdateStrategy = 'image' | 'git';

async function getImageId (image: string): Promise<string | null>
{
  try {
    const info = await docker.getImage(image).inspect();
    return info.Id || null;
  } catch {
    return null;
  }
}

function shortImageId (imageId: string | null): string | null
{
  return imageId?.replace(/^sha256:/, '').slice(0, 12) || null;
}

async function getInstanceImageStatus (
  instance: Instance,
  targetVersion = 'latest',
  pullRemote = false
): Promise<{
    current_version: string;
    target_version: string;
    has_update: boolean;
    containers: Array<{
      role: InstanceContainerRole;
      image: string;
      current_image: string | null;
      current_image_id: string | null;
      target_image_id: string | null;
      update_available: boolean;
      running: boolean;
    }>;
  }>
{
  const tag = targetVersion || 'latest';
  const desiredImages: Record<InstanceContainerRole, string> = {
    backend: `${CONVEX_BACKEND_IMAGE}:${tag}`,
    dashboard: `${CONVEX_DASHBOARD_IMAGE}:${tag}`,
    betterauth: BETTERAUTH_IMAGE,
  };

  if (pullRemote) {
    await pullImage(desiredImages.backend);
    await pullImage(desiredImages.dashboard);
  }

  const containers = await Promise.all((Object.keys(desiredImages) as InstanceContainerRole[]).map(async (role) =>
  {
    let currentImageId: string | null = null;
    let currentImage: string | null = null;
    let running = false;
    const container = await getContainerByRole(instance, role);
    if (container) {
      try {
        const info = await container.inspect();
        currentImageId = info.Image || null;
        currentImage = info.Config?.Image || null;
        running = Boolean(info.State?.Running);
      } catch {
        // Treat missing/uninspectable containers as not running.
      }
    }

    const targetImageId = await getImageId(desiredImages[role]);
    const updateAvailable = Boolean(currentImageId && targetImageId && currentImageId !== targetImageId);

    return {
      role,
      image: desiredImages[role],
      current_image: currentImage,
      current_image_id: shortImageId(currentImageId),
      target_image_id: shortImageId(targetImageId),
      update_available: updateAvailable,
      running,
    };
  }));

  return {
    current_version: instance.detected_version || instance.pinned_version || 'latest',
    target_version: tag,
    has_update: containers.some(container => container.update_available),
    containers,
  };
}

function getUpdateStrategy(): UpdateStrategy {
  return (process.env.UPDATE_STRATEGY || 'image') === 'git' ? 'git' : 'image';
}

async function checkHealth(url: string, retries = 10, delayMs = 2000): Promise<boolean> {
  for (let i = 0; i < retries; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // noop
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return false;
}

async function appendJobLog(jobId: string, message: string, progress?: number) {
  appendUpdateJobLog(jobId, `[${new Date().toISOString()}] ${message}`);
  if (typeof progress === 'number') {
    updateUpdateJob(jobId, { progress });
  }
}

function audit(action: string, status: string, details?: string, target?: string) {
  createActionAuditLog({
    id: randomUUID(),
    action,
    status,
    details: details ?? null,
    target: target ?? null,
  });
}

async function runImageUpdateJob(jobId: string, targetVersion: string) {
  const baseImage = process.env.CONVEXER_IMAGE || 'convexer-convexer';
  const sidecarImage = process.env.BETTERAUTH_IMAGE || 'convexer-better-auth-sidecar';
  const targetAppImage = `${baseImage}:${targetVersion}`;
  const targetSidecarImage = `${sidecarImage}:${targetVersion}`;
  const candidateName = 'convexer-candidate';
  const rollbackRef = process.env.CONVEXER_IMAGE_ROLLBACK || 'convexer-convexer:latest';

  try {
    updateUpdateJob(jobId, { status: 'running', progress: 2, started_at: new Date().toISOString() });
    await appendJobLog(jobId, 'Running preflight checks', 5);

    await docker.info();
    const networks = await docker.listNetworks();
    const hasNetwork = networks.some(n => n.Name === 'convexer-net');
    if (!hasNetwork) {
      throw new AppError(500, 'PREFLIGHT_NETWORK_MISSING', 'convexer-net is missing');
    }

    await appendJobLog(jobId, `Pulling ${targetAppImage}`, 15);
    await pullImage(targetAppImage);
    await appendJobLog(jobId, `Pulling ${targetSidecarImage}`, 25);
    await pullImage(targetSidecarImage);

    const current = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ name: ['convexer'] }),
    });
    const previousContainerId = current[0]?.Id;

    await appendJobLog(jobId, 'Starting candidate container on port 4001', 40);
    try {
      const stale = docker.getContainer(candidateName);
      await stale.remove({ force: true });
    } catch {
      // noop
    }

    const candidate = await docker.createContainer({
      Image: targetAppImage,
      name: candidateName,
      Env: [
        `DATA_DIR=${process.env.DATA_DIR || '/app/server/data'}`,
        `DOMAIN=${process.env.DOMAIN || ''}`,
        `TUNNEL_DOMAIN=${process.env.TUNNEL_DOMAIN || ''}`,
        `TUNNEL_CONFIG_PATH=${process.env.TUNNEL_CONFIG_PATH || ''}`,
        `AUTH_PASSWORD=${process.env.AUTH_PASSWORD || ''}`,
        `GITHUB_REPO=${process.env.GITHUB_REPO || 'malipetek/convexer'}`,
        `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''}`,
        `HOST_PROJECT_PATH=${process.env.HOST_PROJECT_PATH || '/home/convexer'}`,
        `UPDATE_BRANCH=${process.env.UPDATE_BRANCH || 'main'}`,
        `UPDATE_STRATEGY=${getUpdateStrategy()}`,
        `CONVEXER_IMAGE=${baseImage}`,
        `BETTERAUTH_IMAGE=${sidecarImage}`,
      ],
      HostConfig: {
        NetworkMode: 'convexer-net',
        Binds: [
          '/var/run/docker.sock:/var/run/docker.sock',
          'convexer-data:/app/server/data',
          'convexer-ssh:/root/.ssh',
          'convexer-backups:/app/server/data/backups',
          `${process.env.HOST_PROJECT_PATH || '/home/convexer'}/server/data:/app/host-data:ro`,
        ],
        PortBindings: {
          '4000/tcp': [{ HostPort: '4001' }],
        },
      },
      ExposedPorts: { '4000/tcp': {} },
    });
    await candidate.start();

    await appendJobLog(jobId, 'Health checking candidate container', 55);
    const candidateHealthy = await checkHealth('http://127.0.0.1:4001/api/health');
    if (!candidateHealthy) {
      throw new AppError(500, 'CANDIDATE_HEALTH_FAILED', 'Candidate container failed health checks');
    }

    await appendJobLog(jobId, 'Swapping active container', 70);
    if (previousContainerId) {
      const previous = docker.getContainer(previousContainerId);
      try {
        await previous.stop();
      } catch {
        // noop
      }
      try {
        await previous.remove({ force: true });
      } catch {
        // noop
      }
    }

    await candidate.remove({ force: true });
    const finalContainer = await docker.createContainer({
      Image: targetAppImage,
      name: 'convexer',
      Env: [
        `DATA_DIR=${process.env.DATA_DIR || '/app/server/data'}`,
        `DOMAIN=${process.env.DOMAIN || ''}`,
        `TUNNEL_DOMAIN=${process.env.TUNNEL_DOMAIN || ''}`,
        `TUNNEL_CONFIG_PATH=${process.env.TUNNEL_CONFIG_PATH || ''}`,
        `AUTH_PASSWORD=${process.env.AUTH_PASSWORD || ''}`,
        `GITHUB_REPO=${process.env.GITHUB_REPO || 'malipetek/convexer'}`,
        `GITHUB_TOKEN=${process.env.GITHUB_TOKEN || ''}`,
        `HOST_PROJECT_PATH=${process.env.HOST_PROJECT_PATH || '/home/convexer'}`,
        `UPDATE_BRANCH=${process.env.UPDATE_BRANCH || 'main'}`,
        `UPDATE_STRATEGY=${getUpdateStrategy()}`,
        `CONVEXER_IMAGE=${baseImage}`,
        `BETTERAUTH_IMAGE=${sidecarImage}`,
      ],
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: 'convexer-net',
        Binds: [
          '/var/run/docker.sock:/var/run/docker.sock',
          'convexer-data:/app/server/data',
          'convexer-ssh:/root/.ssh',
          'convexer-backups:/app/server/data/backups',
          `${process.env.HOST_PROJECT_PATH || '/home/convexer'}/server/data:/app/host-data:ro`,
        ],
        PortBindings: {
          '4000/tcp': [{ HostPort: '4000' }],
        },
      },
      ExposedPorts: { '4000/tcp': {} },
      Labels: {
        'traefik.enable': 'true',
        'traefik.http.routers.convexer.rule': `Host(\`${process.env.DOMAIN || ''}\`)`,
        'traefik.http.routers.convexer.entrypoints': 'web',
        'traefik.http.services.convexer.loadbalancer.server.port': '4000',
      },
    });
    await finalContainer.start();

    await appendJobLog(jobId, 'Validating final container health', 85);
    const finalHealthy = await checkHealth('http://127.0.0.1:4000/api/health');
    if (!finalHealthy) {
      throw new AppError(500, 'FINAL_HEALTH_FAILED', 'Final container failed health checks');
    }

    updateUpdateJob(jobId, {
      status: 'success',
      progress: 100,
      completed_at: new Date().toISOString(),
      health_result: 'ok',
      rollback_ref: rollbackRef,
    });
    audit('update.image', 'success', `Updated to ${targetAppImage}`, jobId);
  } catch (error) {
    const appError = asError(error);
    updateUpdateJob(jobId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: appError.message,
    });
    appendUpdateJobLog(jobId, `[${new Date().toISOString()}] update failed: ${appError.message}`);
    audit('update.image', 'failed', appError.message, jobId);
  }
}

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
  const input = parseOrThrow(createInstanceSchema, req.body);
  const { name, extra_env } = input;
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
    name: name || `instance-${Date.now()}`,
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
    extra_env: toExtraEnvJson(extra_env),
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
  try {
    const instance = getInstance(req.params.id as string);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    const { health_check_timeout, postgres_health_check_timeout } = parseOrThrow(updateHealthCheckSchema, req.body);

    const updated = updateInstance(instance.id, {
      health_check_timeout: health_check_timeout,
      postgres_health_check_timeout: postgres_health_check_timeout,
    });

    res.json(updated);
  } catch (error) {
    const appError = asError(error);
    err(res, appError.status, appError.code, appError.message, appError.details);
  }
});

// Update instance settings (extra_env)
router.put('/instances/:id/settings', async (req: Request, res: Response) =>
{
  try {
    const instance = getInstance(req.params.id as string);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    const { extra_env } = parseOrThrow(updateSettingsSchema, req.body);

    // Store new extra_env
    const updated = updateInstance(instance.id, {
      extra_env: toExtraEnvJson(extra_env),
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

    // Stop and remove betterauth container so it gets recreated with new env
    try {
      await removeBetterAuthSidecar(instance);
    } catch (err: any) {
      console.warn('Failed to remove betterauth sidecar:', err.message);
    }

    // Recreate backend with new env (this also recreates betterauth)
    try {
      await createAndStartInstance(updated);
    } catch (err: any) {
      console.error('Failed to recreate backend:', err.message);
      res.status(500).json({ error: err.message });
      return;
    }

    res.json(getInstance(instance.id));
  } catch (error) {
    const appError = asError(error);
    err(res, appError.status, appError.code, appError.message, appError.details);
  }
});

router.get('/instances/:id/push/config', (req: Request, res: Response) => {
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const config = getPushConfig(instance.id);
  if (!config) {
    res.json({
      config: {
        provider: 'unifiedpush',
        enabled: 0,
        config: {},
      },
      providers: supportedPushProviders(),
    });
    return;
  }

  let parsedConfig: Record<string, unknown> = {};
  try {
    parsedConfig = JSON.parse(config.config_json);
  } catch {
    parsedConfig = {};
  }

  res.json({
    config: {
      provider: config.provider,
      enabled: config.enabled,
      config: parsedConfig,
      updated_at: config.updated_at,
    },
    providers: supportedPushProviders(),
  });
});

router.put('/instances/:id/push/config', (req: Request, res: Response) => {
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const provider = req.body.provider as PushProvider;
  const enabled = req.body.enabled ? 1 : 0;
  const config = req.body.config;

  if (!supportedPushProviders().includes(provider)) {
    res.status(400).json({ error: `Unsupported provider: ${provider}` });
    return;
  }

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    res.status(400).json({ error: 'config must be an object' });
    return;
  }

  const existing = getPushConfig(instance.id);
  const saved = upsertPushConfig({
    id: existing?.id ?? uuidv4(),
    instance_id: instance.id,
    provider,
    enabled,
    config_json: JSON.stringify(config),
  });

  res.json({
    config: {
      provider: saved.provider,
      enabled: saved.enabled,
      config,
      updated_at: saved.updated_at,
    },
  });
});

router.post('/instances/:id/push/test', async (req: Request, res: Response) => {
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const pushConfig = getPushConfig(instance.id);
  if (!pushConfig) {
    res.status(400).json({ error: 'Push config not found for this instance' });
    return;
  }

  if (!pushConfig.enabled) {
    res.status(400).json({ error: 'Push config is disabled for this instance' });
    return;
  }

  const title = typeof req.body.title === 'string' && req.body.title.trim()
    ? req.body.title.trim()
    : `Test notification from ${instance.name}`;
  const body = typeof req.body.body === 'string' && req.body.body.trim()
    ? req.body.body.trim()
    : 'Push gateway test successful.';
  const data = req.body.data && typeof req.body.data === 'object' && !Array.isArray(req.body.data)
    ? req.body.data as Record<string, unknown>
    : {};

  const results = await sendPush(pushConfig.provider as PushProvider, pushConfig.config_json, { title, body, data });

  for (const attempt of results) {
    createPushDeliveryLog({
      id: uuidv4(),
      instance_id: instance.id,
      provider: pushConfig.provider,
      status: attempt.ok ? 'success' : 'error',
      target: attempt.target,
      title,
      body,
      response_code: attempt.statusCode ?? null,
      response_body: attempt.responseBody ?? null,
      error_message: attempt.error ?? null,
    });
  }

  res.json({
    success: results.every(result => result.ok),
    results,
  });
});

router.get('/instances/:id/push/logs', (req: Request, res: Response) => {
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(200, Math.floor(limitRaw))
    : 50;
  const logs = getPushDeliveryLogs(instance.id, limit);
  res.json({ logs });
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
    const backendImage = `${CONVEX_BACKEND_IMAGE}:${tag}`;
    const dashboardImage = `${CONVEX_DASHBOARD_IMAGE}:${tag}`;
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

    try {
      await removeBetterAuthSidecar(instance);
    } catch (err: any) {
      console.warn('Failed to stop/remove betterauth sidecar:', err.message);
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

router.get('/instances/:id/version/check', async (req: Request, res: Response) =>
{
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const targetVersion = typeof req.query.targetVersion === 'string' && req.query.targetVersion.trim()
    ? req.query.targetVersion.trim()
    : 'latest';

  try {
    const status = await getInstanceImageStatus(instance, targetVersion, true);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get container updates status for an instance
router.get('/instances/:id/container-updates', async (req: Request, res: Response) =>
{
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const targetVersion = typeof req.query.targetVersion === 'string' && req.query.targetVersion.trim()
    ? req.query.targetVersion.trim()
    : 'latest';

  try {
    const imageStatus = await getInstanceImageStatus(instance, targetVersion, false);

    // Enrich with additional container status information
    const enrichedContainers = await Promise.all(
      imageStatus.containers.map(async (container) =>
      {
        const containerObj = await getContainerByRole(instance, container.role);
        let restartCount = 0;
        let healthStatus: string | null = null;
        let stale = false;
        let broken = false;
        let reason: string | null = null;

        if (containerObj) {
          try {
            const info = await containerObj.inspect();
            restartCount = info.RestartCount || 0;
            healthStatus = info.State.Health?.Status || null;

            // Determine if container is stale (image ID mismatch)
            if (container.update_available) {
              stale = true;
              reason = `Image ${container.current_image_id} differs from target ${container.target_image_id}`;
            }

            // Determine if container is broken (unhealthy or restarting frequently)
            if (healthStatus === 'unhealthy') {
              broken = true;
              reason = reason ? `${reason}; unhealthy` : 'Container health check failed';
            }
            if (restartCount > 5) {
              broken = true;
              reason = reason ? `${reason}; high restart count (${restartCount})` : `High restart count (${restartCount})`;
            }
          } catch (err: any) {
            broken = true;
            reason = `Failed to inspect container: ${err.message}`;
          }
        } else {
          // Container doesn't exist
          stale = true;
          broken = true;
          reason = 'Container does not exist';
        }

        return {
          ...container,
          restart_count: restartCount,
          health_status: healthStatus,
          stale,
          broken,
          reason,
        };
      })
    );

    res.json({
      current_version: imageStatus.current_version,
      target_version: imageStatus.target_version,
      has_update: imageStatus.has_update,
      containers: enrichedContainers,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Apply container updates (recreate stale/broken containers)
router.post('/instances/:id/container-updates/apply', async (req: Request, res: Response) =>
{
  const instance = getInstance(req.params.id as string);
  if (!instance) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  const { targetVersion = 'latest', roles = ['backend', 'dashboard', 'betterauth'], backup = true } = req.body;

  if (!Array.isArray(roles) || roles.length === 0) {
    res.status(400).json({ error: 'roles must be a non-empty array' });
    return;
  }

  const validRoles = ['backend', 'dashboard', 'betterauth'];
  const invalidRoles = roles.filter((r: string) => !validRoles.includes(r));
  if (invalidRoles.length > 0) {
    res.status(400).json({ error: `Invalid roles: ${invalidRoles.join(', ')}` });
    return;
  }

  try {
    // Pull target images first (skip Better Auth sidecar - it's built locally)
    const tag = targetVersion === 'latest' ? 'latest' : targetVersion;
    const imagesToPull: string[] = [];
    if (roles.includes('backend')) imagesToPull.push(`${CONVEX_BACKEND_IMAGE}:${tag}`);
    if (roles.includes('dashboard')) imagesToPull.push(`${CONVEX_DASHBOARD_IMAGE}:${tag}`);
    // Note: Better Auth sidecar is built locally as part of Convexer Dockerfile, not pulled from registry

    for (const image of imagesToPull) {
      await pullImage(image);
    }

    // Create backup if requested
    let backupIds: string[] = [];
    if (backup) {
      const dbBackupId = randomUUID();
      const volBackupId = randomUUID();
      try {
        const dbBackup = await backupDatabase(instance, dbBackupId, 'Pre-container-update backup');
        if (dbBackup.success) backupIds.push(dbBackupId);
      } catch (err: any) {
        console.warn(`Pre-update DB backup failed:`, err.message);
      }

      // Only backup volume if updating backend or dashboard (sidecar-only recreation needs DB backup only)
      if (roles.includes('backend') || roles.includes('dashboard')) {
        try {
          const volBackup = await backupVolume(instance, volBackupId, 'Pre-container-update backup');
          if (volBackup.success) backupIds.push(volBackupId);
        } catch (err: any) {
          console.warn(`Pre-update volume backup failed:`, err.message);
        }
      }
    }

    // Recreate selected containers
    const results: Array<{ role: string; success: boolean; error?: string }> = [];

    for (const role of roles) {
      try {
        if (role === 'betterauth') {
          await removeBetterAuthSidecar(instance);
          await createBetterAuthSidecar(instance);
          results.push({ role, success: true });
        } else if (role === 'backend') {
          const container = await getContainerByRole(instance, 'backend');
          if (container) {
            await container.stop();
            await container.remove();
          }
          // Recreate backend by calling createAndStartInstance with a hook that skips postgres
          await createAndStartInstance(instance, async () =>
          {
            // No-op - postgres already running
          });
          results.push({ role, success: true });
        } else if (role === 'dashboard') {
          const container = await getContainerByRole(instance, 'dashboard');
          if (container) {
            await container.stop();
            await container.remove();
          }
          // Recreate dashboard
          await createAndStartInstance(instance);
          results.push({ role, success: true });
        }
      } catch (err: any) {
        results.push({ role, success: false, error: err.message });
      }
    }

    // Update detected version if backend was updated
    if (roles.includes('backend') && targetVersion !== 'latest') {
      updateInstance(instance.id, { detected_version: targetVersion });
    }

    res.json({
      success: true,
      results,
      backup_ids: backupIds.length > 0 ? backupIds : undefined,
    });
  } catch (err: any) {
    console.error('Container update failed:', err);
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
    const GITHUB_REPO = process.env.GITHUB_REPO || 'malipetek/convexer';
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
router.post('/version/update', async (req: Request, res: Response) =>
{
  const { targetVersion } = parseOrThrow(updateAppSchema, req.body ?? {});
  const strategy = getUpdateStrategy();

  if (strategy === 'image') {
    const selectedVersion = targetVersion || 'latest';
    const job = createUpdateJob({
      id: randomUUID(),
      target_version: selectedVersion,
      strategy,
      status: 'pending',
      progress: 0,
      logs: '',
      rollback_ref: process.env.CONVEXER_IMAGE_ROLLBACK || null,
      started_at: new Date().toISOString(),
    });
    audit('update.request', 'accepted', `strategy=image target=${selectedVersion}`, job.id);
    setTimeout(() => {
      runImageUpdateJob(job.id, selectedVersion).catch((error: unknown) => {
        const appError = asError(error);
        updateUpdateJob(job.id, {
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: appError.message,
        });
      });
    }, 50);
    ok(res, {
      success: true,
      jobId: job.id,
      strategy: 'image',
      message: 'Image update started',
    }, 202);
    return;
  }

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

echo "[updater] building Better Auth sidecar image as convexer-better-auth-sidecar:pending"
docker build -t convexer-better-auth-sidecar:pending --target betterauth-runtime -f Dockerfile . 2>&1 | tee -a /repo/server/data/.update_logs || {
  echo "[updater] BETTER AUTH SIDECAR BUILD FAILED - rolling back git"
  git checkout $(cat /repo/server/data/.rollback_commit) || true
  docker rmi convexer-convexer:pending 2>/dev/null || true
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
  docker rmi convexer-better-auth-sidecar:pending || true
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
docker rmi convexer-better-auth-sidecar:latest 2>/dev/null || true

echo "[updater] tagging pending as latest (keeping pending tag for rollback)"
docker tag convexer-convexer:pending convexer-convexer:latest
docker tag convexer-better-auth-sidecar:pending convexer-better-auth-sidecar:latest

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
  -e GITHUB_REPO=\${GITHUB_REPO:-malipetek/convexer} \\
  -e GITHUB_TOKEN=\${GITHUB_TOKEN:-} \\
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
    -e GITHUB_REPO=\${GITHUB_REPO:-malipetek/convexer} \\
    -e GITHUB_TOKEN=\${GITHUB_TOKEN:-} \\
    --restart unless-stopped \\
    --label "traefik.enable=true" \\
    --label "traefik.http.routers.convexer.rule=Host(\\\`\${DOMAIN}\\\`)" \\
    --label "traefik.http.routers.convexer.entrypoints=web" \\
    --label "traefik.http.services.convexer.loadbalancer.server.port=4000" \\
    convexer-convexer:pending
  echo "[updater] rolling back git to previous commit"
  git checkout $(cat /repo/server/data/.rollback_commit) || true
  echo "[updater] fallback container running on port 4000"
  docker rmi convexer-better-auth-sidecar:pending 2>/dev/null || true
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
    -e GITHUB_REPO=\${GITHUB_REPO:-malipetek/convexer} \\
    -e GITHUB_TOKEN=\${GITHUB_TOKEN:-} \\
    --restart unless-stopped \\
    --label "traefik.enable=true" \\
    --label "traefik.http.routers.convexer.rule=Host(\\\`\${DOMAIN}\\\`)" \\
    --label "traefik.http.routers.convexer.entrypoints=web" \\
    --label "traefik.http.services.convexer.loadbalancer.server.port=4000" \\
    convexer-convexer:pending
  echo "[updater] rolling back git to previous commit"
  git checkout $(cat /repo/server/data/.rollback_commit) || true
  echo "[updater] fallback container running on port 4000"
  docker rmi convexer-better-auth-sidecar:pending 2>/dev/null || true
  exit 1
fi

echo "[updater] cleaning up"
docker rm -f convexer-pending 2>/dev/null || true
docker rmi convexer-convexer:pending 2>/dev/null || true
docker rmi convexer-better-auth-sidecar:pending 2>/dev/null || true

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
  if (getUpdateStrategy() === 'image') {
    const job = getLatestUpdateJob();
    res.json({
      running: job?.status === 'pending' || job?.status === 'running',
      state: job?.status || 'idle',
      status: job?.status || 'idle',
      logs: job?.logs || '',
      jobId: job?.id || null,
    });
    return;
  }
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
  if (getUpdateStrategy() === 'image') {
    const job = getLatestUpdateJob();
    if (!job) {
      ok(res, { running: false, success: null, jobId: null, status: 'idle', progress: 0, rollbackAvailable: false });
      return;
    }
    const running = job.status === 'pending' || job.status === 'running';
    const success = job.status === 'success' ? true : (job.status === 'failed' ? false : null);
    ok(res, {
      running,
      success,
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      rollbackAvailable: Boolean(job.rollback_ref),
    });
    return;
  }
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
  if (getUpdateStrategy() === 'image') {
    const job = getLatestUpdateJob();
    ok(res, { logs: job?.logs || '', exists: Boolean(job?.logs), jobId: job?.id || null });
    return;
  }
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
  if (getUpdateStrategy() === 'image') {
    const job = getLatestUpdateJob();
    ok(res, { available: Boolean(job?.rollback_ref), commit: job?.rollback_ref || null, jobId: job?.id || null });
    return;
  }
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
  if (getUpdateStrategy() === 'image') {
    const { targetJobId } = parseOrThrow(rollbackSchema, _req.body ?? {});
    const job = targetJobId ? getUpdateJob(targetJobId) : getLatestUpdateJob();
    if (!job?.rollback_ref) {
      err(res, 400, 'ROLLBACK_UNAVAILABLE', 'No rollback reference found');
      return;
    }
    const rollbackJob = createUpdateJob({
      id: randomUUID(),
      target_version: job.rollback_ref,
      strategy: 'image',
      status: 'pending',
      progress: 0,
      logs: '',
      started_at: new Date().toISOString(),
    });
    setTimeout(() => {
      runImageUpdateJob(rollbackJob.id, job.rollback_ref as string).catch((error: unknown) => {
        const appError = asError(error);
        updateUpdateJob(rollbackJob.id, {
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: appError.message,
        });
      });
    }, 50);
    audit('update.rollback.request', 'accepted', `rollback_ref=${job.rollback_ref}`, rollbackJob.id);
    ok(res, {
      success: true,
      message: 'Rollback started',
      updater_container_id: rollbackJob.id,
      jobId: rollbackJob.id,
    }, 202);
    return;
  }

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
    const { query } = parseOrThrow(postgresQuerySchema, req.body);
    const results = await postgres.executeQuery(instance, query);
    ok(res, { results });
  } catch (error: any) {
    const appError = asError(error);
    err(res, appError.status, appError.code, appError.message, appError.details);
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

router.get('/push/container-logs', async (req: Request, res: Response) =>
{
  const tail = parseInt(req.query.tail as string) || 300;
  const candidates = ['convexer-push', 'convexer-ntfy', 'ntfy', 'gotify'];

  for (const name of candidates) {
    try {
      const info = await docker.getContainer(name).inspect();
      const logs = await getContainerLogs(name, tail);
      res.json({
        available: true,
        container: name,
        running: info.State.Running,
        status: info.State.Status,
        logs,
      });
      return;
    } catch {
      // Try next candidate.
    }
  }

  res.json({
    available: false,
    container: null,
    running: false,
    status: 'not found',
    logs: '',
    message: 'No separate push notification container found. The current push gateway runs inside the Convexer server process and records per-instance delivery attempts in the Push tab.',
  });
});

router.get('/ops/docker', async (_req: Request, res: Response) =>
{
  try {
    const volumes = await docker.listVolumes();
    const allInstances = [...getAllInstances(), ...getArchivedInstances()];
    const referencedVolumes = new Set<string>();
    for (const instance of allInstances) {
      if (instance.volume_name) referencedVolumes.add(instance.volume_name);
      if (instance.postgres_volume_name) referencedVolumes.add(instance.postgres_volume_name);
    }

    const protectedVolumes = new Set([
      'convexer-data',
      'convexer-ssh',
      'convexer-backups',
      'convexer_convexer-data',
      'convexer_convexer-ssh',
      'convexer_convexer-backups',
      'convexer_umami-db-data',
      'convexer_glitchtip-db-data',
      'umami-db-data',
      'glitchtip-db-data',
    ]);

    const convexerVolumes = (volumes.Volumes || [])
      .filter(volume => volume.Name.startsWith('convexer'))
      .map(volume => ({
        name: volume.Name,
        driver: volume.Driver,
        mountpoint: volume.Mountpoint,
        created_at: (volume as any).CreatedAt,
        labels: volume.Labels || {},
        referenced: referencedVolumes.has(volume.Name) || protectedVolumes.has(volume.Name),
      }));

    const danglingVolumes = convexerVolumes.filter(volume => !volume.referenced);
    const diskUsage = await execAsync('docker system df')
      .then(result => result.stdout)
      .catch((err: any) => `Docker disk usage unavailable: ${err.message}`);

    res.json({
      docker_disk_usage: diskUsage,
      volumes: convexerVolumes,
      dangling_volumes: danglingVolumes,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ops/docker/prune-build-cache', async (_req: Request, res: Response) =>
{
  try {
    const before = await execAsync('docker system df').then(result => result.stdout).catch(() => '');
    const { stdout, stderr } = await execAsync('docker builder prune -f');
    const after = await execAsync('docker system df').then(result => result.stdout).catch(() => '');
    res.json({
      success: true,
      output: stdout,
      error_output: stderr,
      before,
      after,
    });
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

router.get('/admin/preflight', async (_req: Request, res: Response) =>
{
  try {
    const info = await docker.info();
    const networks = await docker.listNetworks();
    const volumes = await docker.listVolumes();
    const updateMode = getUpdateStrategy();
    const checks = {
      docker_socket: true,
      network_exists: networks.some(network => network.Name === 'convexer-net'),
      data_volume_exists: (volumes.Volumes || []).some(volume => volume.Name === 'convexer-data'),
      backups_volume_exists: (volumes.Volumes || []).some(volume => volume.Name === 'convexer-backups'),
      host_project_path_configured: Boolean(process.env.HOST_PROJECT_PATH),
      update_strategy: updateMode,
      server_version: info.ServerVersion,
    };
    audit('admin.preflight', 'success', JSON.stringify(checks));
    ok(res, checks);
  } catch (error) {
    const appError = asError(error);
    audit('admin.preflight', 'failed', appError.message);
    err(res, appError.status, appError.code, appError.message, appError.details);
  }
});

router.post('/admin/repair/network', async (_req: Request, res: Response) =>
{
  try {
    try {
      await docker.createNetwork({ Name: 'convexer-net' });
    } catch (networkError: any) {
      if (networkError.statusCode !== 409) {
        throw networkError;
      }
    }
    audit('admin.repair.network', 'success');
    ok(res, { success: true, network: 'convexer-net' });
  } catch (error) {
    const appError = asError(error);
    audit('admin.repair.network', 'failed', appError.message);
    err(res, appError.status, appError.code, appError.message);
  }
});

router.post('/admin/repair/restart', async (_req: Request, res: Response) =>
{
  try {
    const target = await docker.getContainer('convexer').inspect();
    const container = docker.getContainer(target.Id);
    await container.restart();
    audit('admin.repair.restart', 'success', 'convexer restarted');
    ok(res, { success: true, container: 'convexer' });
  } catch (error) {
    const appError = asError(error);
    audit('admin.repair.restart', 'failed', appError.message);
    err(res, appError.status, appError.code, appError.message);
  }
});

router.post('/admin/repair/cleanup', async (req: Request, res: Response) =>
{
  try {
    parseOrThrow(repairCleanupSchema, req.body);
    const before = await execAsync('docker system df').then(result => result.stdout).catch(() => '');
    const { stdout, stderr } = await execAsync('docker builder prune -f');
    const after = await execAsync('docker system df').then(result => result.stdout).catch(() => '');
    const payload = { success: true, stdout, stderr, before, after };
    audit('admin.repair.cleanup', 'success', JSON.stringify({ stdout, stderr }));
    ok(res, payload);
  } catch (error) {
    const appError = asError(error);
    audit('admin.repair.cleanup', 'failed', appError.message);
    err(res, appError.status, appError.code, appError.message, appError.details);
  }
});

router.get('/admin/diagnostics', async (_req: Request, res: Response) =>
{
  try {
    const dockerInfo = await docker.info();
    const disk = await execAsync('df -h').then(result => result.stdout).catch(() => '');
    const dockerDisk = await execAsync('docker system df').then(result => result.stdout).catch(() => '');
    const updateJob = getLatestUpdateJob();
    const diagnostics = {
      generated_at: new Date().toISOString(),
      docker: {
        server_version: dockerInfo.ServerVersion,
        containers_running: dockerInfo.ContainersRunning,
        images: dockerInfo.Images,
      },
      disk,
      docker_disk: dockerDisk,
      latest_update_job: updateJob || null,
    };
    audit('admin.diagnostics', 'success');
    ok(res, diagnostics);
  } catch (error) {
    const appError = asError(error);
    audit('admin.diagnostics', 'failed', appError.message);
    err(res, appError.status, appError.code, appError.message, appError.details);
  }
});

export default router;
