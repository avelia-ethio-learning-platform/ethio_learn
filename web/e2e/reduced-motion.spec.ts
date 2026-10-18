import { expect, test } from './test';
import { authFile, learnerCertificateUid } from './support';

// P1-57: with reduced motion on, the hero heading is fully opaque at first
// paint, not faded in after hydration.
test.use({ reducedMotion: 'reduce' });

test('the home hero heading is opaque at first paint', async ({ page }) => {
  // Record the heading's effective opacity (its own times every ancestor's) the
  // moment the browser reports first-contentful-paint.
  await page.addInitScript(() => {
    // null when the heading isn't in the first paint at all, so the check below fails rather than passing on nothing.
    const effectiveOpacity = (el: Element | null): number | null => {
      if (!el) return null;
      let o = 1;
      for (let node: Element | null = el; node; node = node.parentElement) o *= Number(getComputedStyle(node).opacity);
      return o;
    };
    new PerformanceObserver((list, observer) => {
      if (!list.getEntriesByName('first-contentful-paint').length) return;
      (window as unknown as { __heroOpacity: number | null }).__heroOpacity = effectiveOpacity(document.querySelector('main h1'));
      observer.disconnect();
    }).observe({ type: 'paint', buffered: true });
  });

  await page.goto('/');
  const h1 = page.locator('main h1').first();
  await expect(h1).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __heroOpacity?: number | null }).__heroOpacity)).toBe(1);
  await expect(h1).toHaveCSS('opacity', '1');
});

// Phase 12a: under reduced motion every animated surface is at rest the moment it opens: nothing is
// transformed, nothing is left faded (toBeVisible ignores opacity), and its first control works at once.
type Locator = import('@playwright/test').Locator;

async function expectAtRest(surface: Locator) {
  await expect(surface).toBeVisible();
  // Framer still fades opacity under reduced motion (only transforms are cut); it ends at 1.
  await expect(surface).toHaveCSS('opacity', '1');
  const moved = await surface.evaluate((root) =>
    [root, ...Array.from(root.querySelectorAll('*'))]
      .filter((el) => !['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(el).transform))
      .map((el) => `${el.tagName}.${el.getAttribute('class') ?? ''}`.slice(0, 80)),
  );
  expect(moved, 'transformed elements').toEqual([]);
}

/** The opacity of a CSS enter right after it mounts: no retry, so a fade that runs is caught. */
const opacityNow = (el: Locator) => el.evaluate((node) => getComputedStyle(node).opacity);

test.describe('375 px', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('the mobile menu is at rest when it opens, and its first link works at once', async ({ page }) => {
    await page.goto('/courses');
    const burger = page.getByRole('button', { name: 'Menu' });
    await burger.click();
    const menu = page.locator(`[id="${await burger.getAttribute('aria-controls')}"]`);
    await expectAtRest(menu);
    await menu.getByRole('link', { name: 'Home' }).click({ timeout: 1000 });
    await expect(page).toHaveURL(/\/$/);
  });
});

test('the theme menu is at rest when it opens, and its first option works at once', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Theme' }).first();
  await trigger.click();
  const menu = page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`);
  await expectAtRest(menu);
  await menu.getByRole('button', { name: 'Light' }).click({ timeout: 1000 });
  await expect(menu).toHaveCount(0);
});

test('a catalog change shows the new results fully opaque at once', async ({ page }) => {
  await page.goto('/courses');
  await expect(page.getByTestId('results')).toBeVisible();
  await page.getByLabel('Sort by').selectOption({ label: 'Newest' });
  await expect(page).toHaveURL(/[?&]sort=new(&|$)/);
  await expect(page.getByTestId('results-loading')).toHaveCount(0);
  expect(await opacityNow(page.getByTestId('results'))).toBe('1');
});

test.describe('signed in as a learner', () => {
  test.use({ storageState: authFile('learner') });

  test('the notification panel is at rest when it opens', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dashboard');
    const bell = page.getByRole('button', { name: /^Notifications/ }).first();
    await bell.click();
    await expectAtRest(page.locator(`[id="${await bell.getAttribute('aria-controls')}"]`));
  });

  for (const path of ['/dashboard', '/messages', '/account']) {
    test(`${path} (under a template.tsx) is fully opaque right after navigation`, async ({ page }) => {
      await page.goto(path);
      const page_ = page.locator('main .route-enter').first();
      await expect(page_).toBeAttached();
      expect(await opacityNow(page_)).toBe('1');
    });
  }
});

for (const [role, path] of [['educator', '/teach'], ['platform_admin', '/admin']] as const) {
  test.describe(`signed in as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test(`${path} (under a template.tsx) is fully opaque right after navigation`, async ({ page }) => {
      await page.goto(path);
      const page_ = page.locator('main .route-enter').first();
      await expect(page_).toBeAttached();
      expect(await opacityNow(page_)).toBe('1');
    });
  });
}

test.describe('signed in as platform_admin', () => {
  test.use({ storageState: authFile('platform_admin') });

  test('the confirm dialog is at rest when it opens, and Cancel works at once', async ({ page }) => {
    await page.goto('/admin?tab=users');
    await expect(page.getByRole('tab', { name: 'Users' })).toHaveAttribute('aria-selected', 'true');
    const suspend = page.getByRole('button', { name: 'Suspend', exact: true }).first();
    await suspend.click();
    const dialog = page.getByRole('dialog', { name: /^Suspend / });
    expect(await opacityNow(dialog)).toBe('1');
    await expectAtRest(dialog);
    await dialog.getByRole('button', { name: 'Cancel' }).click({ timeout: 1000 });
    await expect(dialog).toBeHidden();
  });
});

// Phase 12b: the payment-return states and the certificate page under reduced motion.
test.describe('signed in as a learner, 12b', () => {
  test.use({ storageState: authFile('learner') });

  test('payment return: the confirmed state is at rest, and "Start learning" has focus', async ({ page }) => {
    await page.route('**/api/v1/payments/reconcile', (route) => route.fulfill({ json: { status: 'confirmed' } }));
    await page.goto('/payment/return?course_id=demo-course&tx_ref=demo-tx');
    const start = page.getByRole('link', { name: 'Start learning' });
    await expect(start).toBeFocused();
    await expectAtRest(start.locator('xpath=..'));
    await start.click({ timeout: 1000, trial: true });
  });
});

test('a valid certificate: the card and the flag band are at rest and fully opaque', async ({ page, request }) => {
  const uid = await learnerCertificateUid(request);
  await page.goto(`/verify/${uid}`);
  const card = page.locator('main .card').first();
  await expectAtRest(card);
});
