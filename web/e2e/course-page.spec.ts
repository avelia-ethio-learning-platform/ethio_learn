import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from './test';
import { apiGet, authFile, BASE_URL, settle } from './support';

interface Summary {
  id: string;
  title: string;
  pricing_type: string;
  thumbnail_url?: string | null;
}

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const ETHIOPIC = /[ሀ-፿]/;
// The buy bar is the only fixed element pinned to the bottom, and it is phone-only (lg:hidden).
const BAR = '.fixed.bottom-0.lg\\:hidden';
// "Past the buy box": into the syllabus, so the box is out of view.
const toSyllabus = (page: Page) =>
  page.getByRole('heading', { name: 'Course content' }).evaluate((el) => el.scrollIntoView({ behavior: 'instant', block: 'start' }));

async function seededCourses(request: APIRequestContext): Promise<Summary[]> {
  const { items } = await apiGet<{ items: Summary[] }>(request, '/search?page=1&limit=50');
  return items;
}

/** The og:image path the page advertises (Next adds a route hash, so it is read, not guessed). */
async function ogImagePath(page: Page, courseId: string): Promise<string> {
  await page.goto(`/courses/${courseId}`);
  const content = await page.locator('meta[property="og:image"]').first().getAttribute('content');
  expect(content, 'the course page has an og:image').toBeTruthy();
  const url = new URL(content!, BASE_URL);
  expect(url.pathname).toMatch(new RegExp(`^/courses/${courseId}/opengraph-image(-\\w+)?$`));
  return url.pathname + url.search;
}

