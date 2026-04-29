import Docker from 'dockerode';
import crypto from 'crypto';
import { Instance } from './types.js';
import { updateInstance, getAllInstances } from './db.js';
import { addTunnelRoutes, isTunnelEnabled, getInstanceHostnames } from './tunnel.js';
import { getBackendTraefikLabels, getDashboardTraefikLabels, getBetterAuthTraefikLabels } from './traefik.js';

const docker = new Docker();
const NETWORK_NAME = 'convexer-net';

/**
 * Get container by name, with optional fallback to stored ID.
 * Always prefers name-based lookup since names are deterministic and survive container recreation.
 * Also syncs the database if the stored ID doesn't match the actual container.
 */
export async function getContainerByRole (
  instance: Instance,
  role: 'backend' | 'dashboard' | 'postgres' | 'betterauth'
): Promise<Docker.Container | null>
{
  const containerName = `convexer-${role}-${instance.name}`;
  const storedIdKey = `${role}_container_id` as keyof Instance;
  const storedId = instance[storedIdKey] as string | null;

  // Try by name first (most reliable)
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();

    // Sync database if stored ID doesn't match actual container
    if (storedId !== info.Id) {
      console.log(`Syncing ${role} container ID for ${instance.name}: ${storedId?.slice(0, 12) || 'null'} -> ${info.Id.slice(0, 12)}`);
      updateInstance(instance.id, { [storedIdKey]: info.Id });
    }

    return container;
  } catch {
    // Container doesn't exist by name
  }

  // Fallback to stored ID (in case container was renamed)
  if (storedId) {
    try {
      const container = docker.getContainer(storedId);
      await container.inspect();
      return container;
    } catch {
      // Container doesn't exist by ID either
    }
  }

  return null;
}

/**
 * Check if a container exists by name or stored ID
 */
export async function containerExists (
  instance: Instance,
  role: 'backend' | 'dashboard' | 'postgres' | 'betterauth'
): Promise<boolean>
{
  const container = await getContainerByRole(instance, role);
  return container !== null;
}

const BACKEND_IMAGE_BASE = 'ghcr.io/get-convex/convex-backend';
const DASHBOARD_IMAGE_BASE = 'ghcr.io/get-convex/convex-dashboard';
const POSTGRES_IMAGE = 'postgres:16-alpine';
const BETTERAUTH_IMAGE = 'convexer-better-auth-sidecar:latest';

function getImages (instance: Pick<Instance, 'pinned_version'>): { backend: string; dashboard: string }
{
  const tag = instance.pinned_version || 'latest';
  return {
    backend: `${BACKEND_IMAGE_BASE}:${tag}`,
    dashboard: `${DASHBOARD_IMAGE_BASE}:${tag}`,
  };
}

