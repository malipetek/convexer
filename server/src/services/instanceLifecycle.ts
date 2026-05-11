import crypto, { randomUUID } from 'crypto';
import path from 'path';
import { promises as fsPromises } from 'fs';
import { Instance } from '../types.js';
import {
  allocatePorts,
  archiveInstance,
  createInstance,
  createOperation,
  deleteInstance,
  getBackupHistory,
  getInstance,
  getInstanceByName,
  restoreArchivedInstance,
  updateInstance,
  updateOperation,
} from '../db.js';
import { backupDatabase, backupVolume } from '../backup.js';
import { createAndStartInstance, removeInstance, startInstance, stopInstance } from '../docker.js';
import { removeTunnelRoutes } from '../tunnel.js';
import { AppError, asError } from '../http.js';
import { toExtraEnvJson } from '../validation.js';
import { runAppEffect, tryPromiseApp, withTransientRetry } from '../effectRuntime.js';

type CreateInstanceInput = {
  name?: string;
  extra_env?: Record<string, string>;
};

type ArchiveDeleteResult = {
  archived: true;
  warnings?: string[];
  backups: Record<string, unknown>;
};

type RestoreArchivedResult = {
  instance: Instance;
  renamed?: string;
};

function getExistingInstance (id: string): Instance
{
  const instance = getInstance(id);
  if (!instance) throw new AppError(404, 'INSTANCE_NOT_FOUND', 'Instance not found');
  return instance;
}

function getArchivedInstance (id: string): Instance
{
  const instance = getInstance(id);
  if (!instance || !instance.archived_at) {
    throw new AppError(404, 'ARCHIVED_INSTANCE_NOT_FOUND', 'Archived instance not found');
  }
  return instance;
}

function finishOperation (operationId: string, status: 'success' | 'failed', message: string, errorMessage?: string)
{
  updateOperation(operationId, {
    status,
    message,
    error_message: errorMessage ?? null,
    completed_at: new Date().toISOString(),
  });
}

function recordOperationStep (operationId: string, step: string, message: string)
{
  updateOperation(operationId, {
    status: 'running',
    message,
    metadata_json: JSON.stringify({
      step,
      updated_at: new Date().toISOString(),
    }),
  });
}

function operationStepRecorder (operationId: string)
{
  return (step: string, message: string) => recordOperationStep(operationId, step, message);
}

function createLifecycleOperation (type: string, instance: Instance, message: string)
{
  return createOperation({
    id: randomUUID(),
    type,
    target_type: 'instance',
    target_id: instance.id,
    status: 'running',
    message,
    started_at: new Date().toISOString(),
  });
}

function generateConflictName (): string
{
  const adjectives = ['swift', 'calm', 'bright', 'eager', 'gentle', 'happy', 'kind', 'lively', 'proud', 'wise'];
  const nouns = ['bear', 'fox', 'hawk', 'lion', 'owl', 'tiger', 'wolf', 'eagle', 'deer', 'rabbit'];
  const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
  const randomSuffix = Math.floor(Math.random() * 1000);
  return `${randomAdj}-${randomNoun}-${randomSuffix}`;
}

function startCreatedInstanceInBackground (instance: Instance, operationId: string): void
{
  createAndStartInstance(instance, undefined, operationStepRecorder(operationId)).then(() => {
    const current = getInstance(instance.id);
    if (current?.status === 'running') {
      finishOperation(operationId, 'success', `Instance ${instance.name} is running`);
    } else {
      finishOperation(operationId, 'failed', `Instance ${instance.name} failed to start`, current?.error_message || 'Unknown creation failure');
    }
  }).catch(error => {
    const appError = asError(error);
    console.error(`Background creation failed for ${instance.name}:`, appError.message);
    updateInstance(instance.id, { status: 'error', error_message: appError.message });
    finishOperation(operationId, 'failed', `Instance ${instance.name} failed to start`, appError.message);
  });
}

