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

/** Logs in through the real form (one auth-strict call). */
export async function logIn(page: Page, role: Role) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(ROLES[role].email);
  await page.locator('input[name="password"]').fill(seedPassword());
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(`**${ROLES[role].home}`);
}

/**
 * Signs `page`'s context in as `role` (Phase 11b): a login through the web
 * origin stores that context's own refresh cookie, and the session hint makes
 * the next page load refresh. Refresh tokens rotate on every load, so a saved
 * storageState would work for one context only: each test logs in itself.
 */
export async function signIn(page: Page, role: Role) {
  const res = await page.request.post(`${BASE_URL}/api/v1/auth/login`, { data: { email: ROLES[role].email, password: seedPassword() } });
  expect(res.ok(), `login as ${role} → ${res.status()}`).toBe(true);
  const { user } = (await res.json()) as { user: unknown };
  // A page where the app doesn't run, to write the hint before the first real load.
  await page.goto(`${BASE_URL}/robots.txt`);
  await page.evaluate((u) => localStorage.setItem('el_session', JSON.stringify({ user: u })), user);
}

/** An access token for API-level calls in specs, saved by auth.setup.ts (valid 15 min). */
export function tokenFor(role: Role): string {
  try {
    return (JSON.parse(readFileSync(authFile(role), 'utf8')) as { access_token: string }).access_token;
  } catch {
    throw new Error(`No saved token for ${role}; did auth.setup.ts run?`);
  }
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

/** One of the seeded educator's draft courses; the seed publishes its courses, so a draft is created when there is none. */
export async function ownCourseId(request: APIRequestContext): Promise<string> {
  const courses = await apiGet<{ id: string; status: string }[]>(request, '/courses', 'educator');
  const draft = courses.find((c) => c.status === 'draft');
  if (draft) return draft.id;
  const res = await request.post(`${API_URL}/api/v1/courses`, {
    headers: { Authorization: `Bearer ${tokenFor('educator')}` },
    data: {
      title: 'Draft for the e2e checks',
      description: 'A draft course the browser checks open in the editor.',
      category: 'programming',
      language: 'en',
      pricing_type: 'free',
    },
  });
  expect(res.ok(), `POST /courses → ${res.status()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/**
 * The e2e draft with at least one lesson, so the editor shows its lesson-row controls
 * ("upload video"). Adds a section and a lesson through the API only when the draft has none.
 */
export async function draftWithLesson(request: APIRequestContext): Promise<string> {
  const id = await ownCourseId(request);
  // The working copy is what the editor renders, so its lesson count is the one that matters.
  const course = await apiGet<{ sections: { id: string; lessons: { id: string }[] }[] }>(request, `/courses/${id}/working`, 'educator');
  if (course.sections.some((s) => s.lessons.length > 0)) return id;
  const headers = { Authorization: `Bearer ${tokenFor('educator')}` };
  let section = course.sections[0];
  if (!section) {
    const res = await request.post(`${API_URL}/api/v1/courses/${id}/sections`, { headers, data: { title: 'Section 1', is_free_preview: false } });
    expect(res.ok(), `POST /courses/${id}/sections → ${res.status()}`).toBe(true);
    section = (await res.json()) as { id: string; lessons: { id: string }[] };
  }
  const res = await request.post(`${API_URL}/api/v1/sections/${section.id}/lessons`, { headers, data: { title: 'Lesson 1', duration_seconds: 60 } });
  expect(res.ok(), `POST /sections/${section.id}/lessons → ${res.status()}`).toBe(true);
  return id;
}

/** The seeded quiz's exam route (scripts/demo-seed.mjs adds a quiz to a tech course). */
export async function seededExamPath(request: APIRequestContext): Promise<string> {
  const { items } = await apiGet<{ items: { id: string; category: string }[] }>(request, '/search?page=1&limit=50');
  for (const course of items) {
    const quiz = (await apiGet<{ id: string; type: string }[]>(request, `/assessments?course_id=${course.id}`, 'learner')).find((a) => a.type === 'quiz');
    if (quiz) return `/learn/${course.id}/exam/${quiz.id}`;
  }
  throw new Error('the e2e stack has a course with a quiz (scripts/demo-seed.mjs)');
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