export async function pullImage (image: string): Promise<void>
{
  console.log(`Pulling ${image}...`);
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) =>
  {
    docker.modem.followProgress(stream, (err: Error | null) =>
    {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function ensureImages (): Promise<void>
{
  const images = [`${BACKEND_IMAGE_BASE}:latest`, `${DASHBOARD_IMAGE_BASE}:latest`, POSTGRES_IMAGE];
  for (const image of images) {
    try {
      await docker.getImage(image).inspect();
    } catch {
      await pullImage(image);
    }
  }
}

export async function createAndStartInstance (instance: Instance, beforeBackendStart?: () => Promise<void>): Promise<void>
{
  try {
    const volumeName = instance.volume_name;
    const postgresVolumeName = instance.postgres_volume_name;

    // Create volumes (idempotent - Docker ignores if already exists)
    await docker.createVolume({ Name: volumeName }).catch(() => { });
    await docker.createVolume({ Name: postgresVolumeName }).catch(() => { });

    const isLinux = process.platform === 'linux';
    const extraHosts = isLinux ? ['host.docker.internal:host-gateway'] : [];
    const domain = process.env.DOMAIN || '';

    // Generate PostgreSQL password if not set
    const postgresPassword = instance.postgres_password || crypto.randomBytes(32).toString('hex');
    updateInstance(instance.id, { postgres_password: postgresPassword });

    // Check if PostgreSQL container already exists
    let postgresContainer = await getContainerByRole(instance, 'postgres');
    if (!postgresContainer) {
    // Create PostgreSQL container
    // No PortBindings: PostgreSQL is only accessible within the Docker network
      postgresContainer = await docker.createContainer({
        Image: POSTGRES_IMAGE,
        name: `convexer-postgres-${instance.name}`,
        HostConfig: {
          Binds: [`${postgresVolumeName}:/var/lib/postgresql/data`],
          RestartPolicy: { Name: 'unless-stopped' },
        },
        Env: [
          `POSTGRES_PASSWORD=${postgresPassword}`,
          `POSTGRES_DB=${instance.instance_name.replace(/-/g, '_')}`,
          `POSTGRES_USER=postgres`,
        ],
      });

      // Attach to network
      try {
        const network = docker.getNetwork(NETWORK_NAME);
        await network.connect({ Container: postgresContainer.id });
      } catch (err: any) {
        console.warn(`Failed to connect PostgreSQL to network:`, err.message);
      }
    }

    // Start postgres (idempotent - ignores if already running)
    await postgresContainer.start().catch(() => { });

    updateInstance(instance.id, { postgres_container_id: postgresContainer.id });

    // Wait for PostgreSQL to be ready
    const postgresTimeout = instance.postgres_health_check_timeout || 60_000;
    await waitForPostgres(instance.name, postgresTimeout);

    // Hook for pre-backend operations (e.g. restore DB/volume during duplication)
    if (beforeBackendStart) {
      await beforeBackendStart();
    }

    // Build backend env vars
    const backendEnv = [
      `CONVEX_INSTANCE_NAME=${instance.instance_name}`,
      `CONVEX_INSTANCE_SECRET=${instance.instance_secret}`,
      `INSTANCE_NAME=${instance.instance_name}`,
      `INSTANCE_SECRET=${instance.instance_secret}`,
      `POSTGRES_URL=postgres://postgres:${postgresPassword}@convexer-postgres-${instance.name}:5432`,
      `DO_NOT_REQUIRE_SSL=1`,
    ];

    // When Traefik is enabled, set cloud/site origins to public URLs
    if (domain) {
      backendEnv.push(
        `CONVEX_CLOUD_ORIGIN=https://${instance.name}.${domain}`,
        `CONVEX_SITE_ORIGIN=https://${instance.name}-site.${domain}`,
      );
    }

    // When tunnel is enabled, tell the backend its public URLs
    // so it can accept WebSocket connections from the tunnel hostname
    if (isTunnelEnabled()) {
      const hostnames = getInstanceHostnames(instance);
      backendEnv.push(
        `CONVEX_CLOUD_ORIGIN=https://${hostnames.backend}`,
        `CONVEX_SITE_ORIGIN=https://${hostnames.site}`,
      );
    }

    // Merge extra_env if provided
    if (instance.extra_env) {
      try {
        const extra = JSON.parse(instance.extra_env);
        for (const [key, value] of Object.entries(extra)) {
          backendEnv.push(`${key}=${value}`);
        }
      } catch (err) {
        console.warn('Failed to parse extra_env:', err);
      }
    }

    // Get Traefik labels if domain is set
    const backendTraefikLabels = getBackendTraefikLabels(instance, domain);

    const { backend: backendImage, dashboard: dashboardImage } = getImages(instance);

    // Check if backend container already exists
    let backendContainer = await getContainerByRole(instance, 'backend');
    if (!backendContainer) {
      // Create backend container
      backendContainer = await docker.createContainer({
        Image: backendImage,
        name: `convexer-backend-${instance.name}`,
        ExposedPorts: { '3210/tcp': {}, '3211/tcp': {} },
        HostConfig: {
          PortBindings: {
            '3210/tcp': [{ HostPort: String(instance.backend_port) }],
            '3211/tcp': [{ HostPort: String(instance.site_proxy_port) }],
          },
          Binds: [`${volumeName}:/convex/data`],
          RestartPolicy: { Name: 'unless-stopped' },
          ExtraHosts: extraHosts,
        },
        Env: backendEnv,
        Labels: backendTraefikLabels,
      });

      // Attach to network
      try {
        const network = docker.getNetwork(NETWORK_NAME);
        await network.connect({ Container: backendContainer.id });
      } catch (err: any) {
        console.warn(`Failed to connect backend to network:`, err.message);
      }
    }

    // Start backend (idempotent - ignores if already running)
    await backendContainer.start().catch(() => { });

    updateInstance(instance.id, { backend_container_id: backendContainer.id });

    // Wait for backend to be healthy (use container name on network)
    const backendTimeout = instance.health_check_timeout || 300_000;
    await waitForHealth(`http://convexer-backend-${instance.name}:3210`, backendTimeout);

    // Generate admin key
    const adminKey = await generateAdminKey(backendContainer, instance.instance_name, instance.instance_secret);
    updateInstance(instance.id, { admin_key: adminKey });

    // Determine public-facing URLs for the dashboard's browser-side code
    let publicBackendUrl = `http://localhost:${instance.backend_port}`;
    let publicSiteProxyUrl = `http://localhost:${instance.site_proxy_port}`;
    if (isTunnelEnabled()) {
      const hostnames = getInstanceHostnames(instance);
      publicBackendUrl = `https://${hostnames.backend}`;
      publicSiteProxyUrl = `https://${hostnames.site}`;
    } else if (domain) {
      publicBackendUrl = `https://${instance.name}.${domain}`;
      publicSiteProxyUrl = `https://${instance.name}-site.${domain}`;
    }

    // Check if dashboard container already exists
    const dashboardTraefikLabels = getDashboardTraefikLabels(instance, domain);
    let dashboardContainer = await getContainerByRole(instance, 'dashboard');
    if (!dashboardContainer) {
      // Create dashboard container
      dashboardContainer = await docker.createContainer({
        Image: dashboardImage,
        name: `convexer-dashboard-${instance.name}`,
        ExposedPorts: { '6791/tcp': {} },
        HostConfig: {
          PortBindings: {
            '6791/tcp': [{ HostPort: String(instance.dashboard_port) }],
          },
          RestartPolicy: { Name: 'unless-stopped' },
          ExtraHosts: extraHosts,
        },
        Env: [
          `CONVEX_PROVISION_HOST=http://host.docker.internal:${instance.backend_port}`,
          `CONVEX_SITE_PROXY_HOST=http://host.docker.internal:${instance.site_proxy_port}`,
          `NEXT_PUBLIC_PROVISION_HOST=${publicBackendUrl}`,
          `NEXT_PUBLIC_SITE_PROXY_HOST=${publicSiteProxyUrl}`,
        ],
        Labels: dashboardTraefikLabels,
      });

      // Attach to network
      try {
        const network = docker.getNetwork(NETWORK_NAME);
        await network.connect({ Container: dashboardContainer.id });
      } catch (err: any) {
        console.warn(`Failed to connect dashboard to network:`, err.message);
      }
    }

    // Start dashboard (idempotent - ignores if already running)
    await dashboardContainer.start().catch(() => { });

    updateInstance(instance.id, {
      dashboard_container_id: dashboardContainer.id,
      status: 'running',
    });

    // Create and start Better Auth sidecar
    try {
      await createBetterAuthSidecar(instance);
    } catch (err: any) {
      console.warn(`Failed to create Better Auth sidecar for ${instance.name}:`, err.message);
    }

    // Add cloudflared tunnel routes
    try {
      addTunnelRoutes(instance);
    } catch (err: any) {
      console.warn(`Failed to add tunnel routes for ${instance.name}:`, err.message);
    }

    console.log(`Instance ${instance.name} is running`);
  } catch (err: any) {
    console.error(`Failed to create instance ${instance.name}:`, err.message);
    updateInstance(instance.id, {
      status: 'error',
      error_message: err.message,
    });
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastError: string = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return; // Backend responds
    } catch (err: any) {
      lastError = err.message;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`Health check failed for ${url} after ${timeoutMs}ms. Last error: ${lastError}`);
  throw new Error(`Health check timeout for ${url}`);
}

async function waitForPostgres (instanceName: string, timeoutMs: number): Promise<void>
{
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const container = await docker.getContainer(`convexer-postgres-${instanceName}`);
      const exec = await container.exec({
        Cmd: ['pg_isready'],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ Detach: false, Tty: false });
      const output = await demuxStream(stream);
      if (output.includes('accepting connections')) {
        return;
      }
    } catch (err: any) {
      // PostgreSQL not ready yet
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`PostgreSQL health check timeout for ${instanceName}`);
}

async function generateAdminKey(container: Docker.Container, instanceName: string, instanceSecret: string): Promise<string> {
  try {
    const exec = await container.exec({
      Cmd: ['./generate_admin_key.sh'],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ Detach: false, Tty: false });
    const output = await demuxStream(stream);
    const adminKey = output.trim().split('\n').pop()?.trim();
    if (adminKey) return adminKey;
  } catch (err) {
    console.warn('generate_admin_key.sh failed, generating manually');
  }

  // Fallback: generate admin key manually using the instance secret
  const keyBytes = crypto.randomBytes(32);
  return `${instanceName}|${keyBytes.toString('hex')}`;
}

function demuxStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let buffer = Buffer.alloc(0);

    stream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer as Uint8Array, chunk as Uint8Array]);
      // Docker multiplexed stream: 8-byte header per frame
      // [stream_type(1), 0, 0, 0, size(4 big-endian)] then payload
      while (buffer.length >= 8) {
        const size = buffer.readUInt32BE(4);
        if (buffer.length < 8 + size) break;
        chunks.push(buffer.subarray(8, 8 + size) as Uint8Array);
        buffer = buffer.subarray(8 + size);
      }
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

