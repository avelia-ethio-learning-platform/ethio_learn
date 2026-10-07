import { expect, test } from './test';
import { authFile } from './support';

// P0-11: no role sees a page or form the API will refuse.
test.describe('institution admin', () => {
  test.use({ storageState: authFile('institution_admin') });

  test('gets no create-course form on /teach/new (the API refuses institutions)', async ({ page }) => {
    await page.goto('/teach/new');
    await expect(page.getByRole('heading', { name: "This page isn't available for your account" })).toBeVisible();
    await expect(page.locator('main form')).toHaveCount(0);
  });

  test('back links on shared teach pages lead to the institution dashboard', async ({ page }) => {
    // In a new tab there's no history, so Back goes to the role's home instead of
    // history.back(). (page.goto would leave about:blank behind it.)
    await page.goto('/institution');
    const [tab] = await Promise.all([page.waitForEvent('popup'), page.evaluate(() => void window.open('/teach/analytics'))]);
    await tab.getByRole('button', { name: 'Institution dashboard' }).click();
    await expect(tab).toHaveURL(/\/institution$/);
  });
});

test.describe('educator', () => {
  test.use({ storageState: authFile('educator') });

  test('gets the create-course form on /teach/new', async ({ page }) => {
    await page.goto('/teach/new');
    await expect(page.locator('main form')).toBeVisible();
    await expect(page.getByRole('heading', { name: "This page isn't available for your account" })).toHaveCount(0);
  });
});
