import { expect, test } from '@playwright/test';

// P1-57: with reduced motion on, the hero heading is fully opaque at first
// paint, not faded in after hydration.
test.use({ reducedMotion: 'reduce' });

test('the home hero heading is opaque at first paint', async ({ page }) => {
  // Record the heading's effective opacity (its own times every ancestor's) the
  // moment the browser reports first-contentful-paint.
  await page.addInitScript(() => {
    const effectiveOpacity = (el: Element | null) => {
      let o = 1;
      for (; el; el = el.parentElement) o *= Number(getComputedStyle(el).opacity);
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
