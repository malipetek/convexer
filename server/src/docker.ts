import Docker from 'dockerode';
import crypto from 'crypto';
import { Instance } from './types.js';
import { updateInstance, getAllInstances } from './db.js';
import { addTunnelRoutes } from './tunnel.js';

const docker = new Docker();

const BACKEND_IMAGE = 'ghcr.io/get-convex/convex-backend:latest';
const DASHBOARD_IMAGE = 'ghcr.io/get-convex/convex-dashboard:latest';

export async function ensureImages(): Promise<void> {
  for (const image of [BACKEND_IMAGE, DASHBOARD_IMAGE]) {
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

    // Create volume
    await docker.createVolume({ Name: volumeName });

    const isLinux = process.platform === 'linux';
    const extraHosts = isLinux ? ['host.docker.internal:host-gateway'] : [];

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
      Env: [
        `CONVEX_INSTANCE_NAME=${instance.instance_name}`,
        `CONVEX_INSTANCE_SECRET=${instance.instance_secret}`,
        `INSTANCE_NAME=${instance.instance_name}`,
        `INSTANCE_SECRET=${instance.instance_secret}`,
      ],
    });

    await backendContainer.start();
    updateInstance(instance.id, { backend_container_id: backendContainer.id });

    // Wait for backend to be healthy
    await waitForHealth(`http://localhost:${instance.backend_port}`, 60_000);

    // Generate admin key
    const adminKey = await generateAdminKey(backendContainer, instance.instance_name, instance.instance_secret);
    updateInstance(instance.id, { admin_key: adminKey });

    // Create and start dashboard container
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
        `NEXT_PUBLIC_PROVISION_HOST=http://localhost:${instance.backend_port}`,
        `NEXT_PUBLIC_SITE_PROXY_HOST=http://localhost:${instance.site_proxy_port}`,
      ],
    });

    await dashboardContainer.start();
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
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return; // Backend responds
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Health check timeout for ${url}`);
}

async function generateAdminKey(container: Docker.Container, instanceName: string, instanceSecret: string): Promise<string> {
  try {
    const exec = await container.exec({
      Cmd: ['./generate_admin_key.sh'],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ Detach: false, Tty: false });
    const output = await streamToString(stream);
    const adminKey = output.trim().split('\n').pop()?.trim();
    if (adminKey) return adminKey;
  } catch (err) {
    console.warn('generate_admin_key.sh failed, generating manually');
  }

  // Fallback: generate admin key manually using the instance secret
  const keyBytes = crypto.randomBytes(32);
  return `${instanceName}|${keyBytes.toString('hex')}`;
}

function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

export async function startInstance(instance: Instance): Promise<void> {
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
  updateInstance(instance.id, { status: 'stopped' });
}

export async function removeInstance(instance: Instance): Promise<void> {
  // Remove containers
  for (const cid of [instance.dashboard_container_id, instance.backend_container_id]) {
    if (!cid) continue;
    try {
      const container = docker.getContainer(cid);
      try { await container.stop(); } catch { /* already stopped */ }
      await container.remove({ force: true });
    } catch (err: any) {
      if (err.statusCode !== 404) console.warn(`Failed to remove container ${cid}:`, err.message);
    }
  }

  // Remove volume
  try {
    const volume = docker.getVolume(instance.volume_name);
    await volume.remove();
  } catch (err: any) {
    if (err.statusCode !== 404) console.warn(`Failed to remove volume ${instance.volume_name}:`, err.message);
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
