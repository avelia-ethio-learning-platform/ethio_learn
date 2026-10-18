import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test as setup } from './test';
import { authFile, logIn, ROLES, type Role } from './support';

// P0-11: every seeded role logs in through the form and lands on a page it can
// use. The login's access token is saved for specs' API-level calls (tokenFor);
// browser specs sign in per test instead (test.use({ loggedInAs })).
for (const role of Object.keys(ROLES) as Role[]) {
  setup(`${role} logs in and lands on ${ROLES[role].home}`, async ({ page }) => {
    const login = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST');
    await logIn(page, role);
    const { access_token } = (await (await login).json()) as { access_token: string };
    await expect(page).toHaveURL(new RegExp(`${ROLES[role].home}$`));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: "This page isn't available for your account" })).toHaveCount(0);
    mkdirSync(path.dirname(authFile(role)), { recursive: true });
    writeFileSync(authFile(role), JSON.stringify({ access_token }));
  });
}
