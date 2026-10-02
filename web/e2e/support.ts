import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** The web app under test (`next start`), its "API asleep" twin, and the gateway. */
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3000);
export const BASE_URL = `http://localhost:${WEB_PORT}`;
export const COLD_PORT = Number(process.env.E2E_COLD_PORT ?? 3100);
export const COLD_URL = `http://localhost:${COLD_PORT}`;
export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';

/** The accounts `pnpm -C api seed` creates, and the page each one should land on (P0-11). */
export const ROLES = {
  learner: { email: 'learner@ethiopialearn.et', home: '/dashboard' },
  educator: { email: 'educator@ethiopialearn.et', home: '/teach' },
  institution_admin: { email: 'institution@ethiopialearn.et', home: '/institution' },
  quality_officer: { email: 'qo@ethiopialearn.et', home: '/qa' },
  platform_admin: { email: 'admin@ethiopialearn.et', home: '/admin' },
} as const;
export type Role = keyof typeof ROLES;

export const authFile = (role: Role) => path.join(__dirname, '.auth', `${role}.json`);

/**
 * The seeded accounts' password, the way the seed gets it: SEED_PASSWORD from
 * the environment, else from api/.env.example (CI copies it to api/.env).
 * Read at run time so no spec ever contains it.
 */
export function seedPassword(): string {
  if (process.env.SEED_PASSWORD) return process.env.SEED_PASSWORD;
  const example = readFileSync(path.join(__dirname, '..', '..', 'api', '.env.example'), 'utf8');
  const line = example.split('\n').find((l) => l.startsWith('SEED_PASSWORD='));
  if (!line) throw new Error('Set SEED_PASSWORD: api/.env.example has none');
  return line.slice('SEED_PASSWORD='.length).trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** Logs in through the real form. Each call spends one of the 10 auth-strict calls a minute (see playwright.config.ts). */
export async function logIn(page: Page, role: Role) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(ROLES[role].email);
  await page.locator('input[name="password"]').fill(seedPassword());
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(`**${ROLES[role].home}`);
}

/** The access token saved by auth.setup.ts for a role. */
export function tokenFor(role: Role): string {
  const state = JSON.parse(readFileSync(authFile(role), 'utf8')) as {
    origins: { origin: string; localStorage: { name: string; value: string }[] }[];
  };
  const item = state.origins.flatMap((o) => o.localStorage).find((i) => i.name === 'el_auth');
  if (!item) throw new Error(`No saved login for ${role}; did auth.setup.ts run?`);
  return (JSON.parse(item.value) as { access_token: string }).access_token;
}

export async function apiGet<T>(request: APIRequestContext, apiPath: string, role?: Role): Promise<T> {
  const res = await request.get(`${API_URL}/api/v1${apiPath}`, {
    headers: role ? { Authorization: `Bearer ${tokenFor(role)}` } : {},
  });
  expect(res.ok(), `GET ${apiPath} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

export async function firstCourseId(request: APIRequestContext): Promise<string> {
  const { items } = await apiGet<{ items: { id: string }[] }>(request, '/search?page=1&limit=1');
  expect(items.length, 'the e2e stack has a published course (scripts/demo-seed.mjs)').toBeGreaterThan(0);
  return items[0].id;
}

export async function learnerCertificateUid(request: APIRequestContext): Promise<string> {
  const certs = await apiGet<{ certificate_uid: string }[]>(request, '/me/certificates', 'learner');
  expect(certs.length, 'the seeded learner has a certificate (scripts/demo-seed.mjs)').toBeGreaterThan(0);
  return certs[0].certificate_uid;
}

/** Waits until finite CSS and Web Animations have finished, so boxes are measured at rest. */
export async function settle(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
}

/** Bottom edge of the fixed site header, once its entrance animation has finished. */
export async function headerBottom(page: Page): Promise<number> {
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect.poll(async () => Math.round((await nav.boundingBox())?.y ?? -1)).toBe(0);
  const box = (await nav.boundingBox())!;
  return box.y + box.height;
}

/**
 * Horizontal overflow in px, with html/body's `overflow-x: clip` lifted so
 * content that is wider than the viewport shows up instead of being cut off.
 */
export async function horizontalOverflow(page: Page): Promise<number> {
  await page.addStyleTag({ content: 'html, body { overflow-x: visible !important; }' });
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
