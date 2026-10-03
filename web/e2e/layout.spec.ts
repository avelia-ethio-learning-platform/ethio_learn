import { expect, test, type Page } from '@playwright/test';
import { apiGet, authFile, firstCourseId, headerBottom, horizontalOverflow, settle } from './support';

const WIDTHS = [375, 1440];

async function expectH1BelowHeader(page: Page, path: string) {
  await page.goto(path);
  const h1 = page.getByRole('heading', { level: 1 }).first();
  await expect(h1).toBeVisible();
  await settle(page);
  const bottom = await headerBottom(page);
  const top = (await h1.boundingBox())!.y;
  expect(top, `${path}: h1 top ${top}px vs header bottom ${bottom}px`).toBeGreaterThanOrEqual(bottom);
}

// P0-13: no page renders content under the fixed header, at any width.
test.describe('nothing under the fixed header', () => {
  for (const width of WIDTHS) {
    test.describe(`${width}px`, () => {
      test.use({ viewport: { width, height: 900 } });

      test('public pages', async ({ page, request }) => {
        const [educator] = await apiGet<{ educator_id: string }[]>(request, '/educators/top?limit=1');
        for (const path of ['/help', '/educators', `/educators/${educator.educator_id}`]) {
          await expectH1BelowHeader(page, path);
        }
      });

      test.describe('learner pages', () => {
        test.use({ storageState: authFile('learner') });

        test('messages, notification preferences and the exam', async ({ page, request }) => {
          const courseId = await firstCourseId(request);
          // The exam's preflight renders for any assessment id.
          for (const path of ['/messages', '/notifications/preferences', `/learn/${courseId}/exam/00000000-0000-4000-8000-000000000000`]) {
            await expectH1BelowHeader(page, path);
          }
        });
      });
    });
  }
});

// P0-14: nothing scrolls or is cut off sideways at 375 px.
test.describe('no sideways overflow at 375 px', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('home, catalog and course page', async ({ page, request }) => {
    const courseId = await firstCourseId(request);
    for (const path of ['/', '/courses', `/courses/${courseId}`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
    }
  });

  test.describe('educator', () => {
    test.use({ storageState: authFile('educator') });

    test('teaching dashboard', async ({ page }) => {
      await page.goto('/teach');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });

  test.describe('learner', () => {
    test.use({ storageState: authFile('learner') });

    test('lesson page', async ({ page, request }) => {
      const enrollments = await apiGet<{ course_id: string }[]>(request, '/enrollments', 'learner');
      expect(enrollments.length, 'the seeded learner is enrolled (scripts/demo-seed.mjs)').toBeGreaterThan(0);
      await page.goto(`/learn/${enrollments[0].course_id}`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      // An h1 also shows on "not enrolled" and "not found": make sure the player itself rendered.
      await expect(page.getByRole('button', { name: /^(Start lesson 1|Resume: )/ })).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });
});

// P1-58: position: sticky works again (overflow-x: clip, not hidden).
test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 800 } });

  test('the enroll card stays in view while the course page scrolls', async ({ page, request }) => {
    await page.goto(`/courses/${await firstCourseId(request)}`);
    const card = page.getByRole('complementary').locator(':scope > div').first();
    await expect(card).toBeVisible();
    await settle(page);
    await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }));
    expect(await page.evaluate(() => window.scrollY), 'the page scrolled').toBeGreaterThan(300);
    // top-28 = 112 px from the viewport top while it sticks.
    await expect.poll(async () => Math.round((await card.boundingBox())!.y)).toBe(112);
    // The phone-only bottom bar stays hidden at this width.
    await expect(page.locator('.fixed.bottom-0.lg\\:hidden')).toBeHidden();
  });
});

// P0-15: the mobile menu panel is opaque, and a tap outside closes it.
test.describe('mobile menu at 375 px', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('opaque panel, closed by tapping the backdrop', async ({ page }) => {
    await page.goto('/courses');
    await page.getByRole('button', { name: 'Menu' }).click();
    const panel = page.getByTestId('mobile-menu-panel');
    await expect(panel).toBeVisible();
    const alpha = await panel.evaluate((el) => {
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
      const parts = m ? m[1].split(',').map((p) => p.trim()) : [];
      return parts.length === 4 ? Number(parts[3]) : parts.length === 3 ? 1 : 0;
    });
    expect(alpha).toBe(1);
    await page.getByTestId('menu-backdrop').click({ position: { x: 20, y: 700 } });
    await expect(panel).toBeHidden();
  });
});
