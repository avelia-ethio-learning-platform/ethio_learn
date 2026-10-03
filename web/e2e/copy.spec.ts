import { expect, test } from '@playwright/test';

// P0-16: plain apostrophes in the Help FAQ.
test('the Help page shows no literal &apos;', async ({ page }) => {
  await page.goto('/help');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('&apos;');
  await expect(page.locator('main')).toContainText("What's the difference between free, freemium and paid courses?");
});

// P0-17: no developer copy on the signup success screen. P1-34: it offers a
// resend once the 60 s wait is over. Two auth-strict calls (signup, resend).
test('signup success has no developer copy, and the verification email can be resent', async ({ page }) => {
  // Installed before goto so the countdown can be run out without waiting a minute.
  await page.clock.install();
  await page.goto('/signup');
  await page.locator('input[name="name"]').fill('E2E Signup');
  await page.locator('input[name="email"]').fill(`e2e-signup-${Date.now()}@example.com`);
  await page.locator('input[name="password"]').fill(`E2e-${Math.random().toString(36).slice(2, 10)}-x9`);
  await page.locator('main form').getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('notification service logs');

  // The signup email already counts toward the server's 60 s cap, so Resend starts disabled.
  const resend = page.getByRole('button', { name: /^Resend/ });
  await expect(resend).toBeDisabled();
  await expect(resend).toHaveText('Resend in 60 s');
  await page.clock.runFor(61_000);
  await expect(resend).toBeEnabled();
  await expect(resend).toHaveText('Resend email');
  await resend.click();
  // The server answers the same 200 whether or not its own cap sent a mail, so the message is the assertion.
  await expect(page.getByRole('status').filter({ hasText: "If an unverified account exists for that email, we've sent a new link." })).toBeVisible();
  await expect(resend).toBeDisabled();
  await expect(resend).toHaveText('Resend in 60 s');
});
