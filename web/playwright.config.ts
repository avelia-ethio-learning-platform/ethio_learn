import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, COLD_PORT, COLD_URL, WEB_PORT } from './e2e/support';

/**
 * Browser smoke suite (P1-30). Runs against a production build (`next start`)
 * with the API stack up and seeded (`pnpm -C api seed`, scripts/demo-seed.mjs).
 *
 * Logins: auth.setup.ts logs each seeded role in through the form once and
 * saves its access token for API-level calls (tokenFor). Browser specs sign in
 * per test (`test.use({ loggedInAs })`, e2e/test.ts): every page load rotates
 * the refresh cookie, so a saved storageState would work for one context only
 * (Phase 11b). That spends one auth-strict call per test, so the e2e stack
 * raises RATE_LIMIT_AUTH_STRICT_PER_MIN and RATE_LIMIT_AUTH_PER_MIN
 * (api/.env.example, which CI copies to api/.env). No retries: a retried
 * setup logs in again.
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
    // Phase 12: the key flows (tests tagged @flow) again with reduced motion on.
    {
      name: 'reduced-motion',
      use: { ...devices['Desktop Chrome'], reducedMotion: 'reduce' },
      grep: /@flow/,
      dependencies: ['setup'],
    },
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
