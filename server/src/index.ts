import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import router from './routes.js';
import { syncInstanceStatuses, ensureImages } from './docker.js';
import { isAuthEnabled, isValidSession } from './auth.js';
import Docker from 'dockerode';
import { initializeBackupScheduler } from './scheduler.js';

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
  if (req.path === '/login' || req.path === '/health' || req.path.startsWith('/version') || req.path.startsWith('/settings')) return next();

  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !isValidSession(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});


app.get('/api/settings', (_req, res) =>
{
  res.json({ hostname: process.env.DOMAIN || '' });
});

app.post('/api/settings', (req, res) =>
{
  const { hostname } = req.body;
  if (hostname) {
    process.env.DOMAIN = hostname;
  }
  res.json({ success: true, hostname: hostname || '' });
});

// API routes
app.use('/api', router);

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

  // Initialize backup scheduler
  try {
    initializeBackupScheduler();
  } catch (err: any) {
    console.warn('Failed to initialize backup scheduler:', err.message);
  }
});
