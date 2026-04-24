import { execSync } from 'node:child_process';

const COMPOSE_FILE = 'e2e/docker-compose.e2e.yml';

function run(cmd: string, env: NodeJS.ProcessEnv = process.env) {
  execSync(cmd, { stdio: 'inherit', env });
}

async function globalTeardown() {
  if (process.env.REMOTE_BASE_URL) return;

  const authPassword = process.env.E2E_AUTH_PASSWORD || process.env.AUTH_PASSWORD || 'convexer-e2e-password';
  const env = {
    ...process.env,
    AUTH_PASSWORD: authPassword,
  };

  try {
    run(`docker compose -f ${COMPOSE_FILE} down -v --remove-orphans`, env);
  } catch (err) {
    console.warn('[e2e] teardown skipped due to docker compose error:', (err as Error).message);
  }
}

export default globalTeardown;
