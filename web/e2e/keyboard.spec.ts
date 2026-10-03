import { expect, test } from '@playwright/test';
import { authFile } from './support';

// P1-49 / P1-50 / P1-51: the shell works without a mouse.

test('on /login the skip link is the first tab stop and the email field has no duplicate stops', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('input[name="email"]')).toBeVisible();

  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();

  // From <main>, Tab walks forward to the email field: every stop is a new element.
  const stops: string[] = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return '';
      const siblings = el.parentElement ? Array.from(el.parentElement.children).indexOf(el) : 0;
      return `${el.tagName}|${el.getAttribute('name') ?? ''}|${(el.textContent ?? '').trim().slice(0, 30)}|${siblings}|${el.getAttribute('href') ?? ''}`;
    });
    stops.push(stop);
    if (stop.startsWith('INPUT|email|')) break;
  }
  expect(stops.at(-1), `tab stops: ${stops.join(' > ')}`).toMatch(/^INPUT\|email\|/);
  expect(new Set(stops).size, `duplicate stops: ${stops.join(' > ')}`).toBe(stops.length);
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
