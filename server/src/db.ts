import Database from 'better-sqlite3';
import path from 'path';
import { Instance } from './types.js';

const DB_PATH = path.join(process.env.DATA_DIR || process.cwd(), 'convexer.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'creating',
    backend_container_id TEXT,
    dashboard_container_id TEXT,
    postgres_container_id TEXT,
    backend_port INTEGER NOT NULL,
    site_proxy_port INTEGER NOT NULL,
    dashboard_port INTEGER NOT NULL,
    postgres_port INTEGER NOT NULL,
    volume_name TEXT NOT NULL,
    postgres_volume_name TEXT NOT NULL,
    postgres_password TEXT NOT NULL,
    admin_key TEXT,
    instance_name TEXT NOT NULL,
    instance_secret TEXT NOT NULL,
    error_message TEXT,
    extra_env TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: add extra_env column if it doesn't exist
try {
  db.exec('ALTER TABLE instances ADD COLUMN extra_env TEXT');
} catch (err: any) {
  if (err.message.includes('duplicate column')) {
    // Column already exists, that's fine
  } else {
    console.warn('Failed to add extra_env column:', err.message);
  }
}

// Migration: add PostgreSQL columns if they don't exist
const postgresColumns = [
  'postgres_container_id TEXT',
  'postgres_port INTEGER NOT NULL DEFAULT 5432',
  'postgres_volume_name TEXT NOT NULL DEFAULT ""',
  'postgres_password TEXT NOT NULL DEFAULT ""'
];

for (const columnDef of postgresColumns) {
  const columnName = columnDef.split(' ')[0];
  try {
    db.exec(`ALTER TABLE instances ADD COLUMN ${columnDef}`);
  } catch (err: any) {
    if (err.message.includes('duplicate column')) {
      // Column already exists, that's fine
    } else {
      console.warn(`Failed to add ${columnName} column:`, err.message);
    }
  }
}

// Backup configuration table
db.exec(`
  CREATE TABLE IF NOT EXISTS backup_configs (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    schedule TEXT NOT NULL DEFAULT '0 2 * * 0',
    retention_days INTEGER NOT NULL DEFAULT 30,
    backup_types TEXT NOT NULL DEFAULT 'database,volume',
    local_path TEXT,
    destination_type TEXT NOT NULL DEFAULT 'local',
    remote_subfolder TEXT,
    rsync_target TEXT,
    koofr_email TEXT,
    koofr_password TEXT,
    webdav_url TEXT,
    webdav_user TEXT,
    webdav_password TEXT,
    s3_bucket TEXT,
    s3_region TEXT,
    s3_access_key TEXT,
    s3_secret_key TEXT,
    s3_endpoint TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
  )
`);

// Migrations: add new columns if missing
const backupCols = db.prepare(`PRAGMA table_info(backup_configs)`).all() as any[];
const colNames = backupCols.map(c => c.name);
const migrations: Array<[string, string]> = [
  ['destination_type', `ALTER TABLE backup_configs ADD COLUMN destination_type TEXT NOT NULL DEFAULT 'local'`],
  ['remote_subfolder', `ALTER TABLE backup_configs ADD COLUMN remote_subfolder TEXT`],
  ['koofr_email', `ALTER TABLE backup_configs ADD COLUMN koofr_email TEXT`],
  ['koofr_password', `ALTER TABLE backup_configs ADD COLUMN koofr_password TEXT`],
  ['webdav_url', `ALTER TABLE backup_configs ADD COLUMN webdav_url TEXT`],
  ['webdav_user', `ALTER TABLE backup_configs ADD COLUMN webdav_user TEXT`],
  ['webdav_password', `ALTER TABLE backup_configs ADD COLUMN webdav_password TEXT`],
];
for (const [col, sql] of migrations) {
  if (!colNames.includes(col)) {
    try { db.exec(sql); } catch (e) { console.error('Migration failed:', col, e); }
  }
}

// Backup history table
db.exec(`
  CREATE TABLE IF NOT EXISTS backup_history (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    backup_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    size_bytes INTEGER,
    file_path TEXT,
    storage_type TEXT NOT NULL DEFAULT 'local',
    error_message TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
  )
`);

// Add label column to backup_history if it doesn't exist (migration)
try {
  const histCols = (db.prepare("PRAGMA table_info(backup_history)").all() as any[]).map((c: any) => c.name);
  if (!histCols.includes('label')) {
    db.exec('ALTER TABLE backup_history ADD COLUMN label TEXT');
  }
  if (!histCols.includes('restored_at')) {
    db.exec('ALTER TABLE backup_history ADD COLUMN restored_at TEXT');
  }
  if (!histCols.includes('pre_restore_snapshot_id')) {
    db.exec('ALTER TABLE backup_history ADD COLUMN pre_restore_snapshot_id TEXT');
  }
} catch (e) { console.error('Migration failed: backup_history columns', e); }

// Backup sync status table (tracks upload status per provider per backup)
db.exec(`
  CREATE TABLE IF NOT EXISTS backup_sync_status (
    id TEXT PRIMARY KEY,
    backup_history_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    synced_at TEXT,
    FOREIGN KEY (backup_history_id) REFERENCES backup_history(id) ON DELETE CASCADE
  )
`);

// Backup destinations table (multiple remote targets per instance)
db.exec(`
  CREATE TABLE IF NOT EXISTS backup_destinations (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    destination_type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    remote_subfolder TEXT,
    rsync_target TEXT,
    koofr_email TEXT,
    koofr_password TEXT,
    webdav_url TEXT,
    webdav_user TEXT,
    webdav_password TEXT,
    s3_bucket TEXT,
    s3_region TEXT,
    s3_access_key TEXT,
    s3_secret_key TEXT,
    s3_endpoint TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
  )
`);

// Migration: move existing destination data from backup_config to backup_destinations
try {
  const destCols = (db.prepare("PRAGMA table_info(backup_destinations)").all() as any[]).map((c: any) => c.name);
  if (destCols.length > 0) {
    const configs = db.prepare("SELECT id, instance_id, destination_type, remote_subfolder, rsync_target, koofr_email, koofr_password, webdav_url, webdav_user, webdav_password, s3_bucket, s3_region, s3_access_key, s3_secret_key, s3_endpoint FROM backup_configs WHERE destination_type IS NOT NULL AND destination_type != 'local'").all() as any[];
    for (const config of configs) {
      const existing = db.prepare('SELECT id FROM backup_destinations WHERE instance_id = ? AND destination_type = ?').get(config.instance_id, config.destination_type);
      if (!existing) {
        const destId = config.id + '-dest';
        db.prepare(`
          INSERT INTO backup_destinations (id, instance_id, destination_type, enabled, remote_subfolder, rsync_target, koofr_email, koofr_password, webdav_url, webdav_user, webdav_password, s3_bucket, s3_region, s3_access_key, s3_secret_key, s3_endpoint)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(destId, config.instance_id, config.destination_type, config.remote_subfolder, config.rsync_target, config.koofr_email, config.koofr_password, config.webdav_url, config.webdav_user, config.webdav_password, config.s3_bucket, config.s3_region, config.s3_access_key, config.s3_secret_key, config.s3_endpoint);
      }
    }
  }
} catch (e) { console.error('Migration failed: backup_destinations', e); }

// Global backup settings table
db.exec(`
  CREATE TABLE IF NOT EXISTS backup_settings (
    id TEXT PRIMARY KEY DEFAULT 'global',
    enabled INTEGER NOT NULL DEFAULT 0,
    default_schedule TEXT NOT NULL DEFAULT '0 2 * * 0',
    default_retention_days INTEGER NOT NULL DEFAULT 30,
    default_local_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Sessions table for authentication
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export function getAllInstances(): Instance[] {
  return db.prepare('SELECT * FROM instances ORDER BY created_at DESC').all() as Instance[];
}

export function getInstance(id: string): Instance | undefined {
  return db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Instance | undefined;
}

export function createInstance (instance: Omit<Instance, 'created_at' | 'updated_at' | 'admin_key' | 'error_message' | 'backend_container_id' | 'dashboard_container_id' | 'postgres_container_id'>): Instance
{
  const stmt = db.prepare(`
    INSERT INTO instances (id, name, status, backend_port, site_proxy_port, dashboard_port, postgres_port, volume_name, postgres_volume_name, postgres_password, instance_name, instance_secret, extra_env)
    VALUES (@id, @name, @status, @backend_port, @site_proxy_port, @dashboard_port, @postgres_port, @volume_name, @postgres_volume_name, @postgres_password, @instance_name, @instance_secret, @extra_env)
  `);
  stmt.run(instance);
  return getInstance(instance.id)!;
}

export function updateInstance(id: string, updates: Partial<Instance>): Instance | undefined {
  const allowed = [
    'status', 'backend_container_id', 'dashboard_container_id', 'postgres_container_id',
    'admin_key', 'error_message', 'extra_env', 'postgres_password'
  ];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return getInstance(id);

  const sets = fields.map(f => `${f} = @${f}`).join(', ');
  const stmt = db.prepare(`UPDATE instances SET ${sets}, updated_at = datetime('now') WHERE id = @id`);
  stmt.run({ id, ...updates });
  return getInstance(id);
}

export function deleteInstance(id: string): boolean {
  const result = db.prepare('DELETE FROM instances WHERE id = ?').run(id);
  return result.changes > 0;
}

export function allocatePorts (): { backendPort: number; siteProxyPort: number; dashboardPort: number; postgresPort: number }
{
  const instances = db.prepare('SELECT backend_port, dashboard_port, postgres_port FROM instances ORDER BY backend_port ASC').all() as Pick<Instance, 'backend_port' | 'dashboard_port' | 'postgres_port'>[];

  let backendPort = 3220;
  for (const inst of instances) {
    if (inst.backend_port === backendPort) {
      backendPort += 10;
    }
  }

  const dashboardInstances = db.prepare('SELECT dashboard_port FROM instances ORDER BY dashboard_port ASC').all() as Pick<Instance, 'dashboard_port'>[];
  let dashboardPort = 6800;
  for (const inst of dashboardInstances) {
    if (inst.dashboard_port === dashboardPort) {
      dashboardPort += 1;
    }
  }

  const postgresInstances = db.prepare('SELECT postgres_port FROM instances ORDER BY postgres_port ASC').all() as Pick<Instance, 'postgres_port'>[];
  let postgresPort = 5432;
  for (const inst of postgresInstances) {
    if (inst.postgres_port === postgresPort) {
      postgresPort += 1;
    }
  }

  return {
    backendPort,
    siteProxyPort: backendPort + 1,
    dashboardPort,
    postgresPort,
  };
}

export default db;

// Backup configuration functions
export interface BackupConfig
{
  id: string;
  instance_id: string;
  enabled: number;
  schedule: string;
  retention_days: number;
  backup_types: string;
  local_path?: string;
  destination_type: string;
  remote_subfolder?: string;
  rsync_target?: string;
  koofr_email?: string;
  koofr_password?: string;
  webdav_url?: string;
  webdav_user?: string;
  webdav_password?: string;
  s3_bucket?: string;
  s3_region?: string;
  s3_access_key?: string;
  s3_secret_key?: string;
  s3_endpoint?: string;
  created_at: string;
  updated_at: string;
}

export interface BackupDestination
{
  id: string;
  instance_id: string;
  destination_type: string;
  enabled: number;
  remote_subfolder?: string;
  rsync_target?: string;
  koofr_email?: string;
  koofr_password?: string;
  webdav_url?: string;
  webdav_user?: string;
  webdav_password?: string;
  s3_bucket?: string;
  s3_region?: string;
  s3_access_key?: string;
  s3_secret_key?: string;
  s3_endpoint?: string;
  created_at: string;
  updated_at: string;
}

export interface BackupSyncStatus
{
  id: string;
  backup_history_id: string;
  provider: string;
  status: string;
  error_message?: string;
  synced_at?: string;
}

export interface BackupHistory
{
  id: string;
  instance_id: string;
  backup_type: string;
  status: string;
  size_bytes?: number;
  file_path?: string;
  storage_type: string;
  label?: string;
  restored_at?: string;
  pre_restore_snapshot_id?: string;
  error_message?: string;
  started_at: string;
  completed_at?: string;
}

export interface BackupSettings
{
  id: string;
  enabled: number;
  default_schedule: string;
  default_retention_days: number;
  default_local_path?: string;
  created_at: string;
  updated_at: string;
}

export function getBackupConfig (instanceId: string): BackupConfig | undefined
{
  return db.prepare('SELECT * FROM backup_configs WHERE instance_id = ?').get(instanceId) as BackupConfig | undefined;
}

export function createBackupConfig (config: Partial<BackupConfig> & { id: string; instance_id: string }): BackupConfig
{
  const stmt = db.prepare(`
    INSERT INTO backup_configs (id, instance_id, enabled, schedule, retention_days, backup_types, local_path, destination_type, remote_subfolder, rsync_target, koofr_email, koofr_password, webdav_url, webdav_user, webdav_password, s3_bucket, s3_region, s3_access_key, s3_secret_key, s3_endpoint)
    VALUES (@id, @instance_id, @enabled, @schedule, @retention_days, @backup_types, @local_path, @destination_type, @remote_subfolder, @rsync_target, @koofr_email, @koofr_password, @webdav_url, @webdav_user, @webdav_password, @s3_bucket, @s3_region, @s3_access_key, @s3_secret_key, @s3_endpoint)
  `);
  stmt.run({
    id: config.id,
    instance_id: config.instance_id,
    enabled: config.enabled ?? 1,
    schedule: config.schedule ?? '0 2 * * 0',
    retention_days: config.retention_days ?? 30,
    backup_types: config.backup_types ?? 'database,volume',
    local_path: config.local_path ?? null,
    destination_type: config.destination_type ?? 'local',
    remote_subfolder: config.remote_subfolder ?? null,
    rsync_target: config.rsync_target ?? null,
    koofr_email: config.koofr_email ?? null,
    koofr_password: config.koofr_password ?? null,
    webdav_url: config.webdav_url ?? null,
    webdav_user: config.webdav_user ?? null,
    webdav_password: config.webdav_password ?? null,
    s3_bucket: config.s3_bucket ?? null,
    s3_region: config.s3_region ?? null,
    s3_access_key: config.s3_access_key ?? null,
    s3_secret_key: config.s3_secret_key ?? null,
    s3_endpoint: config.s3_endpoint ?? null,
  });
  return getBackupConfig(config.instance_id)!;
}

export function updateBackupConfig (instanceId: string, updates: Partial<BackupConfig>): BackupConfig | undefined
{
  const allowed = ['enabled', 'schedule', 'retention_days', 'backup_types', 'local_path', 'destination_type', 'remote_subfolder', 'rsync_target', 'koofr_email', 'koofr_password', 'webdav_url', 'webdav_user', 'webdav_password', 's3_bucket', 's3_region', 's3_access_key', 's3_secret_key', 's3_endpoint'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return getBackupConfig(instanceId);

  const sets = fields.map(f => `${f} = @${f}`).join(', ');
  const stmt = db.prepare(`UPDATE backup_configs SET ${sets}, updated_at = datetime('now') WHERE instance_id = @instance_id`);
  stmt.run({ instance_id: instanceId, ...updates });
  return getBackupConfig(instanceId);
}

export function deleteBackupConfig (instanceId: string): boolean
{
  const result = db.prepare('DELETE FROM backup_configs WHERE instance_id = ?').run(instanceId);
  return result.changes > 0;
}

export function getAllBackupConfigs (): BackupConfig[]
{
  return db.prepare('SELECT * FROM backup_configs').all() as BackupConfig[];
}

export function getBackupHistory (instanceId: string, limit = 50): BackupHistory[]
{
  return db.prepare('SELECT * FROM backup_history WHERE instance_id = ? ORDER BY started_at DESC LIMIT ?').all(instanceId, limit) as BackupHistory[];
}

export function getBackupHistoryById (id: string): BackupHistory | undefined
{
  return db.prepare('SELECT * FROM backup_history WHERE id = ?').get(id) as BackupHistory | undefined;
}

export function createBackupHistory (history: Partial<BackupHistory> & { id: string; instance_id: string; backup_type: string }): BackupHistory
{
  const stmt = db.prepare(`
    INSERT INTO backup_history (id, instance_id, backup_type, status, size_bytes, file_path, storage_type, label, restored_at, pre_restore_snapshot_id, error_message, completed_at)
    VALUES (@id, @instance_id, @backup_type, @status, @size_bytes, @file_path, @storage_type, @label, @restored_at, @pre_restore_snapshot_id, @error_message, @completed_at)
  `);
  stmt.run({
    id: history.id,
    instance_id: history.instance_id,
    backup_type: history.backup_type,
    status: history.status ?? 'pending',
    size_bytes: history.size_bytes ?? null,
    file_path: history.file_path ?? null,
    storage_type: history.storage_type ?? 'local',
    label: history.label ?? null,
    restored_at: history.restored_at ?? null,
    pre_restore_snapshot_id: history.pre_restore_snapshot_id ?? null,
    error_message: history.error_message ?? null,
    completed_at: history.completed_at ?? null,
  });
  return db.prepare('SELECT * FROM backup_history WHERE id = ?').get(history.id) as BackupHistory;
}

export function updateBackupHistory (id: string, updates: Partial<BackupHistory>): BackupHistory | undefined
{
  const allowed = ['status', 'size_bytes', 'file_path', 'storage_type', 'label', 'restored_at', 'pre_restore_snapshot_id', 'error_message', 'completed_at'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return db.prepare('SELECT * FROM backup_history WHERE id = ?').get(id) as BackupHistory | undefined;

  const sets = fields.map(f => `${f} = @${f}`).join(', ');
  const stmt = db.prepare(`UPDATE backup_history SET ${sets} WHERE id = @id`);
  stmt.run({ id, ...updates });
  return db.prepare('SELECT * FROM backup_history WHERE id = ?').get(id) as BackupHistory | undefined;
}

export function deleteOldBackups (instanceId: string, retentionDays: number): number
{
  const stmt = db.prepare(`
    DELETE FROM backup_history
    WHERE instance_id = ? AND started_at < datetime('now', '-' || ? || ' days')
  `);
  const result = stmt.run(instanceId, retentionDays);
  return result.changes;
}

// Sync status functions
export function getBackupSyncStatus (backupHistoryId: string): BackupSyncStatus[]
{
  return db.prepare('SELECT * FROM backup_sync_status WHERE backup_history_id = ?').all(backupHistoryId) as BackupSyncStatus[];
}

export function createBackupSyncStatus (status: Partial<BackupSyncStatus> & { id: string; backup_history_id: string; provider: string }): BackupSyncStatus
{
  const stmt = db.prepare(`
    INSERT INTO backup_sync_status (id, backup_history_id, provider, status, error_message, synced_at)
    VALUES (@id, @backup_history_id, @provider, @status, @error_message, @synced_at)
  `);
  stmt.run({
    id: status.id,
    backup_history_id: status.backup_history_id,
    provider: status.provider,
    status: status.status ?? 'pending',
    error_message: status.error_message ?? null,
    synced_at: status.synced_at ?? null,
  });
  return db.prepare('SELECT * FROM backup_sync_status WHERE id = ?').get(status.id) as BackupSyncStatus;
}

export function updateBackupSyncStatus (id: string, updates: Partial<BackupSyncStatus>): BackupSyncStatus | undefined
{
  const allowed = ['status', 'error_message', 'synced_at'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return db.prepare('SELECT * FROM backup_sync_status WHERE id = ?').get(id) as BackupSyncStatus | undefined;

  const sets = fields.map(f => `${f} = @${f}`).join(', ');
  const stmt = db.prepare(`UPDATE backup_sync_status SET ${sets} WHERE id = @id`);
  stmt.run({ id, ...updates });
  return db.prepare('SELECT * FROM backup_sync_status WHERE id = ?').get(id) as BackupSyncStatus | undefined;
}

export function getBackupSettings (): BackupSettings | undefined
{
  return db.prepare('SELECT * FROM backup_settings WHERE id = ?').get('global') as BackupSettings | undefined;
}

export function updateBackupSettings (settings: Partial<BackupSettings>): BackupSettings
{
  const existing = getBackupSettings();
  const stmt = db.prepare(`
    INSERT INTO backup_settings (id, enabled, default_schedule, default_retention_days, default_local_path)
    VALUES ('global', @enabled, @default_schedule, @default_retention_days, @default_local_path)
    ON CONFLICT(id) DO UPDATE SET
      enabled = coalesce(@enabled, enabled),
      default_schedule = coalesce(@default_schedule, default_schedule),
      default_retention_days = coalesce(@default_retention_days, default_retention_days),
      default_local_path = coalesce(@default_local_path, default_local_path),
      updated_at = datetime('now')
  `);
  stmt.run({ ...settings, id: 'global' });
  return getBackupSettings()!;
}

// Backup destinations functions
export function getBackupDestinations (instanceId: string): BackupDestination[]
{
  return db.prepare('SELECT * FROM backup_destinations WHERE instance_id = ? ORDER BY created_at DESC').all(instanceId) as BackupDestination[];
}

export function getBackupDestination (id: string): BackupDestination | undefined
{
  return db.prepare('SELECT * FROM backup_destinations WHERE id = ?').get(id) as BackupDestination | undefined;
}

export function createBackupDestination (destination: Partial<BackupDestination> & { id: string; instance_id: string; destination_type: string }): BackupDestination
{
  const stmt = db.prepare(`
    INSERT INTO backup_destinations (id, instance_id, destination_type, enabled, remote_subfolder, rsync_target, koofr_email, koofr_password, webdav_url, webdav_user, webdav_password, s3_bucket, s3_region, s3_access_key, s3_secret_key, s3_endpoint)
    VALUES (@id, @instance_id, @destination_type, @enabled, @remote_subfolder, @rsync_target, @koofr_email, @koofr_password, @webdav_url, @webdav_user, @webdav_password, @s3_bucket, @s3_region, @s3_access_key, @s3_secret_key, @s3_endpoint)
  `);
  stmt.run({
    id: destination.id,
    instance_id: destination.instance_id,
    destination_type: destination.destination_type,
    enabled: destination.enabled ?? 1,
    remote_subfolder: destination.remote_subfolder ?? null,
    rsync_target: destination.rsync_target ?? null,
    koofr_email: destination.koofr_email ?? null,
    koofr_password: destination.koofr_password ?? null,
    webdav_url: destination.webdav_url ?? null,
    webdav_user: destination.webdav_user ?? null,
    webdav_password: destination.webdav_password ?? null,
    s3_bucket: destination.s3_bucket ?? null,
    s3_region: destination.s3_region ?? null,
    s3_access_key: destination.s3_access_key ?? null,
    s3_secret_key: destination.s3_secret_key ?? null,
    s3_endpoint: destination.s3_endpoint ?? null,
  });
  return db.prepare('SELECT * FROM backup_destinations WHERE id = ?').get(destination.id) as BackupDestination;
}

export function updateBackupDestination (id: string, updates: Partial<BackupDestination>): BackupDestination | undefined
{
  const allowed = ['enabled', 'remote_subfolder', 'rsync_target', 'koofr_email', 'koofr_password', 'webdav_url', 'webdav_user', 'webdav_password', 's3_bucket', 's3_region', 's3_access_key', 's3_secret_key', 's3_endpoint'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return db.prepare('SELECT * FROM backup_destinations WHERE id = ?').get(id) as BackupDestination | undefined;

  const sets = fields.map(f => `${f} = @${f}`).join(', ');
  const stmt = db.prepare(`UPDATE backup_destinations SET ${sets}, updated_at = datetime('now') WHERE id = @id`);
  stmt.run({ id, ...updates });
  return db.prepare('SELECT * FROM backup_destinations WHERE id = ?').get(id) as BackupDestination | undefined;
}

export function deleteBackupDestination (id: string): boolean
{
  const result = db.prepare('DELETE FROM backup_destinations WHERE id = ?').run(id);
  return result.changes > 0;
}