test.describe('course page at 375 px', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  // Every seeded course, so a long (three-line) title is covered too.
  test('the buy button is in the first screen', async ({ page, request }) => {
    const misses: string[] = [];
    for (const course of await seededCourses(request)) {
      await page.goto(`/courses/${course.id}`);
      const button = page.locator('#buy-box [data-primary-action]');
      await expect(button).toBeVisible();
      await settle(page);
      const box = (await button.boundingBox())!;
      if (box.y + box.height > 667) misses.push(`${course.title}: ${Math.round(box.y + box.height)} px`);
    }
    expect(misses, 'the primary button ends inside the first 375x667 screen').toEqual([]);
  });

  test('a signed-in learner on a paid course sees the buy button or the bar in the first screen', async ({ browser, request }) => {
    const enrolled = new Set((await apiGet<{ course_id: string }[]>(request, '/enrollments', 'learner')).map((e) => e.course_id));
    const course = (await seededCourses(request)).find((c) => c.pricing_type === 'paid' && !enrolled.has(c.id));
    expect(course, 'a paid course the seeded learner is not enrolled in').toBeTruthy();
    const context = await browser.newContext({ viewport: { width: 375, height: 667 }, storageState: authFile('learner'), serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await page.goto(`/courses/${course!.id}`);
      const button = page.locator('#buy-box [data-primary-action]');
      await expect(button).toBeVisible();
      await settle(page);
      const box = (await button.boundingBox())!;
      const barButton = page.locator(BAR).getByRole('button');
      if (box.y + box.height > 667) await expect(barButton, 'the button is below the fold, so the bar shows').toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('the bottom bar appears past the buy box and takes you back to it', async ({ page, request }) => {
    const [course] = await seededCourses(request);
    await page.goto(`/courses/${course.id}`);
    const button = page.locator('#buy-box [data-primary-action]');
    await expect(button).toBeVisible();
    await settle(page);
    await button.scrollIntoViewIfNeeded();
    await expect(page.locator(BAR), 'no bar while the buy box is in view').toBeHidden();

    await toSyllabus(page);
    const bar = page.locator(BAR);
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('button')).toHaveText((await button.textContent())!.trim());
    await bar.getByRole('button').click();
    await expect(button).toBeFocused();
  });

  test('the bottom bar and the "waking up" notice do not overlap', async ({ browser, request }) => {
    const [course] = await seededCourses(request);
    // The learner's login makes the enroll panel ask for the enrollment status; holding that
    // call back past 4 s is what makes the notice appear (lib/waking.ts), without touching the server.
    const context = await browser.newContext({ viewport: { width: 375, height: 667 }, storageState: authFile('learner'), serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await page.route('**/enrollments/status**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 7_000));
        await route.continue().catch(() => undefined);
      });
      await page.goto(`/courses/${course.id}`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await toSyllabus(page);
      const bar = page.locator(BAR);
      await expect(bar).toBeVisible();
      const notice = page.getByText('Waking up the server');
      await expect(notice).toBeVisible({ timeout: 6_000 });
      const [a, b] = [(await bar.boundingBox())!, (await notice.boundingBox())!];
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlap, `bar ${JSON.stringify(a)} vs notice ${JSON.stringify(b)}`).toBe(false);
    } finally {
      await context.close();
    }
  });
});

// P1-36: a course without a real thumbnail gets the generated cover. The demo seed gives every
// course a placehold.co thumbnail on purpose (A1), which counts as missing.
test('seeded courses show the generated cover, on the card and on the course page', async ({ page, request }) => {
  const courses = await seededCourses(request);
  const course = courses.find((c) => ETHIOPIC.test(c.title)) ?? courses[0];
  expect(course.thumbnail_url ?? '', 'the seed keeps its placehold.co thumbnail').toMatch(/placehold\.co|^$/);

  await page.goto(`/courses/${course.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(course.title);
  await expect(page.locator('img[src*="placehold.co"]')).toHaveCount(0);
  const header = page.locator('main header').first();
  await expect(header.locator('[lang="am"]'), 'the Amharic category label on the cover').toBeVisible();
  await expect(header.getByText(course.title, { exact: true }), 'the cover and the h1 both carry the full title').toHaveCount(2);

  // Searched for by title: the catalog's first page may not include it.
  await page.goto(`/courses?q=${encodeURIComponent(course.title)}`);
  // The card's cover is decorative (aria-hidden): the title is also its h3. It still draws the title and the Amharic label.
  const card = page.locator(`a[href="/courses/${course.id}"]`).first();
  await expect(card.locator('[lang="am"]').first(), 'the Amharic category label on the card cover').toBeVisible();
  await expect(card.getByText(course.title, { exact: true }), 'the cover and the h3 both carry the full title').toHaveCount(2);
  await expect(page.locator('img[src*="placehold.co"]')).toHaveCount(0);
});

// P1-36: every course page has its own 1200x630 PNG card.
test.describe('Open Graph image', () => {
  const PNG_SIGNATURE = '89504e470d0a1a0a';

  async function expectPng(request: APIRequestContext, imagePath: string, cacheControl: string) {
    const res = await request.get(`${BASE_URL}${imagePath}`);
    expect(res.status(), imagePath).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
    expect(res.headers()['cache-control']).toBe(cacheControl);
    const body = await res.body();
    expect(body.subarray(0, 8).toString('hex'), 'a PNG').toBe(PNG_SIGNATURE);
    expect([body.readUInt32BE(16), body.readUInt32BE(20)], 'width and height').toEqual([1200, 630]);
    return body;
  }

  test('a course page advertises its card, and the card is a 1200x630 PNG', async ({ page, request }) => {
    const [course] = await seededCourses(request);
    const imagePath = await ogImagePath(page, course.id);
    await expect(page.locator('meta[name="twitter:image"]').first()).toHaveAttribute('content', /\/opengraph-image/);
    await expectPng(request, imagePath, 'public, max-age=86400, stale-while-revalidate=604800');
  });

  test('a course that does not exist gets the site card, cached for five minutes', async ({ page, request }) => {
    const [course] = await seededCourses(request);
    const imagePath = (await ogImagePath(page, course.id)).replace(course.id, UNKNOWN_ID);
    await expectPng(request, imagePath, 'public, max-age=300');
  });

  test('the Amharic-titled course renders its card (saved for review)', async ({ page, request }) => {
    const amharic = (await seededCourses(request)).find((c) => ETHIOPIC.test(c.title));
    expect(amharic, 'the demo seed has a course with an Amharic title (scripts/demo-seed.mjs)').toBeTruthy();
    const png = await expectPng(request, await ogImagePath(page, amharic!.id), 'public, max-age=86400, stale-while-revalidate=604800');
    const folder = path.join(__dirname, '..', '..', 'docs', 'plans', '2026-10-02-refinement-audit', 'screenshots', 'after-phase7b');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'og-image-amharic-course.png'), png);
  });
});
