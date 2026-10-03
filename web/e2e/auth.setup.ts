import { expect, test as setup } from './test';
import { authFile, logIn, ROLES, type Role } from './support';

// P0-11: every seeded role lands on a page it can use. The saved login is
// reused by every other spec (one auth-strict call per role; see the config).
for (const role of Object.keys(ROLES) as Role[]) {
  setup(`${role} logs in and lands on ${ROLES[role].home}`, async ({ page }) => {
    await logIn(page, role);
    await expect(page).toHaveURL(new RegExp(`${ROLES[role].home}$`));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: "This page isn't available for your account" })).toHaveCount(0);
    await page.context().storageState({ path: authFile(role) });
  });
}
