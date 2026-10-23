import { randomUUID } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SITEOPS_E2E_PORT ?? 5200);
const dataDir = process.env.SITEOPS_E2E_DATA_DIR ?? `work/e2e-${randomUUID()}`;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: `SITEOPS_MODE=demo SITEOPS_PORT=${port} SITEOPS_BOOTSTRAP=siteops-e2e-bootstrap SITEOPS_DATA_DIR=${dataDir} npm start`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
