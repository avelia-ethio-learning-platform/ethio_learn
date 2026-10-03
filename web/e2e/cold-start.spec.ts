import { expect, test } from './test';
import { COLD_URL, firstCourseId, learnerCertificateUid } from './support';

// P0-09: the same build, served with the API unreachable (see the second
// webServer in playwright.config.ts). A sleeping API must never read as
// "not found" or "invalid", and the static home page still renders.
test.use({ baseURL: COLD_URL });

test('a course page says the server is waking up, not 404', async ({ page, request }) => {
  const res = await page.goto(`/courses/${await firstCourseId(request)}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('status')).toContainText("We're waking up the server");
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByRole('heading', { name: "We couldn't find that page" })).toHaveCount(0);
});

test('a certificate page says the server is waking up, not "invalid"', async ({ page, request }) => {
  await page.goto(`/verify/${await learnerCertificateUid(request)}`);
  await expect(page.getByRole('status')).toContainText("We're waking up the server");
  await expect(page.getByText('Not a valid certificate')).toHaveCount(0);
});

test('the home page still shows the course cards from its last good render', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const courseLinks = await page
    .locator('main a[href^="/courses/"]')
    .evaluateAll((links) => links.filter((a) => /^\/courses\/[0-9a-f-]{36}$/.test(a.getAttribute('href') ?? '')).length);
  expect(courseLinks).toBeGreaterThan(0);
  await expect(page.getByText('The course list is loading.')).toHaveCount(0);
});
