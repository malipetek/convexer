import Docker from 'dockerode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PassThrough } from 'stream';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { Instance } from './types.js';
import { getInstance, getBackupConfig, createBackupHistory, updateBackupHistory, deleteOldBackups, BackupConfig } from './db.js';

const execAsync = promisify(exec);
const docker = new Docker();

export async function backupDatabase(instance: Instance, backupId: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
  const history = createBackupHistory({
    id: backupId,
    instance_id: instance.id,
    backup_type: 'database',
    status: 'running',
    storage_type: 'local',
  });

  try {
    const container = docker.getContainer(`convexer-postgres-${instance.name}`);
    
    const exec = await container.exec({
      Cmd: ['pg_dump', '-U', 'postgres', instance.instance_name],
      AttachStdout: true,
      AttachStderr: true,
    });
    
    const stream = await exec.start({ Detach: false, Tty: false });
    let sql = '';
    
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Uint8Array) => {
        sql += Buffer.from(chunk).toString('utf-8');
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    
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

export async function backupVolume(instance: Instance, backupId: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
  const history = createBackupHistory({
    id: backupId,
    instance_id: instance.id,
    backup_type: 'volume',
    status: 'running',
    storage_type: 'local',
  });

  try {
    // Create backup directory
    const backupDir = path.join(process.env.DATA_DIR || process.cwd(), 'backups', instance.id);
    await fs.mkdir(backupDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(backupDir, `${instance.name}-volume-${timestamp}.tar.gz`);
    
    // Use Dockerode (via /var/run/docker.sock) to run an alpine container and capture tar output.
    // The convexer container has no docker CLI, so execAsync('docker run...') fails.
    const container = await docker.createContainer({
      Image: 'alpine',
      Cmd: ['tar', '-czf', '-', '-C', '/data', '.'],
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: [`${instance.volume_name}:/data:ro`],
      },
    });

    try {
      const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
      await container.start();

      const chunks: Uint8Array[] = [];
      await new Promise<void>((resolve, reject) =>
      {
        const stdoutPass = new PassThrough();
        (docker.modem as any).demuxStream(attachStream, stdoutPass, new PassThrough());
        stdoutPass.on('data', (chunk: Uint8Array) => chunks.push(chunk));
        stdoutPass.on('end', resolve);
        attachStream.on('error', reject);
      });

      await fs.writeFile(filePath, Buffer.concat(chunks) as any);
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

async function uploadToDestination (filePath: string, config: BackupConfig): Promise<void>
{
  const destType = config.destination_type || 'local';
  const subfolder = config.remote_subfolder;

  if (destType === 'local') return;

  if (destType === 'rsync' && config.rsync_target) {
    const target = subfolder ? `${config.rsync_target.replace(/\/$/, '')}/${subfolder.replace(/^\/+|\/+$/g, '')}` : config.rsync_target;
    const result = await rsyncBackup(filePath, target);
    if (!result.success) console.error('Rsync failed:', result.error);
    return;
  }

  if (destType === 'koofr' && config.koofr_email && config.koofr_password) {
    const result = await koofrBackup(filePath, config.koofr_email, config.koofr_password, subfolder);
    if (!result.success) console.error('Koofr upload failed:', result.error);
    return;
  }

  if (destType === 'webdav' && config.webdav_url && config.webdav_user && config.webdav_password) {
    const result = await webdavBackup(filePath, config.webdav_url, config.webdav_user, config.webdav_password, subfolder);
    if (!result.success) console.error('WebDAV upload failed:', result.error);
    return;
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
      const result = await backupDatabase(instance, backupId);
      if (result.success && result.filePath) {
        await uploadToDestination(result.filePath, config);
      }
    } else if (backupType === 'volume') {
      const result = await backupVolume(instance, backupId);
      if (result.success && result.filePath) {
        await uploadToDestination(result.filePath, config);
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
