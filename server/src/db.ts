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
    backend_port INTEGER NOT NULL,
    site_proxy_port INTEGER NOT NULL,
    dashboard_port INTEGER NOT NULL,
    volume_name TEXT NOT NULL,
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

export function getAllInstances(): Instance[] {
  return db.prepare('SELECT * FROM instances ORDER BY created_at DESC').all() as Instance[];
}

export function getInstance(id: string): Instance | undefined {
  return db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Instance | undefined;
}

export function createInstance(instance: Omit<Instance, 'created_at' | 'updated_at' | 'admin_key' | 'error_message' | 'backend_container_id' | 'dashboard_container_id'>): Instance {
  const stmt = db.prepare(`
    INSERT INTO instances (id, name, status, backend_port, site_proxy_port, dashboard_port, volume_name, instance_name, instance_secret, extra_env)
    VALUES (@id, @name, @status, @backend_port, @site_proxy_port, @dashboard_port, @volume_name, @instance_name, @instance_secret, @extra_env)
  `);
  stmt.run(instance);
  return getInstance(instance.id)!;
}

export function updateInstance(id: string, updates: Partial<Instance>): Instance | undefined {
  const allowed = [
    'status', 'backend_container_id', 'dashboard_container_id',
    'admin_key', 'error_message', 'extra_env'
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

export function allocatePorts(): { backendPort: number; siteProxyPort: number; dashboardPort: number } {
  const instances = db.prepare('SELECT backend_port, dashboard_port FROM instances ORDER BY backend_port ASC').all() as Pick<Instance, 'backend_port' | 'dashboard_port'>[];

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

  return {
    backendPort,
    siteProxyPort: backendPort + 1,
    dashboardPort,
  };
}

export default db;
