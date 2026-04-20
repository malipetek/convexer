import express, { Request, Response } from 'express';
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { toNodeHandler } from 'better-auth/node';

// Catch unhandled promise rejections (Better Auth may throw async errors)
process.on('unhandledRejection', (reason, promise) =>
{
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - let the server continue running
});

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

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DO_NOT_REQUIRE_SSL === '1' ? false : { rejectUnauthorized: false },
});

const plugins: any[] = [];

// Dynamically load @better-auth/infra dash plugin if available
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { dash } = await import('@better-auth/infra') as any;
  if (typeof dash === 'function') {
    const dashConfig: any = {
      apiKey: BETTER_AUTH_SECRET,
    };
    // Optional: add API URL and KV URL if provided
    const apiUrl = process.env.BETTER_AUTH_API_URL;
    const kvUrl = process.env.BETTER_AUTH_KV_URL;
    if (apiUrl) dashConfig.apiUrl = apiUrl;
    if (kvUrl) dashConfig.kvUrl = kvUrl;

    plugins.push(dash(dashConfig));
    console.log('Loaded @better-auth/infra dash plugin');
  } else {
    console.warn('@better-auth/infra dash is not a function');
  }
} catch (err: any) {
  console.warn('@better-auth/infra not available, running without dash plugin:', err.message);
}

// Test database connection before initializing Better Auth
try {
  const client = await pool.connect();
  const result = await client.query('SELECT NOW()');
  console.log('Database connection successful:', result.rows[0].now);
  client.release();
} catch (err: any) {
  console.error('Database connection failed:', err.message);
  process.exit(1);
}

let auth;
try {
  auth = betterAuth({
    // Pass Pool directly - Better Auth uses Kysely internally
    database: pool,
    secret: BETTER_AUTH_SECRET,
    baseURL: BASE_URL,
    emailAndPassword: {
      enabled: true,
    },
    plugins,
    trustedOrigins: ['*'],
  });
  console.log('Better Auth initialized successfully');
} catch (err: any) {
  console.error('Failed to initialize Better Auth:', err.message, err.stack);
  process.exit(1);
}

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
