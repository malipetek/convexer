import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const WEBDAV_REMOTE = 'convexer_webdav';

type WebDavConfig = {
  url: string;
  user: string;
  password: string;
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
  const env = await webDavEnv(config);
  const { stdout, stderr } = await execFileAsync(
    'rclone',
    ['lsd', webDavRemotePath(subfolder), '--config', '/dev/null', '--contimeout', '10s', '--timeout', '15s'],
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
  const env = await webDavEnv(config);
  await execFileAsync(
    'rclone',
    ['copy', filePath, webDavRemotePath(subfolder), '--config', '/dev/null'],
    { env, maxBuffer: 50 * 1024 * 1024 }
  );
}