export function createInstanceLifecycle (input: CreateInstanceInput): Instance
{
  const instanceName = input.name || `instance-${Date.now()}`;
  const ports = allocatePorts();

  const domain = process.env.DOMAIN || '';
  const finalExtraEnv = { ...(input.extra_env || {}) };
  if (!finalExtraEnv.BACKEND_DOMAIN) {
    finalExtraEnv.BACKEND_DOMAIN = domain ? `${instanceName}.${domain}` : instanceName;
  }
  if (!finalExtraEnv.SITE_DOMAIN) {
    finalExtraEnv.SITE_DOMAIN = domain ? `${instanceName}-site.${domain}` : `${instanceName}-site`;
  }
  if (!finalExtraEnv.DASHBOARD_DOMAIN) {
    finalExtraEnv.DASHBOARD_DOMAIN = domain ? `${instanceName}-dash.${domain}` : `${instanceName}-dash`;
  }

  const instance = createInstance({
    id: randomUUID(),
    name: instanceName,
    status: 'creating',
    backend_port: ports.backendPort,
    site_proxy_port: ports.siteProxyPort,
    dashboard_port: ports.dashboardPort,
    postgres_port: ports.postgresPort,
    betterauth_port: ports.betterauthPort,
    volume_name: `convexer-${instanceName}`,
    postgres_volume_name: `convexer-postgres-${instanceName}`,
    postgres_password: crypto.randomBytes(32).toString('hex'),
    instance_name: instanceName,
    instance_secret: crypto.randomBytes(32).toString('hex'),
    extra_env: toExtraEnvJson(finalExtraEnv),
    pinned_version: null,
    detected_version: null,
    health_check_timeout: 300000,
    postgres_health_check_timeout: 60000,
  });

  const operation = createLifecycleOperation('instance.create', instance, `Creating instance ${instance.name}`);
  startCreatedInstanceInBackground(instance, operation.id);

  return instance;
}

export async function startInstanceLifecycle (id: string): Promise<Instance>
{
  const instance = getExistingInstance(id);
  const operation = createLifecycleOperation('instance.start', instance, `Starting instance ${instance.name}`);

  try {
    recordOperationStep(operation.id, 'containers_starting', `Starting containers for ${instance.name}`);
    await runAppEffect(withTransientRetry(tryPromiseApp({
      try: () => startInstance(instance),
      code: 'INSTANCE_START_FAILED',
    })));
    recordOperationStep(operation.id, 'containers_started', `Containers started for ${instance.name}`);
    finishOperation(operation.id, 'success', `Instance ${instance.name} started`);
    return getInstance(instance.id) || instance;
  } catch (error) {
    const appError = asError(error);
    finishOperation(operation.id, 'failed', `Instance ${instance.name} failed to start`, appError.message);
    throw appError;
  }
}

export async function stopInstanceLifecycle (id: string): Promise<Instance>
{
  const instance = getExistingInstance(id);
  const operation = createLifecycleOperation('instance.stop', instance, `Stopping instance ${instance.name}`);

  try {
    recordOperationStep(operation.id, 'containers_stopping', `Stopping containers for ${instance.name}`);
    await runAppEffect(withTransientRetry(tryPromiseApp({
      try: () => stopInstance(instance),
      code: 'INSTANCE_STOP_FAILED',
    })));
    recordOperationStep(operation.id, 'containers_stopped', `Containers stopped for ${instance.name}`);
    finishOperation(operation.id, 'success', `Instance ${instance.name} stopped`);
    return getInstance(instance.id) || instance;
  } catch (error) {
    const appError = asError(error);
    finishOperation(operation.id, 'failed', `Instance ${instance.name} failed to stop`, appError.message);
    throw appError;
  }
}

export function forgetInstanceLifecycle (id: string): void
{
  const instance = getExistingInstance(id);
  const operation = createLifecycleOperation('instance.forget', instance, `Forgetting instance ${instance.name}`);
  deleteInstance(instance.id);
  finishOperation(operation.id, 'success', `Instance ${instance.name} forgotten`);
}

