import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import router from './routes.js';
import { syncInstanceStatuses, ensureImages } from './docker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4000;

const app = express();

app.use(cors());
app.use(express.json());

// API routes
app.use('/api', router);

// Serve static client build in production
const clientDist = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Convexer server running on http://localhost:${PORT}`);

  // Sync instance statuses with Docker on startup
  syncInstanceStatuses().catch(err => {
    console.warn('Failed to sync instance statuses:', err.message);
  });

  // Pre-pull images in background
  ensureImages().catch(err => {
    console.warn('Failed to ensure images:', err.message);
  });
});
