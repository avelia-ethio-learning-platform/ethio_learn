import { expect, test } from '@playwright/test';
import { logIn } from './support';

// P0-12: an expired access token with several requests in flight makes
// exactly one refresh call, and the user stays signed in. This spec logs in on
// its own: refresh tokens are single-use, so rotating the shared learner login
// would break the other specs.
test('parallel 401s share one refresh and the learner stays signed in', async ({ page }) => {
  await logIn(page, 'learner');

  // Expire the session's access token: the gateway now answers 401 to it. Do it
  // on a page where the app isn't running: the dashboard is still firing
  // queries when logIn returns, and one of them would meet the expired token
  // and refresh it before the route below holds the refresh.
  await page.goto('/robots.txt');
  await page.evaluate(() => {
    const auth = JSON.parse(localStorage.getItem('el_auth')!);
    localStorage.setItem('el_auth', JSON.stringify({ ...auth, access_token: 'expired-in-e2e' }));
  });

  // Hold the refresh until several 401s are back, so the requests really overlap.
  let unauthorized = 0;
  let refreshes = 0;
  let release!: () => void;
  const enough = new Promise<void>((resolve) => (release = resolve));
  page.on('response', (res) => {
    if (res.status() === 401 && res.url().includes('/api/v1/') && ++unauthorized >= 3) release();
  });
  await page.route('**/api/v1/auth/refresh', async (route) => {
    refreshes += 1;
    await Promise.race([enough, new Promise((resolve) => setTimeout(resolve, 5000))]);
    await route.continue();
  });

  await page.goto('/dashboard'); // the dashboard fires its queries in parallel
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(unauthorized, 'several requests met the expired token').toBeGreaterThanOrEqual(3);
  expect(refreshes).toBe(1);
  await expect(page).toHaveURL(/\/dashboard$/);
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('el_auth') ?? 'null')?.access_token);
  expect(token, 'still signed in, with a fresh token').toBeTruthy();
  expect(token).not.toBe('expired-in-e2e');
});
