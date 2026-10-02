import { expect, test } from '@playwright/test';
import { authFile } from './support';

// P0-11: no role sees a page or form the API will refuse.
test.describe('institution admin', () => {
  test.use({ storageState: authFile('institution_admin') });

  test('gets no create-course form on /teach/new (the API refuses institutions)', async ({ page }) => {
    await page.goto('/teach/new');
    await expect(page.getByText(/This area is for/)).toBeVisible();
    await expect(page.locator('main form')).toHaveCount(0);
  });

  test('back links on shared teach pages lead to the institution dashboard', async ({ page }) => {
    await page.goto('/teach/analytics');
    await expect(page.getByRole('button', { name: 'Institution dashboard' })).toBeVisible();
  });
});

test.describe('educator', () => {
  test.use({ storageState: authFile('educator') });

  test('gets the create-course form on /teach/new', async ({ page }) => {
    await page.goto('/teach/new');
    await expect(page.locator('main form')).toBeVisible();
    await expect(page.getByText(/This area is for/)).toHaveCount(0);
  });
});
