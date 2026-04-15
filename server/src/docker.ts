import Docker from 'dockerode';
import crypto from 'crypto';
import { Instance } from './types.js';
import { updateInstance, getAllInstances } from './db.js';
import { addTunnelRoutes, isTunnelEnabled, getInstanceHostnames } from './tunnel.js';
import { getBackendTraefikLabels, getDashboardTraefikLabels } from './traefik.js';

const docker = new Docker();
const NETWORK_NAME = 'convexer-net';

const BACKEND_IMAGE = 'ghcr.io/get-convex/convex-backend:latest';
const DASHBOARD_IMAGE = 'ghcr.io/get-convex/convex-dashboard:latest';
const POSTGRES_IMAGE = 'postgres:16-alpine';

export async function ensureImages(): Promise<void> {
  for (const image of [BACKEND_IMAGE, DASHBOARD_IMAGE, POSTGRES_IMAGE]) {
    try {
      await docker.getImage(image).inspect();
    } catch {
      console.log(`Pulling ${image}...`);
      const stream = await docker.pull(image);
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
}

export async function createAndStartInstance(instance: Instance): Promise<void> {
  try {
    const volumeName = instance.volume_name;
    const postgresVolumeName = instance.postgres_volume_name;

    // Create volumes
    await docker.createVolume({ Name: volumeName });
    await docker.createVolume({ Name: postgresVolumeName });

    const isLinux = process.platform === 'linux';
    const extraHosts = isLinux ? ['host.docker.internal:host-gateway'] : [];
    const domain = process.env.DOMAIN || '';

    // Generate PostgreSQL password if not set
    const postgresPassword = instance.postgres_password || crypto.randomBytes(32).toString('hex');
    updateInstance(instance.id, { postgres_password: postgresPassword });

    // Create and start PostgreSQL container
    const postgresContainer = await docker.createContainer({
      Image: POSTGRES_IMAGE,
      name: `convexer-postgres-${instance.name}`,
      ExposedPorts: { '5432/tcp': {} },
      HostConfig: {
        PortBindings: {
          '5432/tcp': [{ HostPort: String(instance.postgres_port) }],
        },
        Binds: [`${postgresVolumeName}:/var/lib/postgresql/data`],
        RestartPolicy: { Name: 'unless-stopped' },
      },
      Env: [
        `POSTGRES_PASSWORD=${postgresPassword}`,
        `POSTGRES_DB=${instance.instance_name}`,
        `POSTGRES_USER=postgres`,
      ],
    });

    await postgresContainer.start();

    // Attach to network
    try {
      const network = docker.getNetwork(NETWORK_NAME);
      await network.connect({ Container: postgresContainer.id });
    } catch (err: any) {
      console.warn(`Failed to connect PostgreSQL to network:`, err.message);
    }

    updateInstance(instance.id, { postgres_container_id: postgresContainer.id });

    // Wait for PostgreSQL to be ready
    await waitForPostgres(instance.name, 60_000);

    // Build backend env vars
    const backendEnv = [
      `CONVEX_INSTANCE_NAME=${instance.instance_name}`,
      `CONVEX_INSTANCE_SECRET=${instance.instance_secret}`,
      `INSTANCE_NAME=${instance.instance_name}`,
      `INSTANCE_SECRET=${instance.instance_secret}`,
      `POSTGRES_URL=postgres://postgres:${postgresPassword}@convexer-postgres-${instance.name}:5432?sslmode=disable`,
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

    // Build backend command - use postgres-v5 driver with no-ssl flag when POSTGRES_URL is set
    const backendCmd = [
      '--db', 'postgres-v5',
      '--do-not-require-ssl',
      `postgres://postgres:${postgresPassword}@convexer-postgres-${instance.name}:5432`,
    ];

    // Create and start backend container
    const backendContainer = await docker.createContainer({
      Image: BACKEND_IMAGE,
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
      Cmd: backendCmd,
      Env: backendEnv,
      Labels: backendTraefikLabels,
    });

    await backendContainer.start();

    // Attach to network
    try {
      const network = docker.getNetwork(NETWORK_NAME);
      await network.connect({ Container: backendContainer.id });
    } catch (err: any) {
      console.warn(`Failed to connect backend to network:`, err.message);
    }

    updateInstance(instance.id, { backend_container_id: backendContainer.id });

    // Wait for backend to be healthy (use container name on network)
    await waitForHealth(`http://convexer-backend-${instance.name}:3210`, 300_000);

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

    // Create and start dashboard container
    const dashboardTraefikLabels = getDashboardTraefikLabels(instance, domain);
    const dashboardContainer = await docker.createContainer({
      Image: DASHBOARD_IMAGE,
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

    await dashboardContainer.start();

    // Attach to network
    try {
      const network = docker.getNetwork(NETWORK_NAME);
      await network.connect({ Container: dashboardContainer.id });
    } catch (err: any) {
      console.warn(`Failed to connect dashboard to network:`, err.message);
    }

    updateInstance(instance.id, {
      dashboard_container_id: dashboardContainer.id,
      status: 'running',
    });

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
    const chunks: Buffer[] = [];
    let buffer = Buffer.alloc(0);

    stream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      // Docker multiplexed stream: 8-byte header per frame
      // [stream_type(1), 0, 0, 0, size(4 big-endian)] then payload
      while (buffer.length >= 8) {
        const size = buffer.readUInt32BE(4);
        if (buffer.length < 8 + size) break;
        chunks.push(buffer.subarray(8, 8 + size));
        buffer = buffer.subarray(8 + size);
      }
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

export async function startInstance(instance: Instance): Promise<void> {
  if (instance.postgres_container_id) {
    const container = docker.getContainer(instance.postgres_container_id);
    await container.start();
    await waitForPostgres(instance.name, 60_000);
  }
  if (instance.backend_container_id) {
    const container = docker.getContainer(instance.backend_container_id);
    await container.start();
  }
  if (instance.dashboard_container_id) {
    const container = docker.getContainer(instance.dashboard_container_id);
    await container.start();
  }
  updateInstance(instance.id, { status: 'running' });
}

export async function stopInstance(instance: Instance): Promise<void> {
  if (instance.dashboard_container_id) {
    try {
      const container = docker.getContainer(instance.dashboard_container_id);
      await container.stop();
    } catch (err: any) {
      if (!err.message?.includes('not running') && err.statusCode !== 304) throw err;
    }
  }
  if (instance.backend_container_id) {
    try {
      const container = docker.getContainer(instance.backend_container_id);
      await container.stop();
    } catch (err: any) {
      if (!err.message?.includes('not running') && err.statusCode !== 304) throw err;
    }
  }
  if (instance.postgres_container_id) {
    try {
      const container = docker.getContainer(instance.postgres_container_id);
      await container.stop();
    } catch (err: any) {
      if (!err.message?.includes('not running') && err.statusCode !== 304) throw err;
    }
  }
  updateInstance(instance.id, { status: 'stopped' });
}

export async function removeInstance(instance: Instance): Promise<void> {
  // Try removing containers by ID and by name (fallback for failed creates)
  const containerIds = [instance.dashboard_container_id, instance.backend_container_id, instance.postgres_container_id].filter(Boolean) as string[];
  const containerNames = [`convexer-dashboard-${instance.name}`, `convexer-backend-${instance.name}`, `convexer-postgres-${instance.name}`];

  for (const ref of [...containerIds, ...containerNames]) {
    try {
      const container = docker.getContainer(ref);
      try { await container.stop(); } catch { /* already stopped or doesn't exist */ }
      await container.remove({ force: true });
    } catch { /* container doesn't exist, that's fine */ }
  }

  // Remove volumes
  try {
    const volume = docker.getVolume(instance.volume_name);
    await volume.remove();
  } catch (err: any) {
    if (err.statusCode !== 404) console.warn(`Failed to remove volume ${instance.volume_name}:`, err.message);
  }

  try {
    const postgresVolume = docker.getVolume(instance.postgres_volume_name);
    await postgresVolume.remove();
  } catch (err: any) {
    if (err.statusCode !== 404) console.warn(`Failed to remove PostgreSQL volume ${instance.postgres_volume_name}:`, err.message);
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
    if (instance.backend_container_id) {
      try {
        const info = await docker.getContainer(instance.backend_container_id).inspect();
        backendRunning = info.State.Running;
      } catch {
        backendRunning = false;
      }
    }

    const expectedStatus = instance.status;
    const actualStatus = backendRunning ? 'running' : 'stopped';

    if (expectedStatus !== actualStatus && expectedStatus !== 'error') {
      console.log(`Syncing instance ${instance.name}: ${expectedStatus} → ${actualStatus}`);
      updateInstance(instance.id, { status: actualStatus });
    }
  }
}
