#!/usr/bin/env node
/**
 * E2E for consent-based institution membership (P0-03), against a RUNNING
 * stack (gateway + services + infra) with the seed accounts (`pnpm -C api seed`).
 *
 * A freshly self-signed-up institution admin invites a learner. Covers:
 *   • the invite changes nothing on the learner: role, status and sessions
 *   • the same 201 for every address (new, staff, existing): no enumeration
 *   • an institution admin can't suspend or ban the account, only the membership
 *   • the learner accepts on their own: role educator, membership active
 *   • a suspended membership leaves the account alone (login and refresh work)
 *     and makes new courses independent
 *   • the member can leave: the membership is removed with the reason, their
 *     next course is independent, and leaving again is a 404
 *
 * Usage: node scripts/e2e-institution.mjs      (exits 1 on any failure)
 */
import { existsSync, readFileSync } from 'node:fs';

const API = process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:4000';
/** Unique per run so re-running against the same database never matches an earlier run's rows. */
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The seed accounts' password: SEED_PASSWORD from the environment, else the api env file the stack uses. */
function seedPassword() {
  if (process.env.SEED_PASSWORD) return process.env.SEED_PASSWORD;
  for (const file of ['../api/.env', '../api/.env.example']) {
    const url = new URL(file, import.meta.url);
    if (!existsSync(url)) continue;
    const line = readFileSync(url, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('SEED_PASSWORD='));
    if (line) return line.slice('SEED_PASSWORD='.length).trim();
  }
  throw new Error('SEED_PASSWORD is not set and no api/.env(.example) defines it');
}
const SEED_PASSWORD = seedPassword();
/** Passwords for the accounts this run creates (not secrets: throwaway users in a test database). */
const NEW_PASSWORD = `E2e-${RUN}-pass`;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** One request. Credential endpoints share a per-IP limit with the other e2e scripts, so a 429 there waits and retries. */
async function call(path, { method = 'GET', token, body, cookie } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && path.startsWith('/auth/') && attempt < 6) {
      const wait = Number(res.headers.get('retry-after') ?? res.headers.get('ratelimit-reset') ?? 15);
      console.log(`    (rate limited on ${path}; waiting ${wait}s)`);
      await sleep((wait + 1) * 1000);
      continue;
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    const setCookie = res.headers.get('set-cookie') ?? '';
    const refresh = /el_refresh=([^;]+)/.exec(setCookie)?.[1];
    return { status: res.status, json, cookie: refresh ? `el_refresh=${refresh}` : undefined };
  }
}

const ok = (r) => r.status >= 200 && r.status < 300;
const brief = (r) => `${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`;

async function login(email, password) {
  const r = await call('/auth/login', { method: 'POST', body: { email, password } });
  if (!ok(r)) throw new Error(`login ${email} failed: ${brief(r)}`);
  return { token: r.json.access_token, id: r.json.user?.id, role: r.json.user?.role, cookie: r.cookie };
}

/** Self-signup, verified by the platform admin (no inbox in a test run), then logged in. */
async function newAccount(admin, role, label) {
  const email = `${label}-${RUN}@e2e.test`;
  const r = await call('/auth/signup', { method: 'POST', body: { email, name: `E2E ${label} ${RUN}`, password: NEW_PASSWORD, role } });
  if (!ok(r)) throw new Error(`signup ${email} failed: ${brief(r)}`);
  const v = await call(`/admin/users/${r.json.user_id}/verify-email`, { method: 'POST', token: admin.token });
  if (!ok(v)) throw new Error(`verify ${email} failed: ${brief(v)}`);
  return { email, ...(await login(email, NEW_PASSWORD)) };
}

async function newCourse(token, title) {
  return call('/courses', {
    method: 'POST',
    token,
    body: { title, description: 'A course created by the institution e2e run.', category: 'programming', language: 'en', pricing_type: 'free' },
  });
}

/** The courses an institution admin sees as their institution's (the create response doesn't carry institution_id). */
async function institutionCourseIds(token) {
  const r = await call('/institution/courses', { token });
  if (!ok(r)) throw new Error(`institution courses failed: ${brief(r)}`);
  return r.json.map((c) => c.id);
}

