import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from './test';
import { apiGet, authFile, BASE_URL, firstCourseId, learnerCertificateUid, ownCourseId, seedPassword, settle } from './support';

// Decision 12: zero serious or critical axe violations (WCAG 2.0/2.1 A and AA)
// on the public, learner and account pages, in light and dark, at 1440 px.
// The learner pages reuse the stored learner login; nothing here logs in.

test.use({ viewport: { width: 1440, height: 900 } });

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/**
 * Violations that belong to a later phase. Each entry is scoped to one rule and
 * one selector (the node's axe target, joined by spaces) and names the phase that owns it. Empty means nothing is waived.
 */
const KNOWN: { rule: string; selector: string; owner: string }[] = [];

async function prefer(page: Page, theme: Theme) {
  // Applied before the page's own theme script runs (lib/theme-script.ts).
  await page.addInitScript((t) => localStorage.setItem('el_theme', t), theme);
  await page.emulateMedia({ colorScheme: theme });
}

/**
 * Scrolls down the page in steps so every below-the-fold `whileInView` reveal
 * plays (axe skips content still at opacity 0), then back to the top.
 */
async function revealAll(page: Page) {
  await page.evaluate(async () => {
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const step = Math.floor(window.innerHeight * 0.75);
    for (let y = step; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await frames();
    }
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    await frames();
    window.scrollTo({ top: 0, behavior: 'instant' });
    await frames();
  });
  await settle(page);
  // framer drives its reveals from JS, which getAnimations() doesn't list: wait until none is part-faded.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            Array.from(document.querySelectorAll<HTMLElement>('main [style*="opacity"]')).filter(
              (el) => el.getClientRects().length > 0 && Number(getComputedStyle(el).opacity) < 1,
            ).length,
        ),
      { message: 'every below-the-fold reveal has finished' },
    )
    .toBe(0);
}

async function scan(page: Page, where: string) {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await settle(page);
  await revealAll(page);
  await analyze(new AxeBuilder({ page }), where);
}

