import express, { Request, Response } from 'express';
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { toNodeHandler } from 'better-auth/node';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4200;
const DATABASE_URL = process.env.DATABASE_URL;
const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
const BASE_URL = process.env.BASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (!BETTER_AUTH_SECRET) {
  console.error('BETTER_AUTH_SECRET is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const plugins: any[] = [];

// Dynamically load @better-auth/infra if available
try {
  const { infra } = await import('@better-auth/infra');
  plugins.push(infra());
  console.log('Loaded @better-auth/infra plugin');
} catch (err) {
  console.warn('@better-auth/infra not available, running without infra plugin');
}

const auth = betterAuth({
  database: {
    type: 'pg',
    pool,
  },
  secret: BETTER_AUTH_SECRET,
  baseURL: BASE_URL,
  emailAndPassword: {
    enabled: true,
  },
  plugins,
  trustedOrigins: ['*'],
});

const app = express();

app.use('/api/auth', toNodeHandler(auth));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'better-auth-sidecar',
    authUrl: `${BASE_URL || ''}/api/auth`,
  });
});

app.listen(PORT, () => {
  console.log(`Better Auth sidecar running on port ${PORT}`);
  console.log(`Auth URL: ${BASE_URL || `http://localhost:${PORT}`}/api/auth`);
});