export async function createBetterAuthSidecar (instance: Instance): Promise<void>
{
  const domain = process.env.DOMAIN || '';
  const dbName = instance.instance_name.replace(/-/g, '_');

  // Fetch actual postgres password from the postgres container environment
  let postgresPassword = instance.postgres_password;
  try {
    const pgContainer = docker.getContainer(`convexer-postgres-${instance.name}`);
    const pgInfo = await pgContainer.inspect();
    const pgEnv = pgInfo.Config.Env || [];
    const passwordEnv = pgEnv.find((e: string) => e.startsWith('POSTGRES_PASSWORD='));
    if (passwordEnv) {
      postgresPassword = passwordEnv.split('=')[1];
    }
  } catch (err: any) {
    console.warn(`Failed to fetch postgres password from container, using stored password:`, err.message);
  }

  const databaseUrl = `postgres://postgres:${postgresPassword}@convexer-postgres-${instance.name}:5432/${dbName}?sslmode=disable`;

  // Determine public base URL for the sidecar from the actual Better Auth public domain
  // Default to https://{instance}-auth.{DOMAIN} unless explicitly overridden
  let baseUrl = `http://localhost:${instance.betterauth_port}`;
  if (domain) {
    baseUrl = `https://${instance.name}-auth.${domain}`;
  }

  // Allow explicit override via BETTERAUTH_DOMAIN in extra_env
  if (instance.extra_env) {
    try {
      const env = JSON.parse(instance.extra_env);
      if (env.BETTERAUTH_DOMAIN) {
        baseUrl = env.BETTERAUTH_DOMAIN.startsWith('http') ? env.BETTERAUTH_DOMAIN : `https://${env.BETTERAUTH_DOMAIN}`;
      }
    } catch {
      // Use computed baseUrl if parsing fails
    }
  }

  // Get BETTER_AUTH_SECRET from extra_env if provided, otherwise generate one
  let betterAuthSecret: string | undefined;
  const extraEnv: Record<string, string> = {};
  if (instance.extra_env) {
    try {
      const env = JSON.parse(instance.extra_env);
      betterAuthSecret = env.BETTER_AUTH_SECRET;
      // Extract Apple OAuth variables
      if (env.APPLE_CLIENT_ID) extraEnv.APPLE_CLIENT_ID = env.APPLE_CLIENT_ID;
      if (env.APPLE_CLIENT_SECRET) extraEnv.APPLE_CLIENT_SECRET = env.APPLE_CLIENT_SECRET;
      if (env.APPLE_APP_BUNDLE_IDENTIFIER) extraEnv.APPLE_APP_BUNDLE_IDENTIFIER = env.APPLE_APP_BUNDLE_IDENTIFIER;
      // Extract Google OAuth variables
      if (env.GOOGLE_CLIENT_ID) extraEnv.GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
      if (env.GOOGLE_CLIENT_SECRET) extraEnv.GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
    } catch {
      // ignore
    }
  }
  if (!betterAuthSecret) {
    betterAuthSecret = crypto.randomBytes(32).toString('hex');
    // Persist the generated secret to extra_env so it survives container recreation
    extraEnv.BETTER_AUTH_SECRET = betterAuthSecret;
    const updatedExtraEnv = JSON.stringify(extraEnv);
    updateInstance(instance.id, { extra_env: updatedExtraEnv });
  }

  const betterauthTraefikLabels = getBetterAuthTraefikLabels(instance, domain);

  let container: Docker.Container;
  try {
    container = await docker.createContainer({
      Image: BETTERAUTH_IMAGE,
      name: `convexer-betterauth-${instance.name}`,
      ExposedPorts: { '4200/tcp': {} },
      HostConfig: {
        PortBindings: {
          '4200/tcp': [{ HostPort: String(instance.betterauth_port) }],
        },
        RestartPolicy: { Name: 'unless-stopped' },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [NETWORK_NAME]: {}
        }
      },
      Healthcheck: {
        Test: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:4200/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
        Interval: 10000000000, // 10 seconds
        Timeout: 5000000000, // 5 seconds
        Retries: 3,
        StartPeriod: 30000000000, // 30 seconds
      },
      Env: [
        `DATABASE_URL=${databaseUrl}`,
        `BETTER_AUTH_SECRET=${betterAuthSecret}`,
        `BASE_URL=${baseUrl}`,
        `CONVEX_SITE_URL=${baseUrl}`,
        `PORT=4200`,
        'DO_NOT_REQUIRE_SSL=1',
        ...Object.entries(extraEnv).map(([key, value]) => `${key}=${value}`),
      ],
      Labels: betterauthTraefikLabels,
    });
  } catch (err: any) {
    if (err.statusCode === 404) {
      console.warn(`Better Auth sidecar image '${BETTERAUTH_IMAGE}' not found. Skipping sidecar creation.`);
      return;
    }
    throw err;
  }

  await container.start();

  // Wait for sidecar health check
  try {
    const healthTimeout = 60000; // 60 seconds
    const start = Date.now();
    while (Date.now() - start < healthTimeout) {
      try {
        const info = await container.inspect();
        if (info.State.Health?.Status === 'healthy') {
          console.log(`Better Auth sidecar for ${instance.name} is healthy`);
          break;
        }
        if (info.State.Health?.Status === 'unhealthy') {
          console.warn(`Better Auth sidecar for ${instance.name} is unhealthy`);
          break;
        }
      } catch {
        // Health check not yet available
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err: any) {
    console.warn(`Failed to wait for Better Auth sidecar health for ${instance.name}:`, err.message);
  }

  updateInstance(instance.id, { betterauth_container_id: container.id });
  console.log(`Better Auth sidecar for ${instance.name} started on port ${instance.betterauth_port}`);
}

export async function removeBetterAuthSidecar (instance: Instance): Promise<void>
{
  const refs = [
    instance.betterauth_container_id,
    `convexer-betterauth-${instance.name}`,
  ].filter(Boolean) as string[];

  for (const ref of refs) {
    try {
      const container = docker.getContainer(ref);
      try { await container.stop(); } catch { /* already stopped */ }
      await container.remove({ force: true });
    } catch { /* container doesn't exist */ }
  }
}

export async function startInstance(instance: Instance): Promise<void> {
  // Check if containers exist by name (more reliable than stored IDs)
  const [postgresContainer, backendContainer, dashboardContainer] = await Promise.all([
    getContainerByRole(instance, 'postgres'),
    getContainerByRole(instance, 'backend'),
    getContainerByRole(instance, 'dashboard'),
  ]);

  const allExist = postgresContainer && backendContainer && dashboardContainer;

  if (!allExist) {
    // Some containers are missing, recreate the entire instance
    console.log(`Instance ${instance.name} has missing containers, recreating...`);
    await createAndStartInstance(instance);
    return;
  }

  // All containers exist, start them
  await postgresContainer.start().catch(() => { });
  await waitForPostgres(instance.name, 60_000);

  await backendContainer.start().catch(() => { });
  await dashboardContainer.start().catch(() => { });

  // Start or create Better Auth sidecar
  const betterauthContainer = await getContainerByRole(instance, 'betterauth');
  if (betterauthContainer) {
    try {
      await betterauthContainer.start();
    } catch (err: any) {
      console.warn(`Failed to start Better Auth sidecar for ${instance.name}:`, err.message);
    }
  } else {
    try {
      await createBetterAuthSidecar(instance);
    } catch (err: any) {
      console.warn(`Failed to create Better Auth sidecar for ${instance.name}:`, err.message);
    }
  }
  updateInstance(instance.id, { status: 'running' });
}

export async function stopInstance(instance: Instance): Promise<void> {
  // Stop containers by name (more reliable than stored IDs)
  const roles: Array<'betterauth' | 'dashboard' | 'backend' | 'postgres'> = ['betterauth', 'dashboard', 'backend', 'postgres'];

  for (const role of roles) {
    const container = await getContainerByRole(instance, role);
    if (container) {
      try {
        await container.stop();
      } catch (err: any) {
        if (!err.message?.includes('not running') && err.statusCode !== 304) {
          if (role === 'betterauth') {
            console.warn(`Failed to stop Better Auth sidecar for ${instance.name}:`, err.message);
          } else {
            throw err;
          }
        }
      }
    }
  }
  updateInstance(instance.id, { status: 'stopped' });
}

export async function removeInstance(instance: Instance): Promise<void> {
  // Remove Better Auth sidecar first
  try {
    await removeBetterAuthSidecar(instance);
  } catch (err: any) {
    console.warn(`Failed to remove Better Auth sidecar for ${instance.name}:`, err.message);
  }

  // Try removing containers by ID and by name (fallback for failed creates)
  // Inspect first to deduplicate IDs vs names pointing to the same container
  const containerRefs = [
    ...([instance.dashboard_container_id, instance.backend_container_id, instance.postgres_container_id].filter(Boolean) as string[]),
    `convexer-dashboard-${instance.name}`,
    `convexer-backend-${instance.name}`,
    `convexer-postgres-${instance.name}`,
  ];
  const removedIds = new Set<string>();
  for (const ref of containerRefs) {
    try {
      const container = docker.getContainer(ref);
      const info = await container.inspect().catch(() => null);
      if (!info) continue;
      if (removedIds.has(info.Id)) continue;
      removedIds.add(info.Id);
      try { await container.stop(); } catch { /* already stopped */ }
      await container.remove({ force: true });
    } catch (err: any) {
      if (err.statusCode !== 404) console.warn(`Failed to remove container ${ref}:`, err.message);
    }
  }

  // Brief pause so Docker fully releases volume references before we try to remove them
  await new Promise(r => setTimeout(r, 500));

  // Remove volumes - try both stored names and convention-based names (deduplicated)
  const volumesToRemove = new Set<string>(
    [
      instance.volume_name,
      instance.postgres_volume_name,
      `convexer-${instance.name}`,
      `convexer-postgres-${instance.name}`,
    ].filter(Boolean) as string[]
  );

  for (const volName of volumesToRemove) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await docker.getVolume(volName).remove();
        break;
      } catch (err: any) {
        if (err.statusCode === 404) break;
        if (err.statusCode === 409 && attempt < 2) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        console.warn(`Failed to remove volume ${volName}:`, err.message);
        break;
      }
    }
  }
}

export async function getContainerLogs(containerId: string, tail: number = 200): Promise<string> {
  const container = docker.getContainer(containerId);
  const logs = await container.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  });
  return logs.toString('utf-8');
}

export async function syncInstanceStatuses(): Promise<void> {
  const instances = getAllInstances();
  for (const instance of instances) {
    if (instance.status === 'creating') continue; // Don't interfere with creation

    let backendRunning = false;
    try {
      // Use getContainerByRole which looks up by name and auto-syncs DB
      const container = await getContainerByRole(instance, 'backend');
      if (container) {
        const info = await container.inspect();
        backendRunning = info.State.Running;
      }
    } catch (err: any) {
      if (err.statusCode !== 404) console.warn(`Failed to check backend status for ${instance.name}:`, err.message);
    }

    const newStatus = backendRunning ? 'running' : 'stopped';
    if (instance.status !== newStatus) {
      updateInstance(instance.id, { status: newStatus });
    }
  }
}

// Better Auth is a library, not a standalone Docker service
// Container support not available
