import Docker from 'dockerode';
import fsPromises from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { appendUpdateJobLog, createActionAuditLog, getLatestUpdateJob, UpdateJob, updateUpdateJob } from '../db.js';
import { AppError, asError } from '../http.js';
import { pullImage } from '../docker.js';

const docker = new Docker();

export type UpdateStrategy = 'image' | 'git';

export type ImageRollbackRef = {
  appImage: string;
  sidecarImage: string;
  appImageName?: string | null;
  sidecarImageName?: string | null;
  createdAt: string;
};

type ImageUpdateTarget = {
  appImage: string;
  sidecarImage: string;
  label: string;
  isRollback: boolean;
};

function shortImageId (imageId: string | null): string | null
{
  return imageId?.replace(/^sha256:/, '').slice(0, 12) || null;
}

export function getUpdateStrategy(): UpdateStrategy {
  const allowGitUpdate = process.env.ALLOW_GIT_UPDATE === '1';
  return allowGitUpdate && (process.env.UPDATE_STRATEGY || 'image') === 'git' ? 'git' : 'image';
}

export function isUpdateJobActive (job: { status: string } | undefined): boolean
{
  return job?.status === 'pending' || job?.status === 'running';
}

function isLocalImageId (image: string): boolean
{
  return /^sha256:[a-f0-9]{64}$/i.test(image);
}

function configuredImageBase (value: string | undefined, fallback: string): string
{
  if (!value || isLocalImageId(value) || value.includes('@sha256:')) return fallback;
  const lastSlash = value.lastIndexOf('/');
  const lastColon = value.lastIndexOf(':');
  return lastColon > lastSlash ? value.slice(0, lastColon) : value;
}

