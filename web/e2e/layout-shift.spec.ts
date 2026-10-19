import { expect, test } from './test';
import { firstCourseId } from './support';

// Phase 12: motion must not move the layout. Cumulative layout shift (shifts without recent
// input) stays at or under 0.05 on Home, the catalog and a course page, at 375 and 1440 px,
// after scrolling to the end so every reveal has run.
const LIMIT = 0.05;

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', 'layout-shift entries are Chromium-only');
});

for (const width of [375, 1440]) {
  test.describe(`${width} px`, { tag: '@flow' }, () => {
    test.use({ viewport: { width, height: width === 375 ? 800 : 900 } });

    for (const name of ['/', '/courses', 'a course page']) {
      test(`${name}: CLS ≤ ${LIMIT}`, async ({ page, request }) => {
        await page.addInitScript(() => {
          const w = window as unknown as { __cls: number; __clsSources: string[] };
          w.__cls = 0;
          w.__clsSources = [];
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean; sources?: { node?: Node }[] }[]) {
              if (entry.hadRecentInput) continue;
              w.__cls += entry.value;
              for (const s of entry.sources ?? []) {
                const el = s.node instanceof Element ? s.node : s.node?.parentElement;
                if (el) w.__clsSources.push(`${entry.value.toFixed(3)} ${el.tagName}.${el.getAttribute('class') ?? ''}`.slice(0, 120));
              }
            }
          }).observe({ type: 'layout-shift', buffered: true });
        });
        const path = name === 'a course page' ? `/courses/${await firstCourseId(request)}` : name;
        await page.goto(path);
        expect(await page.evaluate(() => PerformanceObserver.supportedEntryTypes), 'this browser reports layout shifts').toContain('layout-shift');
        await page.waitForLoadState('networkidle').catch(() => undefined);

        // Scroll to the end in steps so every below-the-fold reveal runs, then let them finish.
        await page.evaluate(async () => {
          const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          for (let y = 0; y < document.documentElement.scrollHeight; y += Math.floor(window.innerHeight * 0.75)) {
            window.scrollTo({ top: y, behavior: 'instant' });
            await frames();
          }
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
          await frames();
        });
        await page.waitForTimeout(500);

        const { cls, sources } = await page.evaluate(() => {
          const w = window as unknown as { __cls: number; __clsSources: string[] };
          return { cls: w.__cls, sources: w.__clsSources };
        });
        expect(cls, `layout shift on ${path}: ${sources.join(' | ')}`).toBeLessThanOrEqual(LIMIT);
      });
    }
  });
}
