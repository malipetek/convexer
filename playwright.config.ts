import { defineConfig, devices } from '@playwright/test';

const isRemote = Boolean(process.env.REMOTE_BASE_URL);
const baseURL = process.env.REMOTE_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:4000';
const headless = process.env.E2E_HEADLESS === 'false' ? false : true;

export default defineConfig({
  testDir: './e2e',
  timeout: 20 * 60 * 1000,
  expect: {
    timeout: 30_000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    headless,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  metadata: {
    mode: isRemote ? 'remote' : 'local',
  },
});
