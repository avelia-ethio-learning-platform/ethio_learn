import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiGet, authFile, BASE_URL, learnerCertificateUid, seedPassword, settle } from './support';

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

async function scan(page: Page, where: string) {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await settle(page);

  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();

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
      test('home, catalog, free and paid course, help, educators', async ({ page, request }) => {
        const ids = await pages(request);
        for (const path of ['/', '/courses', `/courses/${ids.free}`, `/courses/${ids.paid}`, '/help', '/educators']) {
          await scanVisit(page, path, theme);
        }
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

    test.describe('learner pages', () => {
      test.use({ storageState: authFile('learner') });

      test('dashboard, lesson player, account, change password, notifications', async ({ page, request }) => {
        const enrollments = await apiGet<{ course_id: string }[]>(request, '/enrollments', 'learner');
        expect(enrollments.length, 'the seeded learner is enrolled (scripts/demo-seed.mjs)').toBeGreaterThan(0);
        for (const path of ['/dashboard', `/learn/${enrollments[0].course_id}`, '/account', '/account/password', '/notifications']) {
          await scanVisit(page, path, theme);
        }
      });
    });
  });
}
