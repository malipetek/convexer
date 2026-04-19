import express, { Request, Response } from 'express';
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { toNodeHandler } from 'better-auth/node';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4200;
const DATABASE_URL = process.env.DATABASE_URL;
const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
const BASE_URL = process.env.BASE_URL;

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) =>
{
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

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

// Verify database connection
try {
  await pool.query('SELECT 1');
  console.log('Database connection verified');
} catch (err: any) {
  console.error('Failed to connect to database:', err.message, err.stack);
  process.exit(1);
}

const plugins: any[] = [];

// Dynamically load @better-auth/infra if available
// Temporarily disabled to debug database adapter issue
/*
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const infraModule = await import('@better-auth/infra') as any;
  const infraFn = infraModule.infra ?? infraModule.default?.infra ?? infraModule.default;
  if (typeof infraFn === 'function') {
    plugins.push(infraFn());
    console.log('Loaded @better-auth/infra plugin');
  } else {
    console.warn('@better-auth/infra loaded but no callable export found');
  }
} catch (err) {
  console.warn('@better-auth/infra not available, running without infra plugin');
}
*/

let auth;
try {
  auth = betterAuth({
    // Temporarily disable database to test
    // database: {
    //   type: 'pg',
    //   pool,
    // },
    secret: BETTER_AUTH_SECRET,
    baseURL: BASE_URL,
    emailAndPassword: {
      enabled: true,
    },
    plugins,
    trustedOrigins: ['*'],
  });
  console.log('Better Auth initialized successfully (without database)');
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