export function parseImageRollbackRef (raw: string | null | undefined): ImageRollbackRef | null
{
  if (!raw?.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ImageRollbackRef>;
    if (typeof parsed.appImage !== 'string' || typeof parsed.sidecarImage !== 'string') return null;
    return {
      appImage: parsed.appImage,
      sidecarImage: parsed.sidecarImage,
      appImageName: typeof parsed.appImageName === 'string' ? parsed.appImageName : null,
      sidecarImageName: typeof parsed.sidecarImageName === 'string' ? parsed.sidecarImageName : null,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function serializeImageRollbackRef (ref: ImageRollbackRef): string
{
  return JSON.stringify(ref);
}

function getEnvValue (env: string[] | undefined, key: string): string | null
{
  const entry = env?.find(item => item.startsWith(`${key}=`));
  return entry ? entry.slice(key.length + 1) : null;
}

function buildImageUpdateTarget (targetVersion: string, appImageBase: string, sidecarImageBase: string): ImageUpdateTarget
{
  const rollbackRef = parseImageRollbackRef(targetVersion);
  if (rollbackRef) {
    return {
      appImage: rollbackRef.appImage,
      sidecarImage: rollbackRef.sidecarImage,
      label: rollbackRef.appImageName || rollbackRef.appImage,
      isRollback: true,
    };
  }

  if (isLocalImageId(targetVersion) || targetVersion.includes('@sha256:') || targetVersion.includes('/') || targetVersion.includes(':')) {
    return {
      appImage: targetVersion,
      sidecarImage: `${sidecarImageBase}:latest`,
      label: targetVersion,
      isRollback: true,
    };
  }

  const tag = targetVersion || 'latest';
  return {
    appImage: `${appImageBase}:${tag}`,
    sidecarImage: `${sidecarImageBase}:${tag}`,
    label: tag,
    isRollback: false,
  };
}

async function inspectImageRef (imageRef: string | null | undefined, preferredBase?: string): Promise<string | null>
{
  if (!imageRef) return null;
  try {
    const info = await docker.getImage(imageRef).inspect();
    const digests = info.RepoDigests || [];
    const preferredDigest = preferredBase
      ? digests.find(digest => digest.startsWith(`${preferredBase}@`))
      : null;
    return preferredDigest || digests[0] || info.Id || imageRef;
  } catch {
    return imageRef;
  }
}

async function captureRollbackRef (appImageBase: string, sidecarImageBase: string): Promise<ImageRollbackRef>
{
  let activeInfo: any | null = null;
  try {
    activeInfo = await docker.getContainer('convexer').inspect();
  } catch {
    // Fall back to local image tags if the active container is unavailable.
  }

  const appImageName = activeInfo?.Config?.Image || `${appImageBase}:latest`;
  const sidecarImageName = getEnvValue(activeInfo?.Config?.Env, 'BETTERAUTH_IMAGE') || `${sidecarImageBase}:latest`;

  const appImage = await inspectImageRef(activeInfo?.Image || appImageName, appImageBase);
  const sidecarImage = await inspectImageRef(sidecarImageName, sidecarImageBase);

  return {
    appImage: appImage || appImageName,
    sidecarImage: sidecarImage || sidecarImageName,
    appImageName,
    sidecarImageName,
    createdAt: new Date().toISOString(),
  };
}

async function appendJobLog(jobId: string, message: string, progress?: number) {
  appendUpdateJobLog(jobId, `[${new Date().toISOString()}] ${message}`);
  if (typeof progress === 'number') {
    updateUpdateJob(jobId, { progress });
  }
}

async function ensureUpdateImageAvailable (image: string, jobId: string, label: string): Promise<void>
{
  if (isLocalImageId(image)) {
    await docker.getImage(image).inspect();
    await appendJobLog(jobId, `Using local immutable ${label} image ${shortImageId(image) || image}`);
    return;
  }

  if (!image.includes('/') && !image.includes('@sha256:')) {
    try {
      await docker.getImage(image).inspect();
      await appendJobLog(jobId, `Using local ${label} image ${image}`);
      return;
    } catch {
      // Not local; try pulling below for registry-backed image names.
    }
  }

  await appendJobLog(jobId, `Pulling ${image}`);
  await pullImage(image);
}

function getConvexerContainerEnv (appImageBase: string, sidecarImage: string): string[]
{
  return [
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
    `ALLOW_GIT_UPDATE=${process.env.ALLOW_GIT_UPDATE || '0'}`,
    `CONVEXER_IMAGE=${appImageBase}`,
    `BETTERAUTH_IMAGE=${sidecarImage}`,
  ];
}

function mountToBind (mount: any): string | null
{
  const source = mount.Type === 'volume' ? mount.Name : mount.Source;
  if (!source || !mount.Destination) return null;
  const mode = mount.RW === false ? 'ro' : 'rw';
  return `${source}:${mount.Destination}:${mode}`;
}

async function getConvexerContainerBinds (): Promise<string[]>
{
  try {
    const info = await docker.getContainer('convexer').inspect();
    const binds = (info.Mounts || [])
      .map(mountToBind)
      .filter(Boolean) as string[];
    if (binds.length > 0) return binds;
  } catch {
    // Fall back to production defaults if the active container is unavailable.
  }

  return [
    '/var/run/docker.sock:/var/run/docker.sock',
    'convexer-data:/app/server/data',
    'convexer-ssh:/root/.ssh',
    'convexer-backups:/app/server/data/backups',
    `${process.env.HOST_PROJECT_PATH || '/home/convexer'}/server/data:/app/host-data:ro`,
  ];
}

function getConvexerTraefikLabels (): Record<string, string>
{
  const domain = process.env.DOMAIN || '';
  return {
    'traefik.enable': 'true',
    'traefik.http.routers.convexer.rule': `Host(\`${domain}\`)`,
    'traefik.http.routers.convexer.entrypoints': 'web',
    'traefik.http.routers.convexer-secure.rule': `Host(\`${domain}\`)`,
    'traefik.http.routers.convexer-secure.entrypoints': 'websecure',
    'traefik.http.routers.convexer-secure.tls': 'true',
    'traefik.http.routers.convexer-secure.service': 'convexer',
    'traefik.http.services.convexer.loadbalancer.server.port': '4000',
  };
}

function buildConvexerContainerOptions (options: {
  name: string;
  appImage: string;
  sidecarImage: string;
  appImageBase: string;
  binds: string[];
  hostPort: string;
  restart: boolean;
  traefikLabels: boolean;
}): Docker.ContainerCreateOptions
{
  return {
    Image: options.appImage,
    name: options.name,
    Env: getConvexerContainerEnv(options.appImageBase, options.sidecarImage),
    HostConfig: {
      ...(options.restart ? { RestartPolicy: { Name: 'unless-stopped' } } : {}),
      NetworkMode: 'convexer-net',
      Binds: options.binds,
      PortBindings: {
        '4000/tcp': [{ HostPort: options.hostPort }],
      },
    },
    ExposedPorts: { '4000/tcp': {} },
    ...(options.traefikLabels ? { Labels: getConvexerTraefikLabels() } : {}),
  };
}

function shellQuote (value: string): string
{
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function dockerRunCommand (options: {
  name: string;
  appImage: string;
  sidecarImage: string;
  appImageBase: string;
  binds: string[];
  hostPort: string;
  restart: boolean;
  traefikLabels: boolean;
}): string
{
  const args = [
    'docker', 'run', '-d', '--name', options.name,
    '--network', 'convexer-net',
    '-p', `${options.hostPort}:4000`,
  ];

  if (options.restart) args.push('--restart', 'unless-stopped');
  for (const bind of options.binds) args.push('-v', bind);
  for (const env of getConvexerContainerEnv(options.appImageBase, options.sidecarImage)) args.push('-e', env);
  if (options.traefikLabels) {
    for (const [key, value] of Object.entries(getConvexerTraefikLabels())) args.push('--label', `${key}=${value}`);
  }
  args.push(options.appImage);

  return args.map(shellQuote).join(' ');
}

function imageUpdateResultPath (jobId: string): string
{
  return path.join(process.env.DATA_DIR || '/app/server/data', `.image-update-${jobId}.json`);
}

function imageUpdateLogPath (jobId: string): string
{
  return path.join(process.env.DATA_DIR || '/app/server/data', `.image-update-${jobId}.log`);
}

async function checkHealth(url: string, retries = 45, delayMs = 2000): Promise<boolean> {
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

async function checkContainerHealth(container: Docker.Container, retries = 45, delayMs = 2000): Promise<boolean> {
  for (let i = 0; i < retries; i += 1) {
    try {
      const exec = await container.exec({
        Cmd: [
          'node',
          '-e',
          "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      await new Promise<void>((resolve, reject) =>
      {
        stream.on('end', resolve);
        stream.on('error', reject);
        stream.resume();
      });
      const result = await exec.inspect();
      if (result.ExitCode === 0) return true;
    } catch {
      // noop
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return false;
}

async function appendContainerLogs(jobId: string, containerName: string, lineLimit = 120) {
  try {
    const container = docker.getContainer(containerName);
    const logs = await container.logs({ stdout: true, stderr: true, tail: lineLimit });
    const text = Buffer.isBuffer(logs) ? logs.toString('utf8') : String(logs);
    if (text.trim()) {
      appendUpdateJobLog(jobId, `[${new Date().toISOString()}] ${containerName} logs:\n${text}`);
    }
  } catch (error: any) {
    appendUpdateJobLog(jobId, `[${new Date().toISOString()}] unable to read ${containerName} logs: ${error?.message || String(error)}`);
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

function latestLogLine (logs?: string | null): string | null
{
  const lines = (logs || '').split('\n').map(line => line.trim()).filter(Boolean);
  return lines.at(-1) || null;
}

export function getUpdatePhase (job?: UpdateJob | null): string
{
  if (!job) return 'idle';
  if (job.status === 'success') return 'complete';
  if (job.status === 'failed') return 'failed';
  if (job.progress >= 88) return 'swapping';
  if (job.progress >= 55) return 'candidate-health';
  if (job.progress >= 40) return 'candidate-start';
  if (job.progress >= 20) return 'pulling-images';
  if (job.progress >= 5) return 'preflight';
  return job.status;
}

export function formatUpdateStatus (job?: UpdateJob | null)
{
  if (!job) {
    return { running: false, success: null, jobId: null, status: 'idle', phase: 'idle', progress: 0, rollbackAvailable: false };
  }

  const running = job.status === 'pending' || job.status === 'running';
  const success = job.status === 'success' ? true : (job.status === 'failed' ? false : null);
  const rollback = parseImageRollbackRef(job.rollback_ref);
  return {
    running,
    success,
    jobId: job.id,
    status: job.status,
    phase: getUpdatePhase(job),
    message: job.error_message || latestLogLine(job.logs),
    progress: job.progress,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    rollbackAvailable: Boolean(job.rollback_ref),
    rollback,
    rollbackRef: job.rollback_ref || null,
    errorMessage: job.error_message || null,
  };
}

export function formatUpdateLogs (job?: UpdateJob | null)
{
  return {
    running: job?.status === 'pending' || job?.status === 'running',
    state: job?.status || 'idle',
    status: job?.status || 'idle',
    phase: getUpdatePhase(job),
    message: job?.error_message || latestLogLine(job?.logs) || null,
    logs: job?.logs || '',
    progress: job?.progress || 0,
    rollbackAvailable: Boolean(job?.rollback_ref),
    jobId: job?.id || null,
  };
}

function formatContainerListItem (container: Docker.ContainerInfo)
{
  return {
    id: container.Id?.slice(0, 12) || null,
    name: container.Names?.[0]?.replace(/^\//, '') || null,
    image: container.Image || null,
    image_id: shortImageId(container.ImageID || null),
    state: container.State || null,
    status: container.Status || null,
    created_at: container.Created ? new Date(container.Created * 1000).toISOString() : null,
  };
}

async function inspectNamedContainer (name: string)
{
  try {
    const info = await docker.getContainer(name).inspect();
    return {
      id: info.Id?.slice(0, 12) || null,
      name: info.Name?.replace(/^\//, '') || name,
      image: info.Config?.Image || null,
      image_id: shortImageId(info.Image || null),
      state: info.State?.Status || null,
      status: info.State?.Health?.Status || info.State?.Status || null,
      running: Boolean(info.State?.Running),
      restart_count: info.RestartCount ?? null,
      started_at: info.State?.StartedAt || null,
    };
  } catch {
    return null;
  }
}

export async function getImageUpdateRuntimeDiagnostics ()
{
  const job = getLatestUpdateJob();
  const swapperContainers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: ['convexer.role=image-updater'] }),
  });

  return {
    strategy: getUpdateStrategy(),
    latest_job: formatUpdateStatus(job),
    active_container: await inspectNamedContainer('convexer'),
    candidate_container: await inspectNamedContainer('convexer-candidate'),
    swapper_containers: swapperContainers
      .sort((a, b) => b.Created - a.Created)
      .map(formatContainerListItem),
  };
}

export async function reconcileImageUpdateResult (jobId: string): Promise<void>
{
  try {
    const raw = await fsPromises.readFile(imageUpdateResultPath(jobId), 'utf-8');
    const result = JSON.parse(raw) as {
      jobId?: string;
      status?: string;
      health_result?: string;
      error_message?: string;
      completed_at?: string;
    };
    if (result.jobId !== jobId || (result.status !== 'success' && result.status !== 'failed')) return;

    let swapLogs = '';
    try {
      swapLogs = await fsPromises.readFile(imageUpdateLogPath(jobId), 'utf-8');
    } catch {
      // Swap logs are best-effort.
    }
    if (swapLogs.trim()) {
      appendUpdateJobLog(jobId, `[${new Date().toISOString()}] external swapper logs:\n${swapLogs}`);
    }

    updateUpdateJob(jobId, {
      status: result.status,
      progress: result.status === 'success' ? 100 : 95,
      completed_at: result.completed_at || new Date().toISOString(),
      health_result: result.health_result || null,
      error_message: result.error_message || null,
    });
    await fsPromises.rm(imageUpdateResultPath(jobId), { force: true });
    await fsPromises.rm(imageUpdateLogPath(jobId), { force: true });
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn(`Failed to reconcile image update result for ${jobId}:`, error?.message || String(error));
    }
  }
}

export async function reconcileLatestImageUpdateResult (): Promise<void>
{
  const job = getLatestUpdateJob();
  if (job?.id) await reconcileImageUpdateResult(job.id);
}

export async function runImageUpdateJob(jobId: string, targetVersion: string) {
  const appImageBase = configuredImageBase(process.env.CONVEXER_IMAGE, 'convexer-convexer');
  const sidecarImageBase = configuredImageBase(process.env.BETTERAUTH_IMAGE_BASE || process.env.BETTERAUTH_IMAGE, 'convexer-better-auth-sidecar');
  const target = buildImageUpdateTarget(targetVersion, appImageBase, sidecarImageBase);
  const candidateName = 'convexer-candidate';
  let rollbackRef: ImageRollbackRef | null = null;

  try {
    updateUpdateJob(jobId, { status: 'running', progress: 2, started_at: new Date().toISOString() });
    await appendJobLog(jobId, 'Running preflight checks', 5);

    await docker.info();
    const networks = await docker.listNetworks();
    const hasNetwork = networks.some(n => n.Name === 'convexer-net');
    if (!hasNetwork) {
      throw new AppError(500, 'PREFLIGHT_NETWORK_MISSING', 'convexer-net is missing');
    }

    const binds = await getConvexerContainerBinds();

    rollbackRef = await captureRollbackRef(appImageBase, sidecarImageBase);
    updateUpdateJob(jobId, { rollback_ref: serializeImageRollbackRef(rollbackRef) });
    await appendJobLog(jobId, `Captured rollback image ${rollbackRef.appImageName || shortImageId(rollbackRef.appImage) || rollbackRef.appImage}`, 10);

    await ensureUpdateImageAvailable(target.appImage, jobId, 'app');
    updateUpdateJob(jobId, { progress: 20 });
    await ensureUpdateImageAvailable(target.sidecarImage, jobId, 'Better Auth sidecar');
    updateUpdateJob(jobId, { progress: 30 });

    await appendJobLog(jobId, 'Starting candidate container on port 4001', 40);
    try {
      const stale = docker.getContainer(candidateName);
      await stale.remove({ force: true });
    } catch {
      // noop
    }

    const candidate = await docker.createContainer(buildConvexerContainerOptions({
      name: candidateName,
      appImage: target.appImage,
      sidecarImage: target.sidecarImage,
      appImageBase,
      binds,
      hostPort: '4001',
      restart: false,
      traefikLabels: false,
    }));
    await candidate.start();

    await appendJobLog(jobId, 'Health checking candidate container (timeout: ~90s)', 55);
    const candidateHealthy = await checkContainerHealth(candidate) || await checkHealth('http://127.0.0.1:4001/api/health', 5);
    if (!candidateHealthy) {
      await appendContainerLogs(jobId, candidateName);
      throw new AppError(500, 'CANDIDATE_HEALTH_FAILED', 'Candidate container failed health checks');
    }

    const finalRun = dockerRunCommand({
      name: 'convexer',
      appImage: target.appImage,
      sidecarImage: target.sidecarImage,
      appImageBase,
      binds,
      hostPort: '4000',
      restart: true,
      traefikLabels: true,
    });
    const rollbackRun = dockerRunCommand({
      name: 'convexer',
      appImage: rollbackRef.appImage,
      sidecarImage: rollbackRef.sidecarImage,
      appImageBase,
      binds,
      hostPort: '4000',
      restart: true,
      traefikLabels: true,
    });
    const swapperName = `convexer-image-update-${jobId.slice(0, 12)}`;
    const resultPath = `/app/server/data/.image-update-${jobId}.json`;
    const logPath = `/app/server/data/.image-update-${jobId}.log`;
    const swapperScript = `
set -u
JOB_ID=${shellQuote(jobId)}
RESULT=${shellQuote(resultPath)}
LOG=${shellQuote(logPath)}
write_result() {
  STATUS="$1"
  HEALTH="$2"
  ERROR_MESSAGE="$3"
  COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node -e 'const fs=require("fs"); const [file,jobId,status,health,errorMessage,completedAt]=process.argv.slice(1); const payload={jobId,status,completed_at:completedAt}; if (health) payload.health_result=health; if (errorMessage) payload.error_message=errorMessage; fs.writeFileSync(file, JSON.stringify(payload));' "$RESULT" "$JOB_ID" "$STATUS" "$HEALTH" "$ERROR_MESSAGE" "$COMPLETED_AT"
}
health_check() {
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if docker exec convexer node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
      return 0
    fi
    sleep 2
  done
  return 1
}
exec >> "$LOG" 2>&1
echo "[swapper] starting final image swap"
docker rm -f convexer || true
if ! ${finalRun}; then
  echo "[swapper] final container failed to start; restoring previous image"
  docker rm -f convexer || true
  if ${rollbackRun} && health_check; then
    docker rm -f ${shellQuote(candidateName)} || true
    write_result failed '' 'Final container failed to start; previous image restored'
    exit 1
  fi
  write_result failed '' 'Final container failed to start; rollback failed'
  exit 1
fi
if health_check; then
  docker rm -f ${shellQuote(candidateName)} || true
  write_result success ok ''
  exit 0
fi
echo "[swapper] final container failed health checks; restoring previous image"
docker logs convexer --tail 120 || true
docker rm -f convexer || true
if ${rollbackRun} && health_check; then
  docker rm -f ${shellQuote(candidateName)} || true
  write_result failed '' 'Final container failed health checks; previous image restored'
  exit 1
fi
docker logs convexer --tail 120 || true
write_result failed '' 'Final container failed health checks; rollback failed'
exit 1
`;
    const swapper = await docker.createContainer({
      Image: rollbackRef.appImage,
      name: swapperName,
      Cmd: ['sh', '-c', swapperScript],
      HostConfig: {
        AutoRemove: true,
        Binds: binds,
      },
      Labels: { 'convexer.role': 'image-updater' },
    });

    await appendJobLog(jobId, 'Candidate is healthy; launching external swapper', 80);
    await swapper.start();
    await appendJobLog(jobId, `External swapper ${swapperName} started; active container will restart`, 88);
    audit('update.image', 'swap-started', `Updating to ${target.label}`, jobId);
  } catch (error) {
    const appError = asError(error);
    try { await docker.getContainer(candidateName).remove({ force: true }); } catch { /* noop */ }
    updateUpdateJob(jobId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: appError.message,
    });
    appendUpdateJobLog(jobId, `[${new Date().toISOString()}] update failed: ${appError.message}`);
    audit('update.image', 'failed', appError.message, jobId);
  }
}
