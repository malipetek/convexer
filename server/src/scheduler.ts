import cron from 'node-cron';
import { getAllBackupConfigs, getBackupSettings } from './db.js';
import { performBackup } from './backup.js';

const scheduledTasks = new Map<string, cron.ScheduledTask>();

export function initializeBackupScheduler(): void {
  console.log('Initializing backup scheduler...');
  
  // Schedule global backup if enabled
  const settings = getBackupSettings();
  if (settings && settings.enabled) {
    scheduleGlobalBackup(settings.default_schedule);
  }
  
  // Schedule per-instance backups
  const configs = getAllBackupConfigs();
  for (const config of configs) {
    if (config.enabled) {
      scheduleInstanceBackup(config.instance_id, config.schedule);
    }
  }
  
  console.log(`Backup scheduler initialized with ${scheduledTasks.size} tasks`);
}

export function scheduleGlobalBackup(cronExpression: string): void {
  const taskKey = 'global';
  
  // Remove existing task if it exists
  if (scheduledTasks.has(taskKey)) {
    scheduledTasks.get(taskKey)?.stop();
    scheduledTasks.delete(taskKey);
  }
  
  const task = cron.schedule(cronExpression, async () => {
    console.log('Running global backup...');
    try {
      const { backupAllInstances } = await import('./backup.js');
      await backupAllInstances();
      console.log('Global backup completed');
    } catch (err: any) {
      console.error('Global backup failed:', err.message);
    }
  }, {
    timezone: 'UTC'
  });
  
  scheduledTasks.set(taskKey, task);
  console.log(`Scheduled global backup: ${cronExpression}`);
}

export function scheduleInstanceBackup(instanceId: string, cronExpression: string): void {
  const taskKey = `instance-${instanceId}`;
  
  // Remove existing task if it exists
  if (scheduledTasks.has(taskKey)) {
    scheduledTasks.get(taskKey)?.stop();
    scheduledTasks.delete(taskKey);
  }
  
  const task = cron.schedule(cronExpression, async () => {
    console.log(`Running backup for instance ${instanceId}...`);
    try {
      await performBackup(instanceId);
      console.log(`Backup completed for instance ${instanceId}`);
    } catch (err: any) {
      console.error(`Backup failed for instance ${instanceId}:`, err.message);
    }
  }, {
    timezone: 'UTC'
  });
  
  scheduledTasks.set(taskKey, task);
  console.log(`Scheduled backup for instance ${instanceId}: ${cronExpression}`);
}

export function unscheduleInstanceBackup(instanceId: string): void {
  const taskKey = `instance-${instanceId}`;
  const task = scheduledTasks.get(taskKey);
  
  if (task) {
    task.stop();
    scheduledTasks.delete(taskKey);
    console.log(`Unscheduled backup for instance ${instanceId}`);
  }
}

export function unscheduleGlobalBackup(): void {
  const taskKey = 'global';
  const task = scheduledTasks.get(taskKey);
  
  if (task) {
    task.stop();
    scheduledTasks.delete(taskKey);
    console.log('Unscheduled global backup');
  }
}

export function refreshBackupScheduler(): void {
  // Stop all tasks
  for (const task of scheduledTasks.values()) {
    task.stop();
  }
  scheduledTasks.clear();
  
  // Reinitialize
  initializeBackupScheduler();
}