async function main() {
  console.log(`e2e institution membership against ${API}`);
  const admin = await login('admin@ethiopialearn.et', SEED_PASSWORD);
  const owner = await newAccount(admin, 'institution_admin', 'inst-owner');
  const inst = await call('/profiles/institution', { method: 'POST', token: owner.token, body: { name: `E2E Academy ${RUN}` } });
  if (!ok(inst)) throw new Error(`create institution failed: ${brief(inst)}`);
  const iid = inst.json.id;
  let learner = await newAccount(admin, 'learner', 'learner');

  // ---- invite: nothing changes on the learner ----
  const invite = await call(`/institutions/${iid}/instructors`, { method: 'POST', token: owner.token, body: { email: learner.email } });
  check('invite → 201 with only the typed email', invite.status === 201 && invite.json?.membership?.status === 'invited' && invite.json.membership.email === learner.email, brief(invite));
  const membershipId = invite.json?.membership?.id;

  const unknown = await call(`/institutions/${iid}/instructors`, { method: 'POST', token: owner.token, body: { email: `nobody-${RUN}@e2e.test` } });
  const staff = await call(`/institutions/${iid}/instructors`, { method: 'POST', token: owner.token, body: { email: 'qo@ethiopialearn.et' } });
  const shape = (r) => (r.status === 201 ? Object.keys(r.json.membership).sort().join(',') : brief(r));
  check('new, staff and existing addresses get the same response', shape(unknown) === shape(invite) && shape(staff) === shape(invite), `${shape(unknown)} / ${shape(staff)}`);

  const meAfterInvite = await call('/profiles/me', { token: learner.token });
  check('learner is still a learner after the invite', meAfterInvite.json?.role === 'learner', brief(meAfterInvite));
  let refreshed = await call('/auth/refresh', { method: 'POST', cookie: learner.cookie });
  check("learner's session survives the invite (refresh works)", ok(refreshed) && refreshed.json.user?.role === 'learner', brief(refreshed));
  learner = { ...learner, token: refreshed.json?.access_token ?? learner.token, cookie: refreshed.cookie ?? learner.cookie };

  const list = await call(`/institutions/${iid}/instructors`, { token: owner.token });
  const row = list.json?.find?.((m) => m.membership_id === membershipId);
  check('the list shows the invitation without name or role', ok(list) && row?.status === 'invited' && row.email === learner.email && !('user' in row), brief(list));

  // ---- the institution admin can't touch the account ----
  const suspendInvite = await call(`/institutions/${iid}/instructors/${membershipId}/status`, { method: 'POST', token: owner.token, body: { status: 'suspended' } });
  check('an invitation cannot be suspended (400)', suspendInvite.status === 400, brief(suspendInvite));
  const ban = await call(`/institutions/${iid}/instructors/${membershipId}/status`, { method: 'POST', token: owner.token, body: { status: 'banned' } });
  check('an institution admin cannot ban (400)', ban.status === 400, brief(ban));
  const activate = await call(`/institutions/${iid}/instructors/${membershipId}/status`, { method: 'POST', token: owner.token, body: { status: 'active' } });
  check('an institution admin cannot accept on the learner’s behalf (400)', activate.status === 400, brief(activate));
  const platformBan = await call(`/admin/users/${learner.id}/status`, { method: 'POST', token: owner.token, body: { status: 'banned' } });
  check('the platform ban endpoint refuses an institution admin (403)', platformBan.status === 403, brief(platformBan));
  const stillMe = await call('/profiles/me', { token: learner.token });
  check('learner unaffected by those attempts', ok(stillMe) && stillMe.json.role === 'learner', brief(stillMe));

  // ---- the learner accepts in their own session ----
  const mine = await call('/profiles/me/institution-invites', { token: learner.token });
  check('learner sees the invitation with the institution named', ok(mine) && mine.json.some((i) => i.id === membershipId && i.institution.name === `E2E Academy ${RUN}`), brief(mine));
  const accept = await call(`/profiles/me/institution-invites/${membershipId}/accept`, { method: 'POST', token: learner.token });
  check('accept → role educator', ok(accept) && accept.json.role === 'educator', brief(accept));
  const again = await call(`/profiles/me/institution-invites/${membershipId}/accept`, { method: 'POST', token: learner.token });
  check('a second accept is 404', again.status === 404, brief(again));
  refreshed = await call('/auth/refresh', { method: 'POST', cookie: learner.cookie });
  check('refresh picks up the educator role', ok(refreshed) && refreshed.json.user?.role === 'educator', brief(refreshed));
  learner = { ...learner, token: refreshed.json?.access_token ?? learner.token, cookie: refreshed.cookie ?? learner.cookie };
  const accepted = (await call(`/institutions/${iid}/instructors`, { token: owner.token })).json?.find?.((m) => m.membership_id === membershipId);
  check('the list now shows the instructor by name', accepted?.status === 'active' && accepted.user?.role === 'educator', JSON.stringify(accepted));

  const routed = await newCourse(learner.token, `E2E routed ${RUN}`);
  check('a course created while active belongs to the institution', ok(routed) && (await institutionCourseIds(owner.token)).includes(routed.json.id), brief(routed));

  // ---- suspending the membership leaves the account alone ----
  const suspend = await call(`/institutions/${iid}/instructors/${membershipId}/status`, { method: 'POST', token: owner.token, body: { status: 'suspended', reason: 'e2e' } });
  check('suspend the membership → 200', ok(suspend) && suspend.json.status === 'suspended', brief(suspend));
  refreshed = await call('/auth/refresh', { method: 'POST', cookie: learner.cookie });
  check('their session survives the suspension (refresh works)', ok(refreshed) && refreshed.json.user?.role === 'educator', brief(refreshed));
  const relogin = await call('/auth/login', { method: 'POST', body: { email: learner.email, password: NEW_PASSWORD } });
  check('they can still log in', ok(relogin), brief(relogin));
  const independent = await newCourse(relogin.json?.access_token, `E2E independent ${RUN}`);
  const institutionCourses = await institutionCourseIds(owner.token);
  check(
    'a course created while suspended is independent; the earlier one stays with the institution',
    ok(independent) && !institutionCourses.includes(independent.json.id) && institutionCourses.includes(routed.json?.id),
    brief(independent),
  );

  // ---- the member leaves in their own session ----
  const reactivate = await call(`/institutions/${iid}/instructors/${membershipId}/status`, { method: 'POST', token: owner.token, body: { status: 'active' } });
  check('reactivate the membership → 200', ok(reactivate) && reactivate.json.status === 'active', brief(reactivate));
  const listed = await call('/profiles/me/institution-memberships', { token: relogin.json?.access_token });
  check('the member sees their active membership', ok(listed) && listed.json.some((m) => m.id === membershipId && m.status === 'active'), brief(listed));
  const notTheirs = await call(`/profiles/me/institution-memberships/${membershipId}/leave`, { method: 'POST', token: owner.token });
  check("someone else's membership id is 404", notTheirs.status === 404, brief(notTheirs));
  const left = await call(`/profiles/me/institution-memberships/${membershipId}/leave`, { method: 'POST', token: relogin.json?.access_token });
  check('leave → removed', ok(left) && left.json?.status === 'removed', brief(left));
  const removed = (await call(`/institutions/${iid}/instructors`, { token: owner.token })).json?.find?.((m) => m.membership_id === membershipId);
  check('the membership is removed, with the reason', removed?.status === 'removed' && removed.status_reason === 'Left the institution', JSON.stringify(removed));
  const listedAfter = await call('/profiles/me/institution-memberships', { token: relogin.json?.access_token });
  check('the member no longer lists it', ok(listedAfter) && !listedAfter.json.some((m) => m.id === membershipId), brief(listedAfter));
  const afterLeave = await newCourse(relogin.json?.access_token, `E2E after leaving ${RUN}`);
  const afterCourses = await institutionCourseIds(owner.token);
  check(
    'a course created after leaving is independent; the earlier ones stay with the institution',
    ok(afterLeave) && !afterCourses.includes(afterLeave.json.id) && afterCourses.includes(routed.json?.id),
    brief(afterLeave),
  );
  const leftAgain = await call(`/profiles/me/institution-memberships/${membershipId}/leave`, { method: 'POST', token: relogin.json?.access_token });
  check('leaving again is 404', leftAgain.status === 404, brief(leftAgain));

  console.log(failures ? `\n${failures} institution check(s) failed` : '\nall institution membership checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
