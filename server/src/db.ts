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
    rsync_target TEXT,
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
  rsync_target?: string;
  s3_bucket?: string;
  s3_region?: string;
  s3_access_key?: string;
  s3_secret_key?: string;
  s3_endpoint?: string;
  created_at: string;
  updated_at: string;
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

export function createBackupConfig (config: Omit<BackupConfig, 'created_at' | 'updated_at'>): BackupConfig
{
  const stmt = db.prepare(`
    INSERT INTO backup_configs (id, instance_id, enabled, schedule, retention_days, backup_types, local_path, rsync_target, s3_bucket, s3_region, s3_access_key, s3_secret_key, s3_endpoint)
    VALUES (@id, @instance_id, @enabled, @schedule, @retention_days, @backup_types, @local_path, @rsync_target, @s3_bucket, @s3_region, @s3_access_key, @s3_secret_key, @s3_endpoint)
  `);
  stmt.run(config);
  return getBackupConfig(config.instance_id)!;
}

export function updateBackupConfig (instanceId: string, updates: Partial<BackupConfig>): BackupConfig | undefined
{
  const allowed = ['enabled', 'schedule', 'retention_days', 'backup_types', 'local_path', 'rsync_target', 's3_bucket', 's3_region', 's3_access_key', 's3_secret_key', 's3_endpoint'];
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

export function createBackupHistory (history: Omit<BackupHistory, 'started_at'>): BackupHistory
{
  const stmt = db.prepare(`
    INSERT INTO backup_history (id, instance_id, backup_type, status, size_bytes, file_path, storage_type, error_message, completed_at)
    VALUES (@id, @instance_id, @backup_type, @status, @size_bytes, @file_path, @storage_type, @error_message, @completed_at)
  `);
  stmt.run(history);
  return db.prepare('SELECT * FROM backup_history WHERE id = ?').get(history.id) as BackupHistory;
}

export function updateBackupHistory (id: string, updates: Partial<BackupHistory>): BackupHistory | undefined
{
  const allowed = ['status', 'size_bytes', 'file_path', 'storage_type', 'error_message', 'completed_at'];
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
