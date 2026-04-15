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

export function getBackendTraefikLabels (instance: Instance, domain: string): Record<string, string>
{
  if (!domain) return {};

  // Parse extra_env to get custom domains
  let backendDomain = `${instance.name}.${domain}`;
  let siteDomain = `${instance.name}-site.${domain}`;

  if (instance.extra_env) {
    try {
      const env = JSON.parse(instance.extra_env);
      if (env.BACKEND_DOMAIN) {
        backendDomain = env.BACKEND_DOMAIN;
      }
      if (env.SITE_DOMAIN) {
        siteDomain = env.SITE_DOMAIN;
      }
    } catch {
      // Use defaults if parsing fails
    }
  }

  const labels: Record<string, string> = {
    'traefik.enable': 'true',
  };

  labels[`traefik.http.routers.backend-${instance.name}.rule`] = `Host(\`${backendDomain}\`)`;
  labels[`traefik.http.routers.backend-${instance.name}.entrypoints`] = 'web';
  labels[`traefik.http.routers.backend-${instance.name}.service`] = `backend-${instance.name}`;
  labels[`traefik.http.services.backend-${instance.name}.loadbalancer.server.port`] = '3210';

  labels[`traefik.http.routers.site-${instance.name}.rule`] = `Host(\`${siteDomain}\`)`;
  labels[`traefik.http.routers.site-${instance.name}.entrypoints`] = 'web';
  labels[`traefik.http.routers.site-${instance.name}.service`] = `site-${instance.name}`;
  labels[`traefik.http.services.site-${instance.name}.loadbalancer.server.port`] = '3211';

  return labels;
}

export function getDashboardTraefikLabels (instance: Instance, domain: string): Record<string, string>
{
  if (!domain) return {};

  // Parse extra_env to get custom domain
  let dashboardDomain = `${instance.name}-dash.${domain}`;

  if (instance.extra_env) {
    try {
      const env = JSON.parse(instance.extra_env);
      if (env.DASHBOARD_DOMAIN) {
        dashboardDomain = env.DASHBOARD_DOMAIN;
      }
    } catch {
      // Use defaults if parsing fails
    }
  }

  const labels: Record<string, string> = {
    'traefik.enable': 'true',
  };

  labels[`traefik.http.routers.dashboard-${instance.name}.rule`] = `Host(\`${dashboardDomain}\`)`;
  labels[`traefik.http.routers.dashboard-${instance.name}.entrypoints`] = 'web';
  labels[`traefik.http.routers.dashboard-${instance.name}.service`] = `dashboard-${instance.name}`;
  labels[`traefik.http.services.dashboard-${instance.name}.loadbalancer.server.port`] = '6791';

  return labels;
}
