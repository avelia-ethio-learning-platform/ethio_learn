import { expect, test } from '@playwright/test';
import { apiGet } from './support';

// P1-53 / P1-54: every route has its own title and exactly one robots
// directive, signed-in and utility pages are noindex, and the share image
// survives on pages that set their own openGraph. The checks read the server
// HTML (what a crawler sees), so they need no login and spend no auth call.

const DEFAULT_TITLE = 'EthiopiaLearn — Learn skills from Ethiopian experts';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

/** [path, text the title must contain, noindex?]. */
const ROUTES: [string, string, boolean][] = [
  ['/', 'Online courses from Ethiopian educators', false],
  ['/courses', 'Browse courses', false],
  ['/educators', 'Top educators', false],
  ['/help', 'Help and support', false],
  ['/login', 'Log in', false],
  ['/signup', 'Create your account', false],
  ['/verify', 'Verify a certificate', false],
  ['/reset-password', 'Reset your password', true],
  ['/verify-email', 'Verify your email', true],
  ['/accept-invite', 'Accept your invitation', true],
  ['/payment/return', 'Payment status', true],
  ['/pay/some-token', 'Pay for a course', true],
  ['/dev/checkout', 'Test checkout', true],
  ['/dashboard', 'Your learning', true],
  ['/messages', 'Messages', true],
  ['/account', 'Your account', true],
  ['/account/password', 'Change password', true],
  ['/account/invites', 'Institutions', true],
  ['/notifications', 'Notifications', true],
  ['/notifications/preferences', 'Notification preferences', true],
  [`/learn/${UNKNOWN_ID}`, 'Learn', true],
  [`/learn/${UNKNOWN_ID}/exam/${UNKNOWN_ID}`, 'Exam', true],
  ['/teach', 'Teach', true],
  ['/teach/new', 'Create a course', true],
  ['/teach/coupons', 'Coupons', true],
  ['/teach/analytics', 'Teaching analytics', true],
  [`/teach/courses/${UNKNOWN_ID}`, 'Edit course', true],
  ['/institution', 'Institution', true],
  ['/admin', 'Admin', true],
  ['/qa', 'Quality review', true],
  [`/preview/${UNKNOWN_ID}`, 'Course preview', true],
  ['/offline', 'You are offline', true],
];

const metaTags = (html: string, attr: 'name' | 'property', key: string) =>
  (html.match(/<meta\s[^>]*>/g) ?? [])
    .filter((tag) => new RegExp(`${attr}="${key}"`).test(tag));

test.describe('titles and robots', () => {
  for (const [path, title, noindex] of ROUTES) {
    test(`${path} has its own title and one robots meta${noindex ? ' (noindex)' : ''}`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      const html = await res.text();

      const found = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
      expect(found, path).toContain(title);
      expect(found, path).not.toBe(DEFAULT_TITLE);

      const robots = metaTags(html, 'name', 'robots');
      expect(robots, `${path}: ${robots.join(' ')}`).toHaveLength(1);
      if (noindex) expect(robots[0], path).toContain('noindex');
      else expect(robots[0], path).not.toContain('noindex');
    });
  }
});

test.describe('share image', () => {
  const expectShareImages = (html: string, where: string) => {
    for (const [attr, key] of [['property', 'og:image'], ['name', 'twitter:image']] as const) {
      const tags = metaTags(html, attr, key);
      expect(tags.length, `${where}: ${key}`).toBeGreaterThanOrEqual(1);
      expect(tags[0], `${where}: ${key} has a url`).toMatch(/content="[^"]+"/);
    }
  };

  test('the home page has og:image and twitter:image', async ({ request }) => {
    expectShareImages(await (await request.get('/')).text(), '/');
  });

  // The no-thumbnail fallback is covered by the unit test next to the course
  // page (the seed gives every course a thumbnail, and server-generated
  // metadata can't be stubbed from the browser).
  test('a course page has og:image and twitter:image', async ({ request }) => {
    const { items } = await apiGet<{ items: { id: string }[] }>(request, '/search?page=1&limit=1');
    const html = await (await request.get(`/courses/${items[0].id}`)).text();
    expectShareImages(html, `/courses/${items[0].id}`);
  });
});
