import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const AUTH_PASSWORD = process.env.E2E_AUTH_PASSWORD || process.env.AUTH_PASSWORD || 'convexer-e2e-password';

type Instance = {
  id: string;
  name: string;
  status: string;
};

type BackupEntry = {
  id: string;
  backup_type: 'database' | 'volume';
  status: string;
  restored_at?: string | null;
  pre_restore_snapshot_id?: string | null;
};

async function waitForValue<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  intervalMs: number,
  description: string
): Promise<T> {
  const start = Date.now();
  let latest: T | undefined;

  while (Date.now() - start < timeoutMs) {
    latest = await fn();
    if (predicate(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${description}. Last value: ${JSON.stringify(latest)}`);
}

async function getTokenFromBrowser(page: Page): Promise<string> {
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('convexer_token')), {
    timeout: 15_000,
  }).not.toBeNull();

  const token = await page.evaluate(() => localStorage.getItem('convexer_token'));
  if (!token) throw new Error('Missing auth token in localStorage after login');
  return token;
}

async function authedJson<T>(request: APIRequestContext, token: string, path: string, init?: { method?: 'GET' | 'POST'; data?: unknown }): Promise<T> {
  const response = await request.fetch(path, {
    method: init?.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: init?.data,
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Request failed: ${init?.method || 'GET'} ${path} -> ${response.status()} ${raw}`);
  }

  if (!raw) return undefined as T;
  return JSON.parse(raw) as T;
}

async function loginViaApi(request: APIRequestContext): Promise<string> {
  const response = await request.fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: { password: AUTH_PASSWORD },
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Login failed: ${response.status()} ${raw}`);
  }
  const payload = JSON.parse(raw);
  if (!payload?.token) {
    throw new Error(`Login response missing token: ${raw}`);
  }
  return payload.token as string;
}

async function runSql(request: APIRequestContext, token: string, instanceId: string, query: string): Promise<any[]> {
  const res = await authedJson<{ results?: any[]; data?: { results?: any[] } }>(request, token, `/api/instances/${instanceId}/postgres/query`, {
    method: 'POST',
    data: { query },
  });
  return res.results ?? res.data?.results ?? [];
}

async function getBackupHistory(request: APIRequestContext, token: string, instanceId: string): Promise<BackupEntry[]> {
  const res = await authedJson<{ history: BackupEntry[] }>(request, token, `/api/instances/${instanceId}/backup/history?limit=50`);
  return res.history;
}

test.describe.configure({ mode: 'serial' });

test('fresh setup, create instance, and backup/restore round-trip', async ({ page, request }) => {
  page.on('dialog', async dialog => {
    await dialog.accept();
  });

  const healthRes = await request.get('/api/health');
  expect(healthRes.ok()).toBeTruthy();
  const health = await healthRes.json();
  expect(health.ok).toBe(true);

  const unauthInstancesRes = await request.get('/api/instances');
  expect(unauthInstancesRes.status()).toBe(401);

  await page.goto('/');
  await expect(page.getByTestId('login-page')).toBeVisible();
  await page.getByTestId('login-password-input').fill(AUTH_PASSWORD);
  await page.getByTestId('login-submit-button').click();

  await expect(page.getByTestId('new-instance-button')).toBeVisible();
  await expect(page.getByTestId('home-no-instances-title')).toBeVisible();

  const token = await getTokenFromBrowser(page);
  const emptyInstances = await authedJson<Instance[]>(request, token, '/api/instances');
  expect(emptyInstances).toEqual([]);

  const instanceName = `e2e-${Date.now()}`;

  await page.getByTestId('new-instance-button').click();
  await expect(page.getByTestId('create-instance-dialog')).toBeVisible();
  await page.getByTestId('create-instance-name-input').fill(instanceName);
  await page.getByTestId('create-instance-submit-button').click();
  await expect(page.getByTestId('create-instance-dialog')).toBeHidden();

  const instance = await waitForValue<Instance | null>(
    async () => {
      const instances = await authedJson<Instance[]>(request, token, '/api/instances');
      return instances.find(i => i.name === instanceName) || null;
    },
    value => value !== null,
    3 * 60 * 1000,
    3_000,
    `created instance ${instanceName}`
  );

  await expect.poll(async () => {
    const detail = await authedJson<Instance>(request, token, `/api/instances/${instance.id}`);
    return detail.status;
  }, {
    timeout: 12 * 60 * 1000,
    intervals: [2_000, 5_000, 10_000, 15_000],
  }).toBe('running');

  await page.getByTestId(`sidebar-instance-link-${instance.id}`).click();
  await expect(page.getByRole('heading', { name: instanceName })).toBeVisible();

  await runSql(request, token, instance.id, 'CREATE TABLE IF NOT EXISTS e2e_restore_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  await runSql(request, token, instance.id, 'TRUNCATE TABLE e2e_restore_items');
  await runSql(request, token, instance.id, "INSERT INTO e2e_restore_items (id, value) VALUES (1, 'alpha'), (2, 'beta')");

  const baselineRows = await runSql(request, token, instance.id, 'SELECT id, value FROM e2e_restore_items ORDER BY id');
  expect(baselineRows).toEqual([
    { id: 1, value: 'alpha' },
    { id: 2, value: 'beta' },
  ]);

  await page.getByTestId('tab-backups').click();
  await expect(page.getByTestId('backup-now-button')).toBeVisible();
  await page.getByTestId('backup-now-button').click();

  const targetBackupId = await waitForValue<string | null>(
    async () => {
      const history = await getBackupHistory(request, token, instance.id);
      const databaseBackup = history.find(entry => entry.backup_type === 'database' && entry.status === 'completed');
      return databaseBackup?.id || null;
    },
    value => value !== null,
    5 * 60 * 1000,
    3_000,
    'completed database backup'
  ) as string;

  await runSql(request, token, instance.id, 'TRUNCATE TABLE e2e_restore_items');
  await runSql(request, token, instance.id, "INSERT INTO e2e_restore_items (id, value) VALUES (10, 'mutated')");
  const mutatedRows = await runSql(request, token, instance.id, 'SELECT id, value FROM e2e_restore_items ORDER BY id');
  expect(mutatedRows).toEqual([{ id: 10, value: 'mutated' }]);

  await expect(page.getByTestId(`backup-rollback-${targetBackupId}`)).toBeVisible({ timeout: 60_000 });
  await page.getByTestId(`backup-rollback-${targetBackupId}`).click();

  await expect.poll(async () => {
    const details = await authedJson<{ backup: BackupEntry }>(request, token, `/api/backups/${targetBackupId}/details`);
    return {
      restoredAt: details.backup.restored_at || null,
      preRestoreSnapshotId: details.backup.pre_restore_snapshot_id || null,
    };
  }, {
    timeout: 5 * 60 * 1000,
    intervals: [2_000, 3_000, 5_000, 8_000],
  }).toMatchObject({
    restoredAt: expect.any(String),
    preRestoreSnapshotId: expect.any(String),
  });

  const restoredRows = await runSql(request, token, instance.id, 'SELECT id, value FROM e2e_restore_items ORDER BY id');
  expect(restoredRows).toEqual([
    { id: 1, value: 'alpha' },
    { id: 2, value: 'beta' },
  ]);
});

test('admin hardening endpoints require auth and return validated contracts', async ({ page, request }) => {
  const unauthPreflight = await request.get('/api/admin/preflight');
  const authEnabled = unauthPreflight.status() === 401;
  if (authEnabled) {
    const unauthRepairNetwork = await request.post('/api/admin/repair/network');
    expect(unauthRepairNetwork.status()).toBe(401);
    const unauthRepairRestart = await request.post('/api/admin/repair/restart');
    expect(unauthRepairRestart.status()).toBe(401);
    const unauthRepairCleanup = await request.post('/api/admin/repair/cleanup', {
      data: { confirm: 'prune-builder-cache' },
    });
    expect(unauthRepairCleanup.status()).toBe(401);
  }

  await page.goto('/');
  await expect(page.getByTestId('login-page')).toBeVisible();
  await page.getByTestId('login-password-input').fill(AUTH_PASSWORD);
  await page.getByTestId('login-submit-button').click();
  await expect(page.getByTestId('new-instance-button')).toBeVisible();

  const token = await getTokenFromBrowser(page);

  const preflight = await authedJson<any>(request, token, '/api/admin/preflight');
  const preflightData = preflight.data ?? preflight;
  expect(typeof preflightData.docker_socket).toBe('boolean');
  expect(typeof preflightData.network_exists).toBe('boolean');
  expect(typeof preflightData.update_strategy).toBe('string');

  const diagnostics = await authedJson<any>(request, token, '/api/admin/diagnostics');
  const diagnosticsData = diagnostics.data ?? diagnostics;
  expect(diagnosticsData.generated_at).toBeTruthy();
  expect(diagnosticsData.docker?.server_version).toBeTruthy();

  const networkRepair = await authedJson<any>(request, token, '/api/admin/repair/network', { method: 'POST' });
  const networkRepairData = networkRepair.data ?? networkRepair;
  expect(networkRepairData.success).toBe(true);
  expect(networkRepairData.network).toBe('convexer-net');

  const invalidCleanup = await request.fetch('/api/admin/repair/cleanup', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { confirm: 'wrong-confirmation' },
  });
  expect(invalidCleanup.status()).toBe(400);
  const invalidCleanupBody = await invalidCleanup.json();
  expect(invalidCleanupBody.error?.code).toBe('VALIDATION_ERROR');
});

test('validation hardening rejects malformed payloads', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('login-page')).toBeVisible();
  await page.getByTestId('login-password-input').fill(AUTH_PASSWORD);
  await page.getByTestId('login-submit-button').click();
  await expect(page.getByTestId('new-instance-button')).toBeVisible();

  const token = await getTokenFromBrowser(page);

  const invalidCreate = await request.fetch('/api/instances', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { name: '', extra_env: { GOOD: 'ok', BAD: 1 } },
  });
  expect(invalidCreate.status()).toBe(400);
  const invalidCreateBody = await invalidCreate.json();
  expect(invalidCreateBody.error?.code).toBe('VALIDATION_ERROR');

  const validCreate = await authedJson<Instance>(request, token, '/api/instances', {
    method: 'POST',
    data: { name: `valid-${Date.now()}`, extra_env: { SITE_DOMAIN: 'x.local' } },
  });
  const created = (validCreate as any).data ?? validCreate;
  expect(created.id).toBeTruthy();

  const invalidHealth = await request.fetch(`/api/instances/${created.id}/health-check-settings`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { health_check_timeout: 1000, postgres_health_check_timeout: 60000 },
  });
  expect(invalidHealth.status()).toBe(400);
  const invalidHealthBody = await invalidHealth.json();
  expect(invalidHealthBody.error?.code).toBe('VALIDATION_ERROR');

  const invalidPgQuery = await request.fetch(`/api/instances/${created.id}/postgres/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { query: '' },
  });
  expect(invalidPgQuery.status()).toBe(400);
  const invalidPgBody = await invalidPgQuery.json();
  expect(invalidPgBody.error?.code).toBe('VALIDATION_ERROR');
});

