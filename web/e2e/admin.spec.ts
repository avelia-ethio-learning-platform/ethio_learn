import { expect, test, type Page } from './test';
import { authFile, BASE_URL } from './support';

test.use({ storageState: authFile('platform_admin') });

// The Users tab in a real browser. Never suspend a seeded account: that would
// break the other specs. Anything that confirms is answered by page.route.

const STATUS_URL = '**/admin/users/*/status';

/**
 * Answers the status call here, so no real account changes. The web and the API are on different
 * origins and the call carries Authorization, so it preflights: OPTIONS gets the CORS headers
 * (as in a11y.spec.ts) and only the POST bodies are recorded.
 */
async function stubStatus(page: Page) {
  const bodies: unknown[] = [];
  const cors = { 'access-control-allow-origin': BASE_URL, 'access-control-allow-credentials': 'true' };
  await page.route(STATUS_URL, (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
    }
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{}' });
  });
  return bodies;
}

async function openUsers(page: Page) {
  await page.goto('/admin');
  // Wait for hydration before clicking: the default tab is selected once the console has rendered.
  await expect(page.getByRole('tab', { name: 'Analytics' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Users' }).click();
  await expect(page.getByRole('tab', { name: 'Users' })).toHaveAttribute('aria-selected', 'true');
}

/** The first row with a Suspend button, so the platform admin's own row (no buttons) is skipped. */
async function firstSuspend(page: Page) {
  const suspend = page.getByRole('button', { name: 'Suspend', exact: true }).first();
  await expect(suspend).toBeVisible();
  return suspend;
}

test('Escape on the suspend dialog sends nothing (P0-10)', async ({ page }) => {
  const bodies = await stubStatus(page);

  await openUsers(page);
  const suspend = await firstSuspend(page);
  await suspend.click();
  const dialog = page.getByRole('dialog', { name: /^Suspend / });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.waitForLoadState('networkidle');

  expect(bodies).toEqual([]);
  await expect(suspend).toBeFocused();
});

test('confirming with a reason sends it, and focus returns to Suspend', async ({ page }) => {
  const bodies = await stubStatus(page);

  await openUsers(page);
  const suspend = await firstSuspend(page);
  await suspend.click();
  const dialog = page.getByRole('dialog', { name: /^Suspend / });
  await dialog.getByLabel('Reason (optional)').fill('e2e: testing the dialog');
  await dialog.getByRole('button', { name: 'Suspend user' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: /: Suspended\.$/ })).toBeVisible();
  expect(bodies).toEqual([{ status: 'suspended', reason: 'e2e: testing the dialog' }]);
  await expect(suspend).toBeFocused();
});

test('Tab never reaches anything behind the dialog', async ({ page }) => {
  await openUsers(page);
  await (await firstSuspend(page)).click();
  const dialog = page.getByRole('dialog', { name: /^Suspend / });
  await expect(dialog).toBeVisible();

  // showModal() makes the page inert but lets focus leave through the browser UI, so this isn't a full trap:
  // focus is inside the dialog or on body, never on the page behind it.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    const where = await page.evaluate(() => {
      const el = document.activeElement;
      return el === document.body || !!el?.closest('dialog') ? 'ok' : `${el?.tagName} ${el?.textContent?.slice(0, 30)}`;
    });
    expect(where, `after Tab press ${i + 1}`).toBe('ok');
  }
  await page.keyboard.press('Escape');
});

test('/admin?tab=users opens Users and a reload keeps it', async ({ page }) => {
  await page.goto('/admin?tab=users');
  const users = page.getByRole('tab', { name: 'Users' });
  await expect(users).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: /^Users \(/ })).toBeVisible();
  await page.reload();
  await expect(users).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: /^Users \(/ })).toBeVisible();
});

test('a name search finds a seeded user', async ({ page }) => {
  await openUsers(page);
  await page.getByRole('searchbox', { name: 'Search users' }).fill('Sara Tesfaye');
  // Exactly one match: the count in the heading proves the search ran, not just that the row was already there.
  await expect(page.getByRole('heading', { name: 'Users (1)' })).toBeVisible();
  await expect(page.getByText('learner@ethiopialearn.et')).toHaveCount(1);
});

test('Next shows the second page of users', async ({ page }) => {
  await openUsers(page);
  const showing = page.getByRole('status').filter({ hasText: /^Showing / });
  await expect(showing).toBeVisible();
  const total = Number(/of (\d+)/.exec((await showing.textContent()) ?? '')?.[1]);
  // The base seed has 5 accounts; e2e runs add more, so this depends on the database.
  test.skip(!(total > 20), `only ${total} users in this database; paging needs more than 20`);

  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(showing).toHaveText(new RegExp(`^Showing 21–${Math.min(40, total)} of ${total}$`));
});

test('the Coupons tab triggers no 403', async ({ page }) => {
  const forbidden: string[] = [];
  page.on('response', (res) => {
    if (res.status() === 403) forbidden.push(res.url());
  });

  await page.goto('/admin');
  await expect(page.getByRole('tab', { name: 'Analytics' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Coupons' }).click();
  await expect(page.getByRole('tab', { name: 'Coupons' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(forbidden).toEqual([]);
});
