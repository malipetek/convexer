import Docker from 'dockerode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { Instance } from './types.js';
import { getInstance, getBackupConfig, createBackupHistory, updateBackupHistory, deleteOldBackups, getBackupDestinations, BackupConfig } from './db.js';

const execAsync = promisify(exec);
const docker = new Docker();

export async function backupDatabase (instance: Instance, backupId: string, label?: string): Promise<{ success: boolean; filePath?: string; error?: string }>
{
  const history = createBackupHistory({
    id: backupId,
    instance_id: instance.id,
    backup_type: 'database',
    status: 'running',
    storage_type: 'local',
    label: label ?? 'Manual',
  });

  try {
    const container = docker.getContainer(`convexer-postgres-${instance.name}`);
    
    const exec = await container.exec({
      Cmd: ['pg_dump', '-U', 'postgres', instance.instance_name.replace(/-/g, '_')],
      AttachStdout: true,
      AttachStderr: true,
    });
    
    const stream = await exec.start({ Detach: false, Tty: false });
    const chunks: any[] = [];

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: any) => { chunks.push(chunk); });
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    // Demux Docker multiplexed exec stream: [type:1][pad:3][size:4 BE][payload:size]
    const raw: any = Buffer.concat(chunks);
    const stdoutParts: any[] = [];
    const stderrParts: any[] = [];
    let pos = 0;
    while (pos + 8 <= raw.length) {
      const type = raw[pos];
      const size = raw.readUInt32BE(pos + 4);
      const payload = raw.subarray(pos + 8, pos + 8 + size);
      if (type === 1) stdoutParts.push(payload);
      else if (type === 2) stderrParts.push(payload);
      pos += 8 + size;
    }

    const sql: string = Buffer.concat(stdoutParts).toString('utf-8');
    if (!sql || sql.length < 50) {
      const errOut = Buffer.concat(stderrParts).toString('utf-8');
      throw new Error(`pg_dump produced no output${errOut ? `: ${errOut}` : ''}`);
    }
    
    // Create backup directory
    const backupDir = path.join(process.env.DATA_DIR || process.cwd(), 'backups', instance.id);
    await fs.mkdir(backupDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(backupDir, `${instance.name}-database-${timestamp}.sql`);
    await fs.writeFile(filePath, sql);
    
    const stats = await fs.stat(filePath);
    
    updateBackupHistory(backupId, {
      status: 'completed',
      size_bytes: stats.size,
      file_path: filePath,
      completed_at: new Date().toISOString(),
    });
    
    return { success: true, filePath };
  } catch (err: any) {
    updateBackupHistory(backupId, {
      status: 'failed',
      error_message: err.message,
      completed_at: new Date().toISOString(),
    });
    return { success: false, error: err.message };
  }
}

export async function backupVolume (instance: Instance, backupId: string, label?: string): Promise<{ success: boolean; filePath?: string; error?: string }>
{
  const history = createBackupHistory({
    id: backupId,
    instance_id: instance.id,
    backup_type: 'volume',
    status: 'running',
    storage_type: 'local',
    label: label ?? 'Manual',
  });

  try {
    // Create backup directory
    const backupDir = path.join(process.env.DATA_DIR || process.cwd(), 'backups', instance.id);
    await fs.mkdir(backupDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(backupDir, `${instance.name}-volume-${timestamp}.tar.gz`);
    
    // Write tar output directly into the backup volume to avoid binary corruption
    // from Docker log stream demuxing. Alpine writes the file; we just wait for exit.
    await new Promise<void>((resolve, reject) =>
    {
      docker.pull('alpine:latest', (err: any, stream: any) =>
      {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err: any) => err ? reject(err) : resolve());
      });
    });

    // Find the named volume that owns the backup directory
    const selfInfo = await docker.getContainer('convexer').inspect();
    const namedMounts: any[] = (selfInfo.Mounts || []).filter((m: any) => m.Type === 'volume' && m.Name);
    namedMounts.sort((a: any, b: any) => b.Destination.length - a.Destination.length);
    const backupMount = namedMounts.find((m: any) => filePath.startsWith(m.Destination + '/') || filePath === m.Destination);
    if (!backupMount) throw new Error(`Cannot find volume mount covering: ${filePath}`);

    const relPath = path.relative(backupMount.Destination, filePath);

    const container = await docker.createContainer({
      Image: 'alpine',
      Cmd: ['tar', '-czf', `/backup-out/${relPath}`, '-C', '/data', '.'],
      HostConfig: {
        Binds: [
          `${instance.volume_name}:/data:ro`,
          `${backupMount.Name}:/backup-out`,
        ],
      },
    });

    try {
      await container.start();
      const { StatusCode } = await container.wait();
      if (StatusCode !== 0) {
        const errLogs = await container.logs({ stdout: false, stderr: true }) as unknown as Buffer;
        throw new Error(`tar backup exited with code ${StatusCode}: ${errLogs.toString().slice(0, 200)}`);
      }
    } finally {
      try { await container.remove({ force: true }); } catch { }
    }
    
    const stats = await fs.stat(filePath);
    
    updateBackupHistory(backupId, {
      status: 'completed',
      size_bytes: stats.size,
      file_path: filePath,
      completed_at: new Date().toISOString(),
    });
    
    return { success: true, filePath };
  } catch (err: any) {
    updateBackupHistory(backupId, {
      status: 'failed',
      error_message: err.message,
      completed_at: new Date().toISOString(),
    });
    return { success: false, error: err.message };
  }
}