test('update status endpoints expose job-compatible contract', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('login-page')).toBeVisible();
  await page.getByTestId('login-password-input').fill(AUTH_PASSWORD);
  await page.getByTestId('login-submit-button').click();
  await expect(page.getByTestId('new-instance-button')).toBeVisible();

  const token = await getTokenFromBrowser(page);

  const updateStart = await request.fetch('/api/version/update', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { targetVersion: 'latest' },
  });
  expect(updateStart.status()).toBe(202);
  const startBody = await updateStart.json();
  const startData = startBody.data ?? startBody;
  expect(startData.success).toBe(true);
  expect(typeof startData.jobId).toBe('string');

  const statusResponse = await authedJson<any>(request, token, '/api/version/update/status');
  const status = statusResponse.data ?? statusResponse;
  expect(typeof status.running).toBe('boolean');
  expect(typeof status.status).toBe('string');
  expect(typeof status.progress).toBe('number');
  expect(status.jobId).toBeTruthy();

  const logsResponse = await authedJson<any>(request, token, '/api/version/update/logs');
  expect(typeof logsResponse.logs).toBe('string');
});

test('rollback status and diagnostics expose update job metadata', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('login-page')).toBeVisible();
  await page.getByTestId('login-password-input').fill(AUTH_PASSWORD);
  await page.getByTestId('login-submit-button').click();
  await expect(page.getByTestId('new-instance-button')).toBeVisible();

  const token = await getTokenFromBrowser(page);

  const updateStart = await request.fetch('/api/version/update', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { targetVersion: 'latest' },
  });
  expect(updateStart.status()).toBe(202);
  const startBody = await updateStart.json();
  const startData = startBody.data ?? startBody;
  expect(typeof startData.jobId).toBe('string');

  const rollbackStatusRes = await authedJson<any>(request, token, '/api/version/rollback/status');
  const rollbackStatus = rollbackStatusRes.data ?? rollbackStatusRes;
  expect(typeof rollbackStatus.available).toBe('boolean');
  expect(rollbackStatus).toHaveProperty('commit');
  expect(rollbackStatus).toHaveProperty('jobId');

  const diagnosticsRes = await authedJson<any>(request, token, '/api/admin/diagnostics');
  const diagnostics = diagnosticsRes.data ?? diagnosticsRes;
  expect(diagnostics.latest_update_job).toBeTruthy();
  expect(diagnostics.latest_update_job.id).toBe(startData.jobId);
  expect(typeof diagnostics.latest_update_job.status).toBe('string');
});

