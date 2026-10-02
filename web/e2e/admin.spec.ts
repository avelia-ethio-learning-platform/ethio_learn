import { expect, test } from '@playwright/test';
import { authFile } from './support';

test.use({ storageState: authFile('platform_admin') });

// Phase 3's P0-10 fix, guarded in a real browser: Cancel on the reason prompt
// means cancel. (It never confirms: suspending a seeded account would break
// the other specs.)
test('dismissing the suspend prompt sends nothing', async ({ page }) => {
  const statusCalls: string[] = [];
  page.on('request', (req) => {
    if (/\/admin\/users\/[^/]+\/status$/.test(req.url())) statusCalls.push(req.url());
  });

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  const suspend = page.getByRole('button', { name: 'Suspend' }).first();
  await expect(suspend).toBeVisible();

  let prompted = '';
  page.once('dialog', async (dialog) => {
    prompted = dialog.message();
    await dialog.dismiss();
  });
  await suspend.click();
  await page.waitForLoadState('networkidle');

  expect(prompted).toMatch(/Reason for suspended/);
  expect(statusCalls).toEqual([]);
});
