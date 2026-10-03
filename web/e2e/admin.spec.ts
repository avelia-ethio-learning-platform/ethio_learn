import { expect, test, type Page } from '@playwright/test';
import { authFile } from './support';

test.use({ storageState: authFile('platform_admin') });

// The Users tab in a real browser. Never suspend a seeded account: that would
// break the other specs. Anything that confirms is answered by page.route.

const STATUS_URL = '**/admin/users/*/status';

async function openUsers(page: Page) {
  await page.goto('/admin');
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
  const statusCalls: string[] = [];
  page.on('request', (req) => {
    if (/\/admin\/users\/[^/]+\/status$/.test(req.url())) statusCalls.push(req.url());
  });

  await openUsers(page);
  const suspend = await firstSuspend(page);
  await suspend.click();
  const dialog = page.getByRole('dialog', { name: /^Suspend / });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.waitForLoadState('networkidle');

  expect(statusCalls).toEqual([]);
  await expect(suspend).toBeFocused();
});

test('confirming with a reason sends it', async ({ page }) => {
  const bodies: unknown[] = [];
  await page.route(STATUS_URL, (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await openUsers(page);
  await (await firstSuspend(page)).click();
  const dialog = page.getByRole('dialog', { name: /^Suspend / });
  await dialog.getByLabel('Reason (optional)').fill('e2e: testing the dialog');
  await dialog.getByRole('button', { name: 'Suspend user' }).click();

  await expect(dialog).toBeHidden();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({ status: 'suspended', reason: 'e2e: testing the dialog' });
  // Focus is not asserted here: the page disables the row buttons while the request runs, which drops focus. The cancel path above covers the return.
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
  await expect(page.getByText('learner@ethiopialearn.et')).toBeVisible();
  await expect(page.getByText('educator@ethiopialearn.et')).toHaveCount(0);
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
  await page.getByRole('tab', { name: 'Coupons' }).click();
  await expect(page.getByRole('tab', { name: 'Coupons' })).toHaveAttribute('aria-selected', 'true');
  await page.waitForLoadState('networkidle');

  expect(forbidden).toEqual([]);
});
