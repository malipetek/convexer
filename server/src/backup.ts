import Docker from 'dockerode';
import { exec } from 'child_process';
import { promisify } from 'util';
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
    const volume = docker.getVolume(instance.volume_name);
    const info = await volume.inspect();
    
    if (!info.Mountpoint) {
      throw new Error('Volume mountpoint not found');
    }
    
    // Create backup directory
    const backupDir = path.join(process.env.DATA_DIR || process.cwd(), 'backups', instance.id);
    await fs.mkdir(backupDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(backupDir, `${instance.name}-volume-${timestamp}.tar.gz`);
    
    // Create tar.gz of the volume
    await execAsync(`tar -czf "${filePath}" -C "${info.Mountpoint}" .`);
    
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
      if (result.success && result.filePath && config.rsync_target) {
        await rsyncBackup(result.filePath, config.rsync_target);
      }
    } else if (backupType === 'volume') {
      const result = await backupVolume(instance, backupId);
      if (result.success && result.filePath && config.rsync_target) {
        await rsyncBackup(result.filePath, config.rsync_target);
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
