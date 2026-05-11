import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const WEBDAV_REMOTE = 'convexer_webdav';

type WebDavConfig = {
  url: string;
  user: string;
  password: string;
};

type NormalizedWebDavTarget = {
  config: WebDavConfig;
  subfolder: string;
};

function cleanRemoteSubfolder (subfolder: string | null | undefined): string
{
  return subfolder ? subfolder.replace(/^\/+|\/+$/g, '') : '';
}

function webDavRemotePath (subfolder?: string | null): string
{
  const clean = cleanRemoteSubfolder(subfolder);
  return clean ? `${WEBDAV_REMOTE}:${clean}` : `${WEBDAV_REMOTE}:`;
}

function normalizeWebDavTarget (config: WebDavConfig, subfolder?: string | null): NormalizedWebDavTarget
{
  const cleanSubfolder = cleanRemoteSubfolder(subfolder);

  try {
    const parsed = new URL(config.url);
    const isKoofr = parsed.hostname.toLowerCase() === 'app.koofr.net';
    const cleanPath = parsed.pathname.replace(/\/+$/g, '');
    if (!isKoofr || cleanPath !== '/dav') {
      return { config, subfolder: cleanSubfolder };
    }

    parsed.pathname = '/dav/Koofr';
    const koofrSubfolder = cleanSubfolder === 'Koofr'
      ? ''
      : cleanSubfolder.replace(/^Koofr\//, '');
    return {
      config: { ...config, url: parsed.toString().replace(/\/$/, '') },
      subfolder: koofrSubfolder,
    };
  } catch {
    return { config, subfolder: cleanSubfolder };
  }
}

async function webDavEnv (config: WebDavConfig): Promise<NodeJS.ProcessEnv>
{
  const { stdout } = await execFileAsync('rclone', ['obscure', config.password]);
  return {
    ...process.env,
    RCLONE_CONFIG_CONVEXER_WEBDAV_TYPE: 'webdav',
    RCLONE_CONFIG_CONVEXER_WEBDAV_URL: config.url,
    RCLONE_CONFIG_CONVEXER_WEBDAV_VENDOR: 'other',
    RCLONE_CONFIG_CONVEXER_WEBDAV_USER: config.user,
    RCLONE_CONFIG_CONVEXER_WEBDAV_PASS: stdout.trim(),
  };
}

export async function rcloneWebDavLsd (
  config: WebDavConfig,
  subfolder?: string | null,
): Promise<string>
{
  const target = normalizeWebDavTarget(config, subfolder);
  const env = await webDavEnv(target.config);
  const { stdout, stderr } = await execFileAsync(
    'rclone',
    ['lsd', webDavRemotePath(target.subfolder), '--config', '/dev/null', '--contimeout', '10s', '--timeout', '15s'],
    { env, timeout: 20_000 }
  );
  return stdout + stderr;
}

export async function rcloneWebDavCopy (
  filePath: string,
  config: WebDavConfig,
  subfolder?: string | null,
): Promise<void>
{
  const target = normalizeWebDavTarget(config, subfolder);
  const env = await webDavEnv(target.config);
  await execFileAsync(
    'rclone',
    ['copy', filePath, webDavRemotePath(target.subfolder), '--config', '/dev/null'],
    { env, maxBuffer: 50 * 1024 * 1024 }
  );
}
