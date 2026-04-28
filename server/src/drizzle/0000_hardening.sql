CREATE TABLE IF NOT EXISTS update_jobs (
  id TEXT PRIMARY KEY,
  target_version TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'image',
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER NOT NULL DEFAULT 0,
  logs TEXT,
  health_result TEXT,
  rollback_ref TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS action_audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor TEXT,
  target TEXT,
  status TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