test('update failure path reports failed job status', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('login-page')).toBeVisible();
  await page.getByTestId('login-password-input').fill(AUTH_PASSWORD);
  await page.getByTestId('login-submit-button').click();
  await expect(page.getByTestId('new-instance-button')).toBeVisible();

  const token = await getTokenFromBrowser(page);
  const impossibleTag = `tag-that-does-not-exist-${Date.now()}`;

  const updateStart = await request.fetch('/api/version/update', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { targetVersion: impossibleTag },
  });
  expect(updateStart.status()).toBe(202);
  const startBody = await updateStart.json();
  const startData = startBody.data ?? startBody;
  expect(typeof startData.jobId).toBe('string');

  const finalStatus = await waitForValue<any>(
    async () => {
      const res = await authedJson<any>(request, token, '/api/version/update/status');
      return res.data ?? res;
    },
    value => value.status === 'failed' || (value.running === false && value.success === false),
    90_000,
    2_000,
    'failed update job status'
  );

  expect(finalStatus.running).toBe(false);
  expect(finalStatus.success).toBe(false);
  expect(finalStatus.status).toBe('failed');

  const diagnosticsRes = await authedJson<any>(request, token, '/api/admin/diagnostics');
  const diagnostics = diagnosticsRes.data ?? diagnosticsRes;
  expect(diagnostics.latest_update_job).toBeTruthy();
  expect(diagnostics.latest_update_job.id).toBe(startData.jobId);
  expect(diagnostics.latest_update_job.status).toBe('failed');
  expect(typeof diagnostics.latest_update_job.error_message).toBe('string');
});

