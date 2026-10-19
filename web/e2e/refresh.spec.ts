import { expect, test } from './test';
import { API_URL, BASE_URL } from './support';

// P0-12 under memory tokens (Phase 11b): when several calls meet an expired
// access token, they share one refresh, through the web origin, and the
// learner stays signed in.
test.use({ loggedInAs: 'learner' });

test('parallel 401s share one same-origin refresh and the learner stays signed in', async ({ page }) => {
  const refreshes: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/v1/auth/refresh')) refreshes.push(req.url());
  });
  // The gateway answers the first three bearer calls as if the token had expired.
  let expired = 0;
  await page.route(`${API_URL}/api/v1/**`, async (route) => {
    if (route.request().headers().authorization && expired < 3) {
      expired += 1;
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{"statusCode":401,"message":"jwt expired"}' });
      return;
    }
    await route.continue();
  });

  await page.goto('/dashboard'); // the boot refresh, then the dashboard's parallel queries
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(expired, 'several requests met the expired token').toBe(3);
  // One at boot, one shared by the three 401s.
  expect(refreshes).toEqual([`${BASE_URL}/api/v1/auth/refresh`, `${BASE_URL}/api/v1/auth/refresh`]);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('button', { name: 'Log out' }).first()).toBeVisible();
});
