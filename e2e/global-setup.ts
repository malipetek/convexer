import { execSync } from 'node:child_process';

const COMPOSE_FILE = 'e2e/docker-compose.e2e.yml';
const DEFAULT_AUTH_PASSWORD = 'convexer-e2e-password';
const REQUIRED_IMAGES = [
  'postgres:16-alpine',
  'ghcr.io/get-convex/convex-backend:latest',
  'ghcr.io/get-convex/convex-dashboard:latest',
];

function run(cmd: string, env: NodeJS.ProcessEnv = process.env) {
  execSync(cmd, { stdio: 'inherit', env });
}

function ensureDockerAvailable(): void {
  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch {
    throw new Error('Docker daemon is not available. Start Docker (or OrbStack) before running local E2E tests.');
  }
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastError = 'unknown';

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body?.ok === true) return;
      }
      lastError = `health endpoint not ready yet (status ${res.status})`;
    } catch (err: any) {
      lastError = err?.message || String(err);
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }

  throw new Error(`Timed out waiting for ${baseUrl}/api/health: ${lastError}`);
}

async function globalSetup() {
  const baseUrl = process.env.REMOTE_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:4000';

  if (process.env.REMOTE_BASE_URL) {
    await waitForHealth(baseUrl, 120_000);
    return;
  }

  const authPassword = process.env.E2E_AUTH_PASSWORD || process.env.AUTH_PASSWORD || DEFAULT_AUTH_PASSWORD;
  const env = {
    ...process.env,
    AUTH_PASSWORD: authPassword,
    E2E_AUTH_PASSWORD: authPassword,
  };

  ensureDockerAvailable();
  for (const image of REQUIRED_IMAGES) {
    run(`docker pull ${image}`);
  }
  run('docker network create convexer-net || true');
  run(`docker compose -f ${COMPOSE_FILE} down -v --remove-orphans || true`, env);
  run(`docker compose -f ${COMPOSE_FILE} up -d --build`, env);

  await waitForHealth(baseUrl, 240_000);
}

export default globalSetup;
