import { expect, test } from '@playwright/test';
import { authFile } from './support';

// P1-49 / P1-50 / P1-51: the shell works without a mouse.

test('on /login the skip link is the first tab stop and the email field has no duplicate stops', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('input[name="email"]')).toBeVisible();

  // Every stop from the first Tab (skip link included) up to the email field.
  // Each focused element is tagged, so the same element twice is caught, and two
  // consecutive stops with the same role and name (a link wrapping a button) are too.
  const stops: { tag: string; role: string; name: string; seen: boolean }[] = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    if (i === 0) {
      await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
      // Following the link moves focus to <main>; start the walk again from the top.
      await page.keyboard.press('Enter');
      await expect(page.locator('main#main')).toBeFocused();
      await page.goto('/login');
      await expect(page.locator('input[name="email"]')).toBeVisible();
      await page.keyboard.press('Tab');
    }
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const seen = el.hasAttribute('data-tabstop-seen');
      el.setAttribute('data-tabstop-seen', '');
      const label = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 40);
      const role = el.getAttribute('role') ?? (el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' ? 'button' : el.tagName.toLowerCase());
      return { tag: el.tagName, role, name: label || el.getAttribute('name') || '', seen };
    });
    stops.push(stop);
    if (stop.tag === 'INPUT' && stop.name === 'email') break;
  }
  const trail = stops.map((s) => `${s.role}:${s.name}`).join(' > ');
  expect(`${stops[0].role}:${stops[0].name}`, trail).toBe('link:Skip to main content');
  expect(stops.at(-1)!.name, `email field not reached: ${trail}`).toBe('email');
  expect(stops.filter((s) => s.seen), `an element took focus twice: ${trail}`).toEqual([]);
  stops.slice(1).forEach((s, i) => {
    const prev = stops[i];
    expect(!(prev.role === s.role && prev.name === s.name && s.name !== ''), `duplicate stop ${s.role}:${s.name}: ${trail}`).toBe(true);
  });
});

test.describe('375 px', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('the mobile menu opens, closes on Escape and gives focus back to the burger', async ({ page }) => {
    await page.goto('/');
    const burger = page.getByRole('button', { name: 'Menu' });
    await expect(burger).toHaveAttribute('aria-expanded', 'false');

    await burger.focus();
    await page.keyboard.press('Enter');
    await expect(burger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('mobile-menu-panel')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(burger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('mobile-menu-panel')).toHaveCount(0);
    await expect(burger).toBeFocused();
  });

  test.describe('signed in', () => {
    test.use({ storageState: authFile('learner') });

    test('the bell panel stays inside the viewport', async ({ page }) => {
      await page.goto('/');
      const bell = page.getByRole('button', { name: 'Notifications' });
      await bell.click();
      await expect(bell).toHaveAttribute('aria-expanded', 'true');

      const panel = page.locator(`[id="${await bell.getAttribute('aria-controls')}"]`);
      await expect(panel).toBeVisible();
      // Let the 150 ms scale/fade finish so the box is measured at rest.
      await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0)).toBe(375 - 32);
      const box = (await panel.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(box.x, 'left edge').toBeGreaterThanOrEqual(0);
      expect(box.y, 'top edge').toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, 'right edge').toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height, 'bottom edge').toBeLessThanOrEqual(viewport.height);

      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(bell).toBeFocused();
    });
  });
});
