import { expect, test } from './test';

// Phase 10: in Amharic mode a new learner's path is in Amharic. Every visible text node on the
// signup page is checked for Latin letters; ALLOWED is what stays Latin on purpose.
const ALLOWED = [
  'Ethiopia', // the brand, split in two spans in the header and footer
  'Learn',
  'EN', // the language toggle names the other language in that language
];

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
  expect(latin.filter((text) => !ALLOWED.includes(text))).toEqual([]);
});
