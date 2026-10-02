import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, COLD_PORT, COLD_URL, WEB_PORT } from './e2e/support';

/**
 * Browser smoke suite (P1-30). Runs against a production build (`next start`)
 * with the API stack up and seeded (`pnpm -C api seed`, scripts/demo-seed.mjs).
 *
 * Login budget: the gateway's auth-strict bucket allows 10 calls a minute per
 * IP, and every call here comes from 127.0.0.1. This suite makes 7:
 * auth.setup.ts logs in once per seeded role (5), refresh.spec.ts logs in on
 * its own (1) and copy.spec.ts signs up (1). Every other spec reuses
 * e2e/.auth/<role>.json. A new spec that logs in, signs up, verifies an email,
 * accepts an invite or resets a password spends from the same 10: reuse the
 * stored login instead. CI runs scripts/e2e-smoke.mjs after this suite (it
 * exhausts the bucket on purpose). No retries: a retried setup logs in again.
 */
export default defineConfig({
  testDir: './e2e',
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // sw.js (registered in Providers) serves API reads itself, which hides
    // them from page.route and page.on('request').
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup'] },
  ],
  // NODE_ENV is pinned: a caller's NODE_ENV=development (e.g. api/.env.example
  // exported into the shell) makes `next start` drop the stale-page fallback.
  webServer: [
    {
      command: `pnpm exec next start -p ${WEB_PORT}`,
      url: `${BASE_URL}/login`,
      reuseExistingServer: true,
      env: { NODE_ENV: 'production' },
    },
    {
      // The same build with the API unreachable (P0-09), sharing .next: its
      // revalidations fail, and a failed one only re-saves the page it had.
      command: `pnpm exec next start -p ${COLD_PORT}`,
      url: `${COLD_URL}/login`,
      reuseExistingServer: false,
      env: { NODE_ENV: 'production', GATEWAY_INTERNAL_URL: 'http://127.0.0.1:9' },
    },
  ],
});
