import Docker from 'dockerode';
import { Instance } from './types.js';

const docker = new Docker();
const TRAEFIK_CONTAINER_NAME = 'convexer-traefik';
const NETWORK_NAME = 'convexer-net';

export async function ensureTraefik(): Promise<void> {
  try {
    const container = docker.getContainer(TRAEFIK_CONTAINER_NAME);
    await container.inspect();
    console.log('Traefik container already exists');
    return;
  } catch (err: any) {
    if (err.statusCode !== 404) {
      console.warn('Failed to check Traefik container:', err.message);
      return;
    }
  }

  try {
    console.log('Pulling Traefik image...');
    await docker.pull('traefik:latest');
    console.log('Creating Traefik container...');
    await docker.createContainer({
      Image: 'traefik:latest',
      name: TRAEFIK_CONTAINER_NAME,
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        PortBindings: {
          '80/tcp': [{ HostPort: '80' }],
          '443/tcp': [{ HostPort: '443' }],
        },
        Binds: ['/var/run/docker.sock:/var/run/docker.sock:ro'],
      },
      Cmd: [
        '--providers.docker=true',
        '--providers.docker.network=convexer-net',
        '--providers.docker.exposedbydefault=false',
        '--entrypoints.web.address=:80',
        '--entrypoints.websecure.address=:443',
        '--certificatesresolvers.le.acme.tlschallenge=true',
        '--certificatesresolvers.le.acme.email=webmaster@localhost',
        '--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json',
      ],
    });

    const container = docker.getContainer(TRAEFIK_CONTAINER_NAME);
    await container.start();

    // Connect to network
    const network = docker.getNetwork(NETWORK_NAME);
    await network.connect({ Container: TRAEFIK_CONTAINER_NAME });

    console.log('Traefik container created and started');
  } catch (err: any) {
    console.warn('Failed to create Traefik container:', err.message);
  }
}

export async function getTraefikStatus(): Promise<{ running: boolean; container_id: string | null }> {
  try {
    const container = docker.getContainer(TRAEFIK_CONTAINER_NAME);
    const info = await container.inspect();
    return { running: info.State.Running, container_id: container.id };
  } catch {
    return { running: false, container_id: null };
  }
}

export function getTraefikLabels(instance: Instance, domain: string): Record<string, string> {
  if (!domain) return {};

  // Parse extra_env to get custom subdomains
  let subdomain = instance.name;
  let dashboardSubdomain = `${instance.name}-dash`;

  if (instance.extra_env) {
    try {
      const env = JSON.parse(instance.extra_env);
      if (env.SUBDOMAIN) {
        subdomain = env.SUBDOMAIN;
      }
      if (env.DASHBOARD_SUBDOMAIN) {
        dashboardSubdomain = env.DASHBOARD_SUBDOMAIN;
      }
    } catch {
      // Use defaults if parsing fails
    }
  }

  const labels: Record<string, string> = {
    'traefik.enable': 'true',
    'traefik.http.routers.backend.rule': `Host(\`${subdomain}.${domain}\`)`,
    'traefik.http.routers.backend.entrypoints': 'web',
    'traefik.http.routers.backend.service': `backend-${instance.name}`,
    'traefik.http.routers.site.rule': `Host(\`${subdomain}-site.${domain}\`)`,
    'traefik.http.routers.site.entrypoints': 'web',
    'traefik.http.routers.site.service': `site-${instance.name}`,
    'traefik.http.routers.dashboard.rule': `Host(\`${dashboardSubdomain}.${domain}\`)`,
    'traefik.http.routers.dashboard.entrypoints': 'web',
    'traefik.http.routers.dashboard.service': `dashboard-${instance.name}`,
  };

  labels[`traefik.http.services.backend-${instance.name}.loadbalancer.server.port`] = '3210';
  labels[`traefik.http.services.site-${instance.name}.loadbalancer.server.port`] = '3211';
  labels[`traefik.http.services.dashboard-${instance.name}.loadbalancer.server.port`] = '6791';

  return labels;
}