export async function restoreDatabase (instance: Instance, filePath: string): Promise<void>
{
  const dbName = instance.instance_name.replace(/-/g, '_');
  const host = `convexer-postgres-${instance.name}`;

  // Pull postgres image (has psql) if not present
  await new Promise<void>((resolve, reject) =>
  {
    docker.pull('postgres:16-alpine', (err: any, stream: any) =>
    {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err: any) => err ? reject(err) : resolve());
    });
  });

  // Find the named volume that holds the backup file
  const selfInfo = await docker.getContainer('convexer').inspect();
  const namedMounts: any[] = (selfInfo.Mounts || []).filter((m: any) => m.Type === 'volume' && m.Name);
  namedMounts.sort((a: any, b: any) => b.Destination.length - a.Destination.length);
  const backupMount = namedMounts.find((m: any) => filePath.startsWith(m.Destination + '/') || filePath === m.Destination);
  if (!backupMount) throw new Error(`Cannot find volume covering: ${filePath}`);
  const relPath = path.relative(backupMount.Destination, filePath);

  // Discover which network the postgres container is on (need convexer-net)
  const pgInfo = await docker.getContainer(host).inspect();
  const networkNames = Object.keys(pgInfo.NetworkSettings.Networks || {});
  const network = networkNames.find(n => n !== 'bridge') || networkNames[0];
  if (!network) throw new Error(`No network found for postgres container ${host}`);

  async function runHelper (cmd: string[], binds: string[] = []): Promise<void>
  {
    const c = await docker.createContainer({
      Image: 'postgres:16-alpine',
      Cmd: cmd,
      Env: [`PGPASSWORD=${instance.postgres_password}`],
      HostConfig: {
        NetworkMode: network,
        Binds: binds,
        AutoRemove: false,
      },
    });
    try {
      await c.start();
      const { StatusCode } = await c.wait();
      if (StatusCode !== 0) {
        const logs = await c.logs({ stdout: true, stderr: true, follow: false }) as unknown as Buffer;
        throw new Error(`psql helper exited with ${StatusCode}: ${logs.toString().slice(-600)}`);
      }
    } finally {
      try { await c.remove({ force: true }); } catch { }
    }
  }

  // Wipe public schema
  await runHelper([
    'psql', '-h', host, '-U', 'postgres', '-d', dbName,
    '-v', 'ON_ERROR_STOP=1',
    '-c', 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO postgres;',
  ]);

  // Restore from file
  await runHelper([
    'psql', '-h', host, '-U', 'postgres', '-d', dbName,
    '-v', 'ON_ERROR_STOP=1',
    '-f', `/backup/${relPath}`,
  ], [`${backupMount.Name}:/backup:ro`]);
}

export async function restoreVolume (instance: Instance, filePath: string): Promise<void>
{
  await new Promise<void>((resolve, reject) =>
  {
    docker.pull('alpine:latest', (err: any, stream: any) =>
    {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err: any) => err ? reject(err) : resolve());
    });
  });

  // Discover the most-specific named volume mount that contains the backup file
  const selfContainer = docker.getContainer('convexer');
  const selfInfo = await selfContainer.inspect();
  const namedMounts: any[] = (selfInfo.Mounts || []).filter((m: any) => m.Type === 'volume' && m.Name);
  // Sort longest Destination first so we pick the most-specific mount
  namedMounts.sort((a: any, b: any) => b.Destination.length - a.Destination.length);
  const match = namedMounts.find((m: any) => filePath.startsWith(m.Destination + '/') || filePath === m.Destination);
  if (!match) throw new Error(`Cannot find a named volume mount covering backup path: ${filePath}`);

  const relPath = path.relative(match.Destination, filePath);

  // Wipe existing volume contents, then extract backup
  const container = await docker.createContainer({
    Image: 'alpine',
    Cmd: ['sh', '-c', `rm -rf /data/* /data/.[!.]* /data/..?* 2>/dev/null; tar -xzf /backup-src/${relPath} -C /data`],
    HostConfig: {
      Binds: [
        `${instance.volume_name}:/data`,
        `${match.Name}:/backup-src:ro`,
      ],
    },
  });

  try {
    await container.start();
    const { StatusCode } = await container.wait();
    if (StatusCode !== 0) {
      const logs = await container.logs({ stdout: true, stderr: true, follow: false }) as unknown as Buffer;
      throw new Error(`Volume restore exited with ${StatusCode}: ${logs.toString().slice(-400)}`);
    }
  } finally {
    try { await container.remove({ force: true }); } catch { }
  }
}

