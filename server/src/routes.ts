import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { Instance } from './types.js';
import { getAllInstances, getInstance, createInstance, deleteInstance, allocatePorts } from './db.js';
import { createAndStartInstance, startInstance, stopInstance, removeInstance, getContainerLogs } from './docker.js';
import { removeTunnelRoutes, isTunnelEnabled, getTunnelDomain, getInstanceHostnames } from './tunnel.js';
import { createSession, isAuthEnabled } from './auth.js';

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
router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, tunnel: isTunnelEnabled(), domain: getTunnelDomain() });
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
  const { name } = req.body;
  const instanceName = name || `instance-${Date.now()}`;
  const id = uuidv4();
  const instanceSecret = crypto.randomBytes(32).toString('hex');
  const ports = allocatePorts();

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

export default router;
