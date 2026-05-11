import { execSync } from 'node:child_process';

const COMPOSE_FILE = 'e2e/docker-compose.e2e.yml';

function run(cmd: string, env: NodeJS.ProcessEnv = process.env) {
  execSync(cmd, { stdio: 'inherit', env });
}

function readLines(cmd: string): string[] {
  try {
    return execSync(cmd, { encoding: 'utf8' })
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cleanupE2EArtifacts(env: NodeJS.ProcessEnv): void {
  const containerNames = readLines("docker ps -a --format '{{.Names}}'")
    .filter(name => name === 'convexer' || name === 'convexer-candidate' || name.startsWith('convexer-image-update-') || /^convexer-(backend|dashboard|postgres|betterauth)-(e2e|valid)-/.test(name));
  if (containerNames.length > 0) {
    run(`docker rm -f ${containerNames.map(shellQuote).join(' ')}`, env);
  }

  const volumeNames = readLines("docker volume ls --format '{{.Name}}'")
    .filter(name => /^convexer(-postgres)?-(e2e|valid)-/.test(name) || /^e2e_convexer-(data|backups)$/.test(name));
  if (volumeNames.length > 0) {
    run(`docker volume rm -f ${volumeNames.map(shellQuote).join(' ')}`, env);
  }
}

async function globalTeardown() {
  if (process.env.REMOTE_BASE_URL) return;

  const authPassword = process.env.E2E_AUTH_PASSWORD || process.env.AUTH_PASSWORD || 'convexer-e2e-password';
  const env = {
    ...process.env,
    AUTH_PASSWORD: authPassword,
  };

  try {
    cleanupE2EArtifacts(env);
    run(`docker compose -f ${COMPOSE_FILE} down -v --remove-orphans`, env);
    cleanupE2EArtifacts(env);
  } catch (err) {
    console.warn('[e2e] teardown skipped due to docker compose error:', (err as Error).message);
  }
}

export default globalTeardown;
