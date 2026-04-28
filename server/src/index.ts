import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { syncInstanceStatuses, ensureImages } from './docker.js';
import { isAuthEnabled, isValidSession } from './auth.js';
import Docker from 'dockerode';
import { initializeBackupScheduler } from './scheduler.js';
import { runMigrations } from './migrate.js';
import { asError, err } from './http.js';
import { parseOrThrow, saveSettingsSchema } from './validation.js';

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
  // Only these paths are public. Note: /version/update is intentionally NOT
  // public — it must only be callable by authenticated users.
  const publicPaths = new Set(['/login', '/health', '/version', '/version/check', '/settings', '/version/update/logs']);
  if (publicPaths.has(req.path)) return next();

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
  try {
    const { hostname } = parseOrThrow(saveSettingsSchema, req.body);
    process.env.DOMAIN = hostname;
    res.json({ success: true, hostname });
  } catch (error) {
    const appError = asError(error);
    err(res, appError.status, appError.code, appError.message, appError.details);
  }
});

async function boot(): Promise<void> {
  try {
    runMigrations();
    const routesModule = await import('./routes.js');
    app.use('/api', routesModule.default);

    // Serve static client build in production
    const clientDist = path.join(__dirname, '../../client/dist');
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });

    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const appError = asError(error);
      err(res, appError.status, appError.code, appError.message, appError.details);
    });
  } catch (error) {
    const appError = asError(error);
    console.error('[boot] failed to initialize routes', appError);
    process.exit(1);
  }
}

boot().then(() => app.listen(PORT, async () =>
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
}));
