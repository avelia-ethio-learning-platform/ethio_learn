import { expect, test } from '@playwright/test';
import { apiGet } from './support';

const UUID_LINK = /^\/courses\/[0-9a-f-]{36}$/;

// P2-22: the sort select is kept in the URL and reorders the results.
test('Newest puts sort=new in the URL and reorders the catalog', async ({ page, request }) => {
  const ids = async (query: string) => (await apiGet<{ items: { id: string }[] }>(request, `/search?${query}`)).items.map((c) => c.id);
  const [top, newest] = [await ids('page=1&limit=12'), await ids('sort=new&page=1&limit=12')];
  expect(newest, 'the seed has an order for "new" that differs from "top"').not.toEqual(top);

  const shown = () =>
    page.locator('main a[href^="/courses/"]').evaluateAll(
      (links, pattern) => links.map((a) => a.getAttribute('href') ?? '').filter((h) => new RegExp(pattern).test(h)).map((h) => h.split('/')[2]),
      UUID_LINK.source,
    );
  await page.goto('/courses');
  await expect.poll(shown).toEqual(top);

  await page.getByLabel('Sort by').selectOption({ label: 'Newest' });
  await expect(page).toHaveURL(/[?&]sort=new(&|$)/);
  await expect.poll(shown).toEqual(newest);

  // The default sort is not written to the URL.
  await page.getByLabel('Sort by').selectOption({ label: 'Recommended' });
  await expect(page).toHaveURL((url) => !url.searchParams.has('sort'));
  await expect.poll(shown).toEqual(top);
});

// P1-32: a dead end gives a way forward.
test('an unknown page shows the branded 404 with a course search', async ({ page }) => {
  const res = await page.goto('/does-not-exist');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: "We couldn't find that page" })).toBeVisible();
  await page.getByRole('search').getByLabel('Search courses').fill('excel');
  await page.getByRole('search').getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/courses\?q=excel$/);
});
