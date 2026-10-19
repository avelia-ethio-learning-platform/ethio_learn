import { expect, test, type Page } from './test';
import { apiGet, firstCourseId, headerBottom, horizontalOverflow, ownCourseId, settle } from './support';

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
        test.use({ loggedInAs: 'learner' });

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
    test.use({ loggedInAs: 'educator' });

    test('teaching dashboard', async ({ page }) => {
      await page.goto('/teach');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle'); // measure once the panels have loaded
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('"New course" sits fully inside the viewport', async ({ page }) => {
      await page.goto('/teach');
      const box = await page.getByRole('link', { name: 'New course' }).first().boundingBox();
      expect(box, 'the New course link is rendered').not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    });

    test('course editor', async ({ page, request }) => {
      await page.goto(`/teach/courses/${await ownCourseId(request)}`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle'); // measure once the panels have loaded
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });

  test.describe('institution admin', () => {
    test.use({ loggedInAs: 'institution_admin' });

    test('/institution', async ({ page }) => {
      await page.goto('/institution');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle'); // measure once the panels have loaded
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });

  test.describe('platform admin', () => {
    test.use({ loggedInAs: 'platform_admin' });

    test('/admin', async ({ page }) => {
      await page.goto('/admin');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle'); // measure once the panels have loaded
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
  });

  test.describe('learner', () => {
    test.use({ loggedInAs: 'learner' });

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

// The signed-in phone header (logo, Messages, bell, burger at 44 px each) was never measured below 375 px.
// Signed in at the narrowest phones: no sideways scroll, every header control inside the pill's padding box
// (not eating its edge padding), room between the logo and the next control, and the open menu's footer row
// inside its panel. English and Amharic.
for (const width of [320, 360]) {
  for (const locale of ['en', 'am'] as const) {
    test.describe(`signed-in mobile header at ${width} px, ${locale}`, () => {
      test.use({ viewport: { width, height: 800 }, loggedInAs: 'learner' });

      test('fits without overflow, clipping or crowding', async ({ page }) => {
        await page.addInitScript((l) => localStorage.setItem('el_locale', l), locale);
        await page.goto('/courses');
        const nav = page.locator('nav[aria-label="Main"]');
        const burger = nav.locator('.lg\\:hidden > button[aria-controls]');
        await expect(burger).toBeVisible();
        // The bell (and Messages, when it fits) join the burger once the session refresh resolves.
        await expect.poll(() => nav.locator('.lg\\:hidden > *').count()).toBeGreaterThanOrEqual(3);
        await settle(page);
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

        const geometry = () =>
          nav.evaluate((el) => {
            const bar = el.querySelector(':scope > div')!;
            const cs = getComputedStyle(bar);
            const inner = bar.getBoundingClientRect();
            const left = inner.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
            const right = inner.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
            const boxes = [...bar.querySelectorAll('a, button')]
              .map((c) => ({ c, r: c.getBoundingClientRect() }))
              .filter(({ r }) => r.width > 0 && r.height > 0)
              .map(({ c, r }) => ({ name: (c.getAttribute('aria-label') || c.textContent || '').trim().slice(0, 20), left: r.left, right: r.right, height: r.height, width: r.width }))
              .sort((a, b) => a.left - b.left);
            return { left, right, boxes, vw: document.documentElement.clientWidth };
          });

        const check = async (what: string) => {
          const g = await geometry();
          expect(g.boxes.length, `${what}: logo, bell and burger at least`).toBeGreaterThanOrEqual(3);
          for (const b of g.boxes) {
            expect(b.left, `${what}: ${b.name} starts inside the pill's padding`).toBeGreaterThanOrEqual(g.left - 0.5);
            expect(b.right, `${what}: ${b.name} ends inside the pill's padding`).toBeLessThanOrEqual(g.right + 0.5);
            expect(b.right, `${what}: ${b.name} inside the viewport`).toBeLessThanOrEqual(g.vw);
          }
          for (let i = 1; i < g.boxes.length; i++) {
            expect(g.boxes[i].left - g.boxes[i - 1].right, `${what}: ${g.boxes[i - 1].name} and ${g.boxes[i].name} keep a gap`).toBeGreaterThanOrEqual(4);
          }
          return g;
        };

        const closed = await check('closed');
        // Touch targets stay 44 px (12a), whichever controls fit.
        for (const b of closed.boxes.slice(1)) {
          expect(b.width, `${b.name} width`).toBeGreaterThanOrEqual(44);
          expect(b.height, `${b.name} height`).toBeGreaterThanOrEqual(44);
        }

        await burger.click();
        const panel = page.getByTestId('mobile-menu-panel');
        await expect(panel).toBeVisible();
        await settle(page);
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
        const bounds = await panel.evaluate((p) => {
          const pr = p.getBoundingClientRect();
          const footer = [...p.querySelectorAll(':scope > div:last-child a, :scope > div:last-child button')].map((c) => {
            const r = c.getBoundingClientRect();
            return { name: (c.textContent || c.getAttribute('aria-label') || '').trim().slice(0, 20), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          });
          return { left: pr.left, right: pr.right, scroll: p.scrollWidth - p.clientWidth, footer };
        });
        expect(bounds.scroll, 'the menu panel does not scroll sideways').toBeLessThanOrEqual(0);
        expect(bounds.footer.length, 'language, theme and log-out controls').toBeGreaterThanOrEqual(3);
        for (const f of bounds.footer) {
          expect(f.left, `${f.name} inside the panel`).toBeGreaterThanOrEqual(bounds.left);
          expect(f.right, `${f.name} inside the panel`).toBeLessThanOrEqual(bounds.right);
        }
      });
    });
  }
}

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
