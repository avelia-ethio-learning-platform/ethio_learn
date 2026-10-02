import { expect, test } from '@playwright/test';

// P0-16: plain apostrophes in the Help FAQ.
test('the Help page shows no literal &apos;', async ({ page }) => {
  await page.goto('/help');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('&apos;');
  await expect(page.locator('main')).toContainText("What's the difference between free, freemium and paid courses?");
});

// P0-17: no developer copy on the signup success screen. One auth-strict call.
test('signup success has no developer copy', async ({ page }) => {
  await page.goto('/signup');
  await page.locator('input[name="name"]').fill('E2E Signup');
  await page.locator('input[name="email"]').fill(`e2e-signup-${Date.now()}@example.com`);
  await page.locator('input[name="password"]').fill(`E2e-${Math.random().toString(36).slice(2, 10)}-x9`);
  await page.locator('main form').getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('notification service logs');
});
