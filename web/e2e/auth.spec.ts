import { expect, test, type Page, type Response } from './test';
import { API_URL, BASE_URL, ROLES, seedPassword, signIn, WEB_PORT } from './support';

// Phase 11b: the access token lives in memory, the refresh cookie is
// first-party on the web host, and sessions survive reloads, tabs, a password
// change and arriving from another site.
const signedIn = (page: Page) => expect(page.getByRole('button', { name: 'Log out' }).first()).toBeVisible();
const isRefresh = (res: Response) => res.url() === `${BASE_URL}/api/v1/auth/refresh`;

test.describe('signed in', () => {
  test.use({ loggedInAs: 'learner' });

  test('a reload keeps the learner signed in, and no access token is stored', async ({ page }) => {
    await page.goto('/dashboard');
    await signedIn(page);
    const refresh = page.waitForResponse(isRefresh);
    await page.reload();
    expect((await refresh).status()).toBe(200);
    await signedIn(page);
    const stored = await page.evaluate(() => Object.entries(localStorage).map(([k, v]) => `${k}=${v}`));
    expect(stored.some((s) => s.startsWith('el_auth='))).toBe(false);
    expect(stored.filter((s) => /eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(s)), 'no JWT in localStorage').toEqual([]);
    // The rotated refresh cookie: HttpOnly, Lax, scoped to the auth routes.
    const cookies = (await page.context().cookies()).filter((c) => c.name === 'el_refresh');
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api/v1/auth' });
  });

  test('two tabs booting at once both stay signed in, with no rejected refresh', async ({ page }) => {
    const second = await page.context().newPage();
    const statuses: number[] = [];
    for (const p of [page, second]) p.on('response', (res) => isRefresh(res) && statuses.push(res.status()));
    await Promise.all([page.goto('/dashboard'), second.goto('/dashboard')]);
    await Promise.all([signedIn(page), signedIn(second)]);
    // Serialized by the Web Lock: the second tab refreshes after the first, or adopts its broadcast.
    expect(statuses.length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 200), `refresh statuses ${statuses}`).toBe(true);
  });

  test('logging out in one tab signs out the other', async ({ page }) => {
    const second = await page.context().newPage();
    await page.goto('/dashboard');
    await signedIn(page);
    await second.goto('/dashboard');
    await signedIn(second);
    await page.getByRole('button', { name: 'Log out' }).first().click();
    await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);
    await expect(second.getByRole('button', { name: 'Log out' })).toHaveCount(0);
  });

  test('arriving from another site (a payment return, an email link) keeps the learner signed in', async ({ page }) => {
    await page.goto('/dashboard');
    await signedIn(page);
    // 127.0.0.1 and localhost are different sites.
    const elsewhere = `http://127.0.0.1:${WEB_PORT}/e2e-cross-site`;
    await page.route(elsewhere, (route) =>
      route.fulfill({ contentType: 'text/html', body: `<a href="${BASE_URL}/dashboard">Back to EthiopiaLearn</a>` }),
    );
    await page.goto(elsewhere);
    const refresh = page.waitForResponse(isRefresh);
    await page.getByRole('link', { name: 'Back to EthiopiaLearn' }).click();
    await expect(page).toHaveURL(`${BASE_URL}/dashboard`);
    expect((await refresh).status()).toBe(200);
    await signedIn(page);
  });
});

test('an anonymous visit to the catalog makes no auth call', async ({ page }) => {
  const auth: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/v1/auth/')) auth.push(req.url());
  });
  await page.goto('/courses');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(auth).toEqual([]);
});

// The quality officer: a password change revokes the role's other sessions, and no other
// spec signs in as this role while this one runs (CI runs one worker).
test('after a password change, a reload keeps the user signed in (6a P1-05)', async ({ page, request }) => {
  const original = seedPassword();
  const changed = `${original}-e2e9`;
  await signIn(page, 'quality_officer');
  let restore = false;
  try {
    await page.goto('/account/password');
    await page.getByLabel('Current password').fill(original);
    await page.getByLabel('New password', { exact: true }).fill(changed);
    await page.getByLabel('Confirm new password').fill(changed);
    const put = page.waitForResponse((r) => r.url() === `${BASE_URL}/api/v1/profiles/password`);
    await page.getByRole('button', { name: 'Save password' }).click();
    expect((await put).status()).toBe(200);
    restore = true;
    await page.waitForURL('**/qa');

    const refresh = page.waitForResponse(isRefresh);
    await page.reload();
    expect((await refresh).status()).toBe(200);
    await signedIn(page);
  } finally {
    if (restore) {
      // Back to the seeded password, through the API, so later specs can log in.
      const login = await request.post(`${API_URL}/api/v1/auth/login`, { data: { email: ROLES.quality_officer.email, password: changed } });
      const { access_token } = (await login.json()) as { access_token: string };
      const back = await request.put(`${API_URL}/api/v1/profiles/password`, {
        headers: { Authorization: `Bearer ${access_token}` },
        data: { current_password: changed, new_password: original },
      });
      expect(back.ok(), `restore the seeded password → ${back.status()}`).toBe(true);
    }
  }
});
