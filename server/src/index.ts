import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import router from './routes.js';
import { syncInstanceStatuses, ensureImages } from './docker.js';
import { isAuthEnabled, isValidSession } from './auth.js';
import Docker from 'dockerode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4000;
const NETWORK_NAME = 'convexer-net';

const docker = new Docker();

async function ensureNetwork (): Promise<void>
{
  try {
    await docker.createNetwork({ Name: NETWORK_NAME });
    console.log(`Created network: ${NETWORK_NAME}`);
  } catch (err: any) {
    if (err.statusCode === 409) {
      console.log(`Network ${NETWORK_NAME} already exists`);
    } else {
      console.warn(`Failed to create network ${NETWORK_NAME}:`, err.message);
    }
  }
}

const app = express();

app.use(cors());
app.use(express.json());

// Auth middleware — skip if AUTH_PASSWORD not set
app.use('/api', (req, res, next) => {
  if (!isAuthEnabled()) return next();
  if (req.path === '/login' || req.path === '/health' || req.path.startsWith('/version')) return next();

  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !isValidSession(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

// Global settings endpoints (public, no auth)
app.get('/api/settings', (_req, res) =>
{
  res.json({ hostname: process.env.DOMAIN || '' });
});

app.post('/api/settings', (req, res) =>
{
  console.log('Saving settings:', req.body);
  const { hostname } = req.body;
  if (hostname) {
    process.env.DOMAIN = hostname;
    console.log('Hostname set to:', hostname);
  }
  res.json({ success: true, hostname });
});

// API routes
app.use('/api', router);

// Version endpoints (public, no auth)
app.get('/api/version', (_req, res) =>
{
  res.json({ current_version: '0.1.0' });
});

app.get('/api/version/check', async (_req, res) =>
{
  try {
    const LATEST_VERSION = '0.2.0';
    res.json({
      current_version: '0.1.0',
      latest_version: LATEST_VERSION,
      has_update: true,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/version/update', async (_req, res) =>
{
  try {
    console.log('Update triggered - would pull from main branch');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Serve static client build in production
const clientDist = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, async () =>
{
  console.log(`Convexer server running on http://localhost:${PORT}`);

  // Ensure shared Docker network exists
  await ensureNetwork();

  // Sync instance statuses with Docker on startup
  syncInstanceStatuses().catch(err => {
    console.warn('Failed to sync instance statuses:', err.message);
  });

  // Pre-pull images in background
  ensureImages().catch(err => {
    console.warn('Failed to ensure images:', err.message);
  });
});