async function analyze(builder: AxeBuilder, where: string) {
  const { violations } = await builder.withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();

  // A KNOWN entry waives one rule on one selector, never the rule or the page.
  const waived = (rule: string, target: string) => KNOWN.some((k) => k.rule === rule && k.selector === target);
  const blocking = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ ...v, nodes: v.nodes.filter((n) => !waived(v.id, n.target.join(' '))) }))
    .filter((v) => v.nodes.length > 0);
  const summary = blocking.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(' | ')}`,
  );
  expect(summary, `${where}: serious/critical axe violations`).toEqual([]);
}

async function scanVisit(page: Page, path: string, theme: Theme) {
  await page.goto(path);
  await scan(page, `${path} (${theme})`);
}

async function pages(request: APIRequestContext) {
  const { items } = await apiGet<{ items: { id: string; pricing_type: string }[] }>(request, '/search?page=1&limit=50');
  const free = items.find((c) => c.pricing_type === 'free' || c.pricing_type === 'freemium');
  const paid = items.find((c) => c.pricing_type === 'paid');
  expect(free, 'the seed has a free or freemium course').toBeTruthy();
  expect(paid, 'the seed has a paid course').toBeTruthy();
  return { free: free!.id, paid: paid!.id, certificate: await learnerCertificateUid(request) };
}

for (const theme of THEMES) {
  test.describe(`${theme} mode`, () => {
    test.beforeEach(async ({ page }) => prefer(page, theme));

    test.describe('public pages', () => {
      // Split in two: the course pages' scans alone take ~10 s, and all six together came within 3 s of the 30 s timeout.
      test('home, catalog, help, educators', async ({ page }) => {
        for (const path of ['/', '/courses', '/help', '/educators']) {
          await scanVisit(page, path, theme);
        }
      });

      test('a free and a paid course', async ({ page, request }) => {
        const ids = await pages(request);
        for (const path of [`/courses/${ids.free}`, `/courses/${ids.paid}`]) {
          await scanVisit(page, path, theme);
        }
      });

      test('the 404 page and the verify-email error state', async ({ page }) => {
        // /verify-email without a token is the error state: no API call, so no login budget.
        for (const path of ['/does-not-exist', '/verify-email']) {
          await scanVisit(page, path, theme);
        }
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('Verification failed');
        await expect(page.getByRole('button', { name: 'Resend email' })).toBeVisible();
      });

      test('login, signup, reset-password, /verify and a certificate', async ({ page, request }) => {
        const ids = await pages(request);
        for (const path of ['/login', '/signup', '/reset-password', '/verify', `/verify/${ids.certificate}`]) {
          await scanVisit(page, path, theme);
        }
      });

      test('/login after a wrong password', async ({ page }) => {
        // Answered here, not by the gateway: every real POST /auth/login spends
        // one of the 10 auth-strict calls a minute (see playwright.config.ts).
        // The body is the one auth answers with (Nest's UnauthorizedException).
        const cors = { 'access-control-allow-origin': BASE_URL, 'access-control-allow-credentials': 'true' };
        await page.route('**/api/v1/auth/login', (route) =>
          route.request().method() === 'OPTIONS'
            ? route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } })
            : route.fulfill({
                status: 401,
                contentType: 'application/json',
                headers: cors,
                body: JSON.stringify({ statusCode: 401, message: 'Invalid email or password', error: 'Unauthorized' }),
              }),
        );
        await page.goto('/login');
        await page.locator('input[name="email"]').fill('learner@ethiopialearn.et');
        await page.locator('input[name="password"]').fill(`${seedPassword()}-wrong`);
        await page.getByRole('button', { name: 'Log in' }).click();
        await expect(page.getByRole('alert').filter({ hasText: 'Invalid email or password' })).toBeVisible();
        await scan(page, `/login after a wrong password (${theme})`);
      });
    });

    test.describe('course page at 375 px', () => {
      test.use({ viewport: { width: 375, height: 800 } });

      test('with the bottom bar showing', async ({ page, request }) => {
        const { paid } = await pages(request);
        await scanVisit(page, `/courses/${paid}`, theme);
        // Past the buy box the fixed bottom bar appears; scan it too.
        const bar = page.locator('.fixed.bottom-0.lg\\:hidden');
        await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
        await expect(bar).toBeVisible();
        await analyze(new AxeBuilder({ page }), `/courses/${paid} with the bottom bar (${theme})`);
      });
    });

    test.describe('admin console', () => {
      test.use({ storageState: authFile('platform_admin') });

      // Split in two: each tab scan waits for its data and the reveals, and six together are close to the 30 s timeout.
      test('analytics, payments, users', async ({ page }) => {
        for (const tab of ['analytics', 'payments', 'users']) {
          await scanVisit(page, `/admin?tab=${tab}`, theme);
        }
      });

      test('coupons, wallet, broadcast', async ({ page }) => {
        for (const tab of ['coupons', 'wallet', 'broadcast']) {
          await scanVisit(page, `/admin?tab=${tab}`, theme);
        }
      });
    });

    test.describe('educator pages', () => {
      test.use({ storageState: authFile('educator') });

      test('teach, new course, analytics, coupons', async ({ page }) => {
        for (const path of ['/teach', '/teach/new', '/teach/analytics', '/teach/coupons']) {
          await scanVisit(page, path, theme);
        }
      });

      test('the editor of a draft', async ({ page, request }) => {
        await scanVisit(page, `/teach/courses/${await ownCourseId(request)}`, theme);
      });
    });

    test.describe('institution pages', () => {
      test.use({ storageState: authFile('institution_admin') });

      test('institution, review', async ({ page }) => {
        for (const path of ['/institution', '/institution/review']) {
          await scanVisit(page, path, theme);
        }
      });
    });

    test.describe('quality pages', () => {
      test.use({ storageState: authFile('quality_officer') });

      test('qa', async ({ page }) => {
        await scanVisit(page, '/qa', theme);
      });
    });

    test.describe('preview', () => {
      test.use({ storageState: authFile('platform_admin') });

      test('a seeded course as the admin sees it', async ({ page, request }) => {
        await scanVisit(page, `/preview/${await firstCourseId(request)}`, theme);
      });
    });

    test.describe('learner pages', () => {
      test.use({ storageState: authFile('learner') });

      test('dashboard, account, change password, notifications', async ({ page }) => {
        for (const path of ['/dashboard', '/account', '/account/password', '/notifications']) {
          await scanVisit(page, path, theme);
        }
      });

      test('lesson player, empty state', async ({ page, request }) => {
        const enrollments = await apiGet<{ course_id: string }[]>(request, '/enrollments', 'learner');
        expect(enrollments.length, 'the seeded learner is enrolled (scripts/demo-seed.mjs)').toBeGreaterThan(0);
        const path = `/learn/${enrollments[0].course_id}`;
        await page.goto(path);
        // The Start/Resume button proves this is the player, not a "not enrolled" or loading card.
        await expect(page.getByRole('button', { name: /^(Start lesson 1|Resume: )/ })).toBeVisible();
        await expect(page.locator('video')).toHaveCount(0);
        await scan(page, `${path} empty state (${theme})`);
      });
    });
  });
}

// The skip link is sr-only until focused, so the page scans above never see it.
// Its colours don't depend on the theme; dark mode is where it once failed.
test.describe('dark mode, skip link focused', () => {
  test.beforeEach(async ({ page }) => prefer(page, 'dark'));

  test('the focused skip link has no serious or critical violations', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await settle(page);
    await analyze(new AxeBuilder({ page }).include('a[href="#main"]'), '/login skip link (dark)');
  });
});

