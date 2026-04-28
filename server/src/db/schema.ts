import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const instances = sqliteTable('instances', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  extra_env: text('extra_env'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

export const updateJobs = sqliteTable('update_jobs', {
  id: text('id').primaryKey(),
  target_version: text('target_version').notNull(),
  strategy: text('strategy').notNull(),
  status: text('status').notNull(),
  progress: integer('progress').notNull(),
  logs: text('logs'),
  health_result: text('health_result'),
  rollback_ref: text('rollback_ref'),
  error_message: text('error_message'),
  created_at: text('created_at').notNull(),
  started_at: text('started_at'),
  completed_at: text('completed_at'),
});

export const actionAuditLogs = sqliteTable('action_audit_logs', {
  id: text('id').primaryKey(),
  action: text('action').notNull(),
  actor: text('actor'),
  target: text('target'),
  status: text('status').notNull(),
  details: text('details'),
  created_at: text('created_at').notNull(),
});