export async function archiveAndDeleteInstanceLifecycle (id: string): Promise<ArchiveDeleteResult>
{
  const instance = getExistingInstance(id);
  const warnings: string[] = [];
  const backupResults: Record<string, unknown> = {};
  const operation = createLifecycleOperation('instance.archive_delete', instance, `Archiving and deleting instance ${instance.name}`);

  try {
    recordOperationStep(operation.id, 'database_backup_running', `Taking pre-deletion database backup for ${instance.name}`);
    backupResults.database = await backupDatabase(instance, randomUUID(), 'Pre-deletion');
  } catch (error) {
    const appError = asError(error);
    console.warn(`Pre-deletion DB backup failed for ${instance.name}:`, appError.message);
    backupResults.database = { success: false, error: appError.message };
  }

  try {
    recordOperationStep(operation.id, 'volume_backup_running', `Taking pre-deletion volume backup for ${instance.name}`);
    backupResults.volume = await backupVolume(instance, randomUUID(), 'Pre-deletion');
  } catch (error) {
    const appError = asError(error);
    console.warn(`Pre-deletion volume backup failed for ${instance.name}:`, appError.message);
    backupResults.volume = { success: false, error: appError.message };
  }

  try {
    recordOperationStep(operation.id, 'containers_removing', `Removing containers and volumes for ${instance.name}`);
    await removeInstance(instance);
  } catch (error) {
    const appError = asError(error);
    console.warn('Failed to remove containers:', appError.message);
    warnings.push(`containers: ${appError.message}`);
  }

  try {
    recordOperationStep(operation.id, 'tunnel_removing', `Removing tunnel routes for ${instance.name}`);
    removeTunnelRoutes(instance);
  } catch (error) {
    const appError = asError(error);
    console.warn('Failed to remove tunnel routes:', appError.message);
    warnings.push(`tunnel: ${appError.message}`);
  }

  recordOperationStep(operation.id, 'instance_archiving', `Archiving instance ${instance.name}`);
  archiveInstance(instance.id);
  finishOperation(
    operation.id,
    warnings.length > 0 ? 'failed' : 'success',
    warnings.length > 0 ? `Instance ${instance.name} archived with warnings` : `Instance ${instance.name} archived`,
    warnings.length > 0 ? warnings.join('; ') : undefined
  );

  return {
    archived: true,
    warnings: warnings.length ? warnings : undefined,
    backups: backupResults,
  };
}

export async function permanentlyDeleteArchivedInstanceLifecycle (id: string): Promise<void>
{
  const instance = getArchivedInstance(id);
  const history = getBackupHistory(instance.id, 1000);

  for (const backup of history) {
    if (backup.file_path) {
      try {
        await fsPromises.unlink(backup.file_path);
      } catch {
        // Backup file is already gone.
      }
    }
  }

  const backupDir = path.join(process.env.DATA_DIR || process.cwd(), 'backups', instance.id);
  await fsPromises.rm(backupDir, { recursive: true, force: true });
  deleteInstance(instance.id);
}

export async function restoreArchivedInstanceLifecycle (id: string): Promise<RestoreArchivedResult>
{
  const instance = getArchivedInstance(id);
  const conflict = getInstanceByName(instance.name);
  const finalName = conflict ? generateConflictName() : instance.name;

  const restored = restoreArchivedInstance(instance.id, conflict ? finalName : undefined);
  if (!restored) throw new AppError(500, 'INSTANCE_RESTORE_FAILED', 'Failed to restore instance');

  const updatedInstance = getInstance(instance.id);
  if (!updatedInstance) throw new AppError(500, 'INSTANCE_RESTORE_FAILED', 'Failed to retrieve restored instance');

  const operation = createLifecycleOperation('instance.restore', updatedInstance, `Restoring instance ${updatedInstance.name}`);

  try {
    await createAndStartInstance(updatedInstance, undefined, operationStepRecorder(operation.id));
    const current = getInstance(updatedInstance.id);
    if (current?.status === 'running') {
      finishOperation(operation.id, 'success', `Instance ${updatedInstance.name} restored`);
    } else {
      finishOperation(operation.id, 'failed', `Instance ${updatedInstance.name} failed to restore`, current?.error_message || 'Unknown restore failure');
    }
  } catch (error) {
    const appError = asError(error);
    console.error('Failed to recreate instance:', appError.message);
    finishOperation(operation.id, 'failed', `Instance ${updatedInstance.name} failed to restore`, appError.message);
    throw appError;
  }

  return {
    instance: getInstance(updatedInstance.id) || updatedInstance,
    renamed: conflict ? finalName : undefined,
  };
}
