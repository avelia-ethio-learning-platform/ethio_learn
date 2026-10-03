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

  test('the theme menu inside the mobile menu opens fully on screen, not clipped by the panel', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Menu' }).click();
    const panel = page.getByTestId('mobile-menu-panel');
    await expect(panel).toBeVisible();
    // Wait for the menu's 250 ms height reveal: until it ends, the wrapper clips the panel itself.
    await expect
      .poll(() =>
        panel.evaluate((el) => {
          const wrapper = el.parentElement!;
          return getComputedStyle(wrapper).opacity === '1' && Math.abs(wrapper.getBoundingClientRect().height - el.getBoundingClientRect().height) < 1;
        }),
      )
      .toBe(true);

    const trigger = panel.getByRole('button', { name: 'Theme' });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`);
    await expect(menu).toBeVisible();
    // Measure at rest, after the 150 ms scale/fade.
    await expect
      .poll(() =>
        menu.evaluate((el) => {
          const s = getComputedStyle(el);
          return s.opacity === '1' && (s.transform === 'none' || s.transform === 'matrix(1, 0, 0, 1, 0, 0)');
        }),
      )
      .toBe(true);

    const box = (await menu.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.height, 'menu height').toBeGreaterThan(0);
    expect(box.x, 'left edge').toBeGreaterThanOrEqual(0);
    expect(box.y, 'top edge').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'right edge').toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height, 'bottom edge').toBeLessThanOrEqual(viewport.height);

    // toBeVisible() and the box ignore an ancestor's overflow clipping, so check
    // that each option is what the browser actually hits at its centre.
    for (const name of ['Light', 'Dark', 'System']) {
      const option = menu.getByRole('button', { name });
      const b = (await option.boundingBox())!;
      const hit = await option.evaluate(
        (el, [x, y]) => el.contains(document.elementFromPoint(x, y)),
        [b.x + b.width / 2, b.y + b.height / 2] as [number, number],
      );
      expect(hit, `the ${name} option is on screen, not clipped`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
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
