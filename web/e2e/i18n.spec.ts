import { expect, test } from './test';

// Phase 10: in Amharic mode a new learner's path is in Amharic. Every visible text node on the
// signup page is checked for Latin letters, after taking out the names that stay Latin on purpose.
const NAMES = /EthiopiaLearn|Ethiopia|Learn|Chapa|\bEN\b/g; // the brand, the payment provider, the toggle's "EN"

test('in Amharic mode the signup page has no English text', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('el_locale', 'am'));
  await page.goto('/signup');
  await expect(page.locator('html')).toHaveAttribute('lang', 'am');
  // The Amharic strings load after hydration; the heading switching means they are in.
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/[A-Za-z]/);

  const latin = await page.evaluate(() => {
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      const text = node.textContent?.trim() ?? '';
      if (!el || !/[A-Za-z]/.test(text) || el.closest('script, style, noscript') || !el.checkVisibility()) continue;
      found.push(text);
    }
    return found;
  });
  expect(latin.filter((text) => /[A-Za-z]/.test(text.replace(NAMES, '')))).toEqual([]);
});
