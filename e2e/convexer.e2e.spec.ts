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

async function runSql(request: APIRequestContext, token: string, instanceId: string, query: string): Promise<any[]> {
  const res = await authedJson<{ results: any[] }>(request, token, `/api/instances/${instanceId}/postgres/query`, {
    method: 'POST',
    data: { query },
  });
  return res.results;
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