export async function rsyncBackup(filePath: string, target: string): Promise<{ success: boolean; error?: string }> {
  try {
    const targetPath = target.endsWith('/') ? target : target + '/';
    const fileName = path.basename(filePath);
    const destPath = targetPath + fileName;
    
    await execAsync(`rsync -avz -e "ssh -o StrictHostKeyChecking=accept-new" "${filePath}" "${destPath}"`);
    
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Build rclone remote config spec on-the-fly and copy file to remote.
 * Uses --config /dev/null with :<backend>, connection-string syntax so creds aren't written to disk.
 */
async function rcloneCopy (
  filePath: string,
  remoteSpec: string,
  subfolder: string | null | undefined,
): Promise<{ success: boolean; error?: string }>
{
  try {
    let remotePath = remoteSpec;
    if (subfolder) {
      const clean = subfolder.replace(/^\/+|\/+$/g, '');
      remotePath = `${remoteSpec}/${clean}`;
    }
    await execAsync(`rclone copy "${filePath}" "${remotePath}" --config /dev/null`, { maxBuffer: 50 * 1024 * 1024 });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || err.stderr };
  }
}

export async function koofrBackup (
  filePath: string,
  email: string,
  password: string,
  subfolder?: string | null,
): Promise<{ success: boolean; error?: string }>
{
  // Obscure password for rclone
  try {
    const { stdout } = await execAsync(`rclone obscure "${password.replace(/"/g, '\\"')}"`);
    const obscured = stdout.trim();
    // Use WebDAV backend against Koofr
    const remote = `:webdav,url="https://app.koofr.net/dav/Koofr",vendor="other",user="${email}",pass="${obscured}":`;
    return await rcloneCopy(filePath, remote, subfolder);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function webdavBackup (
  filePath: string,
  url: string,
  user: string,
  password: string,
  subfolder?: string | null,
): Promise<{ success: boolean; error?: string }>
{
  try {
    const { stdout } = await execAsync(`rclone obscure "${password.replace(/"/g, '\\"')}"`);
    const obscured = stdout.trim();
    const remote = `:webdav,url="${url}",vendor="other",user="${user}",pass="${obscured}":`;
    return await rcloneCopy(filePath, remote, subfolder);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function uploadToDestination (filePath: string, instanceId: string): Promise<void>
{
  const destinations = getBackupDestinations(instanceId);
  const enabledDestinations = destinations.filter(d => d.enabled === 1);

  for (const dest of enabledDestinations) {
    const destType = dest.destination_type;
    const subfolder = dest.remote_subfolder;

    if (destType === 'rsync' && dest.rsync_target) {
      const target = subfolder ? `${dest.rsync_target.replace(/\/$/, '')}/${subfolder.replace(/^\/+|\/+$/g, '')}` : dest.rsync_target;
      const result = await rsyncBackup(filePath, target);
      if (!result.success) console.error('Rsync failed:', result.error);
    } else if (destType === 'koofr' && dest.koofr_email && dest.koofr_password) {
      const result = await koofrBackup(filePath, dest.koofr_email, dest.koofr_password, subfolder);
      if (!result.success) console.error('Koofr upload failed:', result.error);
    } else if (destType === 'webdav' && dest.webdav_url && dest.webdav_user && dest.webdav_password) {
      const result = await webdavBackup(filePath, dest.webdav_url, dest.webdav_user, dest.webdav_password, subfolder);
      if (!result.success) console.error('WebDAV upload failed:', result.error);
    } else if (destType === 's3' && dest.s3_bucket && dest.s3_access_key && dest.s3_secret_key) {
      const result = await s3Backup(filePath, dest.s3_bucket, dest.s3_region, dest.s3_access_key, dest.s3_secret_key, dest.s3_endpoint, subfolder);
      if (!result.success) console.error('S3 upload failed:', result.error);
    }
  }
}

export async function performBackup(instanceId: string): Promise<void> {
  const instance = getInstance(instanceId);
  if (!instance) {
    console.error(`Instance ${instanceId} not found for backup`);
    return;
  }
  
  const config = getBackupConfig(instanceId);
  if (!config || !config.enabled) {
    return;
  }
  
  const backupTypes = config.backup_types.split(',').map(t => t.trim());
  
  for (const backupType of backupTypes) {
    const backupId = randomUUID();
    
    if (backupType === 'database') {
      const result = await backupDatabase(instance, backupId, 'Scheduled');
      if (result.success && result.filePath) {
        await uploadToDestination(result.filePath, instance.id);
      }
    } else if (backupType === 'volume') {
      const result = await backupVolume(instance, backupId, 'Scheduled');
      if (result.success && result.filePath) {
        await uploadToDestination(result.filePath, instance.id);
      }
    }
  }
  
  // Clean up old backups
  deleteOldBackups(instanceId, config.retention_days);
}

export async function backupAllInstances(): Promise<void> {
  const { getAllInstances } = await import('./db.js');
  const instances = getAllInstances();
  
  for (const instance of instances) {
    await performBackup(instance.id);
  }
}