test('API integration: /admin/diagnostics returns non-UI contract', async ({ request }) => {
  const unauth = await request.get('/api/admin/diagnostics');
  expect([200, 401]).toContain(unauth.status());

  const token = await loginViaApi(request);
  const response = await authedJson<any>(request, token, '/api/admin/diagnostics');
  const data = response.data ?? response;

  expect(typeof data.generated_at).toBe('string');
  expect(typeof data.docker?.server_version).toBe('string');
  expect(data).toHaveProperty('disk');
  expect(data).toHaveProperty('docker_disk');
  expect(data).toHaveProperty('latest_update_job');
});

test('API integration: /admin/audit returns non-UI contract', async ({ request }) => {
  const token = await loginViaApi(request);

  // Generate at least one audited action first.
  await authedJson<any>(request, token, '/api/admin/diagnostics');

  const response = await authedJson<any>(request, token, '/api/admin/audit?limit=20');
  const data = response.data ?? response;
  expect(Array.isArray(data.logs)).toBe(true);
  expect(data.logs.length).toBeGreaterThan(0);

  const first = data.logs[0];
  expect(typeof first.id).toBe('string');
  expect(typeof first.action).toBe('string');
  expect(typeof first.status).toBe('string');
  expect(typeof first.created_at).toBe('string');
});
