import { expect, test } from '@playwright/test';
import { learnerCertificateUid } from './support';

// P0-18: /verify takes a certificate ID; the footer links to it.
test('the footer links to the /verify form', async ({ page }) => {
  await page.goto('/');
  await page.locator('footer').getByRole('link', { name: 'Verify a certificate' }).click();
  await expect(page).toHaveURL(/\/verify$/);
  await expect(page.getByRole('heading', { name: 'Verify a certificate' })).toBeVisible();
});

test('a real certificate ID verifies as valid', async ({ page, request }) => {
  const uid = await learnerCertificateUid(request);
  await page.goto('/verify');
  await page.getByLabel('Certificate ID').fill(`  ${uid}  `);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(new RegExp(`/verify/${uid}$`));
  await expect(page.getByRole('heading', { name: 'Valid certificate' })).toBeVisible();
});

test('a made-up ID is not valid', async ({ page }) => {
  await page.goto('/verify');
  await page.getByLabel('Certificate ID').fill('not-a-real-certificate');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Not a valid certificate' })).toBeVisible();
});
