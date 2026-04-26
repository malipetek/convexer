import express, { Request, Response } from 'express';
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins/jwt';
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
const AUTH_BASE_PATH = '/api/auth';

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

async function ensureBetterAuthSchema ()
{
  // Create tables in dependency order
  // user table (no dependencies)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "user" (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      email_verified BOOLEAN DEFAULT false,
      name TEXT,
      image TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);

  // session table (depends on user)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
    )
  `);

  // account table (depends on user)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      access_token_expires_at TIMESTAMP,
      refresh_token_expires_at TIMESTAMP,
      scope TEXT,
      password TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
      UNIQUE (provider_id, account_id)
    )
  `);

  // verification table (no dependencies)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);

  // jwks table (no dependencies) - supports both snake_case and camelCase for JWT plugin
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jwks (
      id TEXT PRIMARY KEY,
      public_key TEXT,
      private_key TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      expires_at TIMESTAMP,
      "publicKey" TEXT,
      "privateKey" TEXT,
      "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
      "expiresAt" TIMESTAMP
    )
  `);

  // Add missing columns with ALTER TABLE IF NOT EXISTS
  // jwks table - add camelCase columns for JWT plugin
  await pool.query('ALTER TABLE jwks ADD COLUMN IF NOT EXISTS "publicKey" TEXT');
  await pool.query('ALTER TABLE jwks ADD COLUMN IF NOT EXISTS "privateKey" TEXT');
  await pool.query('ALTER TABLE jwks ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP NOT NULL DEFAULT now()');
  await pool.query('ALTER TABLE jwks ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP');
  // Make snake_case columns nullable for compatibility
  await pool.query("ALTER TABLE jwks ALTER COLUMN public_key DROP NOT NULL").catch(() => undefined);
  await pool.query("ALTER TABLE jwks ALTER COLUMN private_key DROP NOT NULL").catch(() => undefined);

  // session table - add optional columns
  await pool.query('ALTER TABLE session ADD COLUMN IF NOT EXISTS ip_address TEXT');
  await pool.query('ALTER TABLE session ADD COLUMN IF NOT EXISTS user_agent TEXT');

  // account table - add OAuth and password columns
  await pool.query('ALTER TABLE account ADD COLUMN IF NOT EXISTS access_token TEXT');
  await pool.query('ALTER TABLE account ADD COLUMN IF NOT EXISTS refresh_token TEXT');
  await pool.query('ALTER TABLE account ADD COLUMN IF NOT EXISTS id_token TEXT');
  await pool.query('ALTER TABLE account ADD COLUMN IF NOT EXISTS access_token_expires_at TIMESTAMP');
  await pool.query('ALTER TABLE account ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMP');
  await pool.query('ALTER TABLE account ADD COLUMN IF NOT EXISTS scope TEXT');
  await pool.query('ALTER TABLE account ADD COLUMN IF NOT EXISTS password TEXT');

  // Create indexes for performance
  await pool.query('CREATE INDEX IF NOT EXISTS idx_session_user_id ON session(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_account_user_id ON account(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_verification_identifier ON verification(identifier)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_verification_expires_at ON verification(expires_at)');
}

const plugins: any[] = [];

const convexJwtIssuer = (process.env.CONVEX_SITE_URL || BASE_URL || '').replace(/\/+$/, '');
if (convexJwtIssuer) {
  process.env.CONVEX_SITE_URL = convexJwtIssuer;
  plugins.push(jwt({
    jwt: {
      issuer: convexJwtIssuer,
      audience: 'convex',
      expirationTime: '15m',
      definePayload: ({ user, session }) => ({
        email: user.email,
        emailVerified: user.emailVerified,
        name: user.name,
        sessionId: session.id,
        iat: Math.floor(Date.now() / 1000),
      }),
    },
    jwks: {
      jwksPath: '/convex/jwks',
      keyPairConfig: { alg: 'RS256' },
    },
  }));
  console.log(`Loaded Convex JWT plugin with issuer ${convexJwtIssuer}`);
} else {
  console.warn('BASE_URL or CONVEX_SITE_URL is required to enable Convex JWT token endpoint');
}

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
  await ensureBetterAuthSchema();
} catch (err: any) {
  console.error('Database connection failed:', err.message);
  process.exit(1);
}

// Build social providers config dynamically based on env vars
const socialProviders: Record<string, any> = {};

if (process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET) {
  socialProviders.apple = {
    clientId: process.env.APPLE_CLIENT_ID,
    clientSecret: process.env.APPLE_CLIENT_SECRET,
    appBundleIdentifier: process.env.APPLE_APP_BUNDLE_IDENTIFIER,
  };
  console.log('Apple social provider enabled');
}

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  socialProviders.google = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  };
  console.log('Google social provider enabled');
}

// Build deterministic trusted origins from BASE_URL and related URLs
const trustedOrigins: string[] = [];
if (BASE_URL) {
  trustedOrigins.push(BASE_URL);
  // Add localhost for development
  if (BASE_URL.includes('localhost')) {
    trustedOrigins.push('http://localhost:*', 'http://127.0.0.1:*');
  }
}
// Add development origins
trustedOrigins.push('http://localhost:*', 'http://127.0.0.1:*');

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
    socialProviders: Object.keys(socialProviders).length > 0 ? socialProviders : undefined,
    plugins,
    trustedOrigins,
    // Map Better Auth field names to the existing snake_case PostgreSQL schema
    user: {
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    session: {
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    account: {
      fields: {
        userId: 'user_id',
        accountId: 'account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        scope: 'scope',
        password: 'password',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
  });
  console.log('Better Auth initialized successfully');
} catch (err: any) {
  console.error('Failed to initialize Better Auth:', err.message, err.stack);
  process.exit(1);
}

const app = express();

const authHandler = toNodeHandler(auth);

app.use(AUTH_BASE_PATH, (req, res) => {
  if (req.url.startsWith('/convex/token')) {
    req.url = `/token${req.url.slice('/convex/token'.length)}`;
    req.originalUrl = `${AUTH_BASE_PATH}${req.url}`;
  }
  return authHandler(req, res);
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'better-auth-sidecar',
    authUrl: `${BASE_URL || ''}${AUTH_BASE_PATH}`,
  });
});

app.listen(PORT, () => {
  console.log(`Better Auth sidecar running on port ${PORT}`);
  console.log(`Auth URL: ${BASE_URL || `http://localhost:${PORT}`}${AUTH_BASE_PATH}`);
});
