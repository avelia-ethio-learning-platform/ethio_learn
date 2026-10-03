#!/usr/bin/env node
/**
 * E2E for the Phase 6a security fixes against a RUNNING stack in CHAPA_MODE=mock,
 * after demo-seed (it needs a published paid course of the demo educator).
 *
 *   • a lesson-complete path segment that smuggles an encoded path (P1-01) → 400
 *   • password change: no current password → 400, with it → 200 and the caller is
 *     still signed in (fresh access token, working refresh cookie); every other
 *     session is revoked; the new password logs in
 *   • a referral invite to an existing user → invited 0; the 21st invite in a day → 429
 *     with the daily-limit message
 *   • a one-use 100% coupon, five concurrent checkouts → exactly one succeeds, the rest
 *     get "fully used", and the DB agrees (one confirmed payment, uses = 1)
 *   • a one-use Chapa coupon: an abandoned checkout is returned again on retry (same
 *     payment and URL), holds the coupon against another learner, then is accepted
 *   • pay links (A1): signed out, GET /pay-requests/:token → 200 in the public shape
 *     without the payer's email, unknown → 404, malformed → 400; paying → 401
 *
 * Every account is fresh per run (RUN-unique, @e2e.test), and invitee addresses are
 * @example.test, so the script re-runs on the same database. Reads the database through
 * the compose Postgres container's own credentials. Usage: node scripts/e2e-security.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:4000';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A variable from the environment, else from the api env file the stack uses. */
function apiEnv(name) {
  if (process.env[name]) return process.env[name];
  for (const file of ['../api/.env', '../api/.env.example']) {
    const url = new URL(file, import.meta.url);
    if (!existsSync(url)) continue;
    const line = readFileSync(url, 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim();
  }
  throw new Error(`${name} is not set and no api/.env(.example) defines it`);
}
const SEED_PASSWORD = apiEnv('SEED_PASSWORD');
/** The database the services use (its name only; the container supplies the credentials). */
const DB_NAME = new URL(apiEnv('DATABASE_URL')).pathname.slice(1);
const PASSWORD = `E2e-${RUN}-pass`;
const CHANGED_PASSWORD = `E2e-${RUN}-changed`;
/** Credential endpoints share the per-IP auth-strict limit; a 429 on these waits and retries. */
const RETRY_ON_429 = ['/auth/', '/profiles/password'];

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** One SQL statement through the compose Postgres container; rows as arrays of fields. */
function sql(statement) {
  const res = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'sh', '-c', 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -At -F "|" -c "$0"', statement, DB_NAME],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`psql failed: ${res.stderr.trim()}`);
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|'));
}

/** One request. A 429 on a credential endpoint waits and retries, unless `noRetry` (the call whose 429 is asserted). */
async function call(path, { method = 'GET', token, body, headers = {}, cookie, noRetry = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && !noRetry && RETRY_ON_429.some((p) => path.startsWith(p)) && attempt < 6) {
      const wait = Number(res.headers.get('retry-after') ?? res.headers.get('ratelimit-reset') ?? 15);
      console.log(`    (rate limited on ${path}; waiting ${wait}s)`);
      await sleep((wait + 1) * 1000);
      continue;
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    const refreshCookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('el_refresh='));
    return { status: res.status, json, text, refreshCookie };
  }
}

const ok = (r) => r.status >= 200 && r.status < 300;
const brief = (r) => `${r.status} ${r.text?.slice(0, 200)}`;
const must = (r, what) => {
  if (!ok(r)) throw new Error(`${what} failed: ${brief(r)}`);
  return r.json;
};

/** Logs in; keeps the refresh cookie so a session can be refreshed or shown revoked. */
async function login(email, password) {
  const res = await call('/auth/login', { method: 'POST', body: { email, password } });
  const r = must(res, `login ${email}`);
  return { token: r.access_token, id: r.user?.id, cookie: res.refreshCookie };
}

/** Self-signup, verified by the platform admin (no inbox in a test run), then logged in. */
async function newLearner(admin, label) {
  const email = `${label}-${RUN}@e2e.test`;
  const r = must(await call('/auth/signup', { method: 'POST', body: { email, name: `E2E ${label} ${RUN}`, password: PASSWORD, role: 'learner' } }), `signup ${email}`);
  must(await call(`/admin/users/${r.user_id}/verify-email`, { method: 'POST', token: admin.token }), `verify ${email}`);
  return { email, ...(await login(email, PASSWORD)) };
}

/** Polls until `read()` satisfies `done`, or the timeout passes; returns the last value. */
async function waitFor(read, done, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < until) {
    await sleep(500);
    value = await read();
  }
  return value;
}

const DAILY_LIMIT = /today's limit for referral invites\. Try again tomorrow\./;
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const FULLY_USED = 'This coupon has been fully used.';
const message = (r) => [r.json?.message].flat().join(' ');

async function main() {
  console.log(`e2e security against ${API}`);
  const admin = await login('admin@ethiopialearn.et', SEED_PASSWORD);
  const educator = await login('educator@ethiopialearn.et', SEED_PASSWORD);
  const learner = await newLearner(admin, 'sec');

  // ---- P1-01: an encoded path in a uuid route parameter never reaches service code ----
  const probe = await call(`/progress/lessons/..%2Fusers%2F${admin.id}/complete`, { method: 'POST', token: learner.token });
  check('lesson-complete with an encoded path segment → 400', probe.status === 400, brief(probe));

  // ---- password change ----
  const pw = await newLearner(admin, 'pw');
  const sessionB = await login(pw.email, PASSWORD);
  check('session B got a refresh cookie at login', Boolean(sessionB.cookie));
  const bBefore = await call('/auth/refresh', { method: 'POST', cookie: sessionB.cookie });
  check('session B refreshes before the password change → 200', bBefore.status === 200 && Boolean(bBefore.refreshCookie), brief(bBefore));
  const bCookie = bBefore.refreshCookie ?? sessionB.cookie; // refreshing may rotate the cookie
  const noCurrent = await call('/profiles/password', { method: 'PUT', token: pw.token, body: { new_password: CHANGED_PASSWORD } });
  check('password change without the current password → 400', noCurrent.status === 400 && /Current password is required\./.test(message(noCurrent)), brief(noCurrent));
  const wrong = await call('/profiles/password', { method: 'PUT', token: pw.token, body: { new_password: CHANGED_PASSWORD, current_password: 'Wrong-passw0rd-x' } });
  check('password change with a wrong current password → 401', wrong.status === 401 && /Current password is incorrect\./.test(message(wrong)), brief(wrong));
  const changed = await call('/profiles/password', { method: 'PUT', token: pw.token, body: { new_password: CHANGED_PASSWORD, current_password: PASSWORD } });
  check('password change with the current password → 200 and a fresh access token', changed.status === 200 && typeof changed.json?.access_token === 'string', brief(changed));
  const me = await call('/profiles/me', { token: changed.json?.access_token });
  check('the new access token works (still signed in)', me.status === 200 && me.json?.email === pw.email, brief(me));
  check('the response set a refresh cookie', Boolean(changed.refreshCookie));
  const refreshed = await call('/auth/refresh', { method: 'POST', cookie: changed.refreshCookie });
  check('the new refresh cookie refreshes the session', refreshed.status === 200 && typeof refreshed.json?.access_token === 'string', brief(refreshed));
  const revoked = await call('/auth/refresh', { method: 'POST', cookie: bCookie });
  check("another session's refresh token is revoked → 401", revoked.status === 401, brief(revoked));
  const relogin = await call('/auth/login', { method: 'POST', body: { email: pw.email, password: CHANGED_PASSWORD } });
  check('login with the new password → 200', relogin.status === 200, brief(relogin));
  const oldLogin = await call('/auth/login', { method: 'POST', body: { email: pw.email, password: PASSWORD } });
  check('login with the old password → 401', oldLogin.status === 401, brief(oldLogin));

  // ---- referral invites: existing users are not emailed; the daily cap holds ----
  const existing = await call('/referrals/invite', { method: 'POST', token: learner.token, body: { emails: ['learner@ethiopialearn.et'] } });
  check('inviting an existing user → invited 0', ok(existing) && existing.json?.invited === 0, brief(existing));
  const fresh = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i}-${RUN}@example.test`);
  const twenty = await call('/referrals/invite', { method: 'POST', token: learner.token, body: { emails: fresh(20, 'inv') } });
  check('20 fresh invites in one call → invited 20', ok(twenty) && twenty.json?.invited === 20, brief(twenty));
  const twentyFirst = await call('/referrals/invite', { method: 'POST', token: learner.token, noRetry: true, body: { emails: fresh(1, 'over') } });
  check('the 21st invite in a day → 429 with the daily-limit message', twentyFirst.status === 429 && DAILY_LIMIT.test(message(twentyFirst)), brief(twentyFirst));

  // ---- coupons: a one-use code is never over-spent ----
  const owned = must(await call('/courses', { token: educator.token }), 'educator courses');
  const course = (Array.isArray(owned) ? owned : owned.items ?? []).find((c) => c.status === 'published' && Number(c.price_etb) > 0);
  if (!course) throw new Error('need a published paid course of the demo educator: run scripts/demo-seed.mjs first');
  const makeCoupon = async (suffix, value) => {
    const code = `E2E${RUN}${suffix}`.toUpperCase();
    must(await call('/coupons', { method: 'POST', token: educator.token, body: { code, kind: 'percent', value, course_id: course.id, max_uses: 1 } }), `coupon ${code}`);
    return code;
  };

  const full = await makeCoupon('F', 100);
  const racers = [];
  for (let i = 0; i < 5; i++) racers.push(await newLearner(admin, `race${i}`));
  const results = await Promise.all(racers.map((l) => call('/payments/initiate', { method: 'POST', token: l.token, body: { course_id: course.id, coupon_code: full } })));
  const won = results.filter(ok);
  const lost = results.filter((r) => !ok(r));
  check('5 concurrent 100% checkouts of a one-use coupon: exactly 1 succeeds', won.length === 1, results.map(brief).join(' | '));
  check(`the other 4 → 400 "${FULLY_USED}"`, lost.length === 4 && lost.every((r) => r.status === 400 && message(r) === FULLY_USED), lost.map(brief).join(' | '));
  const confirmed = await waitFor(
    async () => sql(`SELECT count(*) FROM financial.payments WHERE coupon_code = '${full}' AND status = 'confirmed'`)[0][0],
    (n) => Number(n) >= 1,
  );
  check('exactly one confirmed payment carries the coupon', Number(confirmed) === 1, `${confirmed}`);
  const [[uses]] = sql(`SELECT uses FROM financial.coupons WHERE code = '${full}'`);
  check('coupons.uses is 1', Number(uses) === 1, `${uses}`);

  const partial = await makeCoupon('P', 50);
  const [a, b] = [await newLearner(admin, 'holdA'), await newLearner(admin, 'holdB')];
  const first = await call('/payments/initiate', { method: 'POST', token: a.token, body: { course_id: course.id, coupon_code: partial } });
  check('a Chapa checkout with the one-use coupon is accepted', ok(first) && first.json?.confirmed === false && Boolean(first.json?.checkout_url), brief(first));
  const retry = await call('/payments/initiate', { method: 'POST', token: a.token, body: { course_id: course.id, coupon_code: partial } });
  check(
    'the abandoned checkout, retried, is accepted and returns the same payment and URL',
    ok(retry) && retry.json?.payment_id === first.json?.payment_id && retry.json?.checkout_url === first.json?.checkout_url && retry.json?.tx_ref === first.json?.tx_ref,
    `${brief(first)} / ${brief(retry)}`,
  );
  const other = await call('/payments/initiate', { method: 'POST', token: b.token, body: { course_id: course.id, coupon_code: partial } });
  check(`while the hold is open, another learner → 400 "${FULLY_USED}"`, other.status === 400 && message(other) === FULLY_USED, brief(other));

  // ---- pay links (A1): the landing data is public, paying is not ----
  const payer = `payer-${RUN}@example.test`;
  const created = must(await call('/pay-requests', { method: 'POST', token: learner.token, body: { course_id: course.id, payer_email: payer } }), 'pay request');
  const token = String(created.pay_url ?? '').split('/').pop();
  if (!/^[A-HJ-NP-Z2-9]{24}$/.test(token)) throw new Error(`no usable token in the pay request response: ${JSON.stringify(created)}`);
  const pub = await call(`/pay-requests/${token}`);
  check('anonymous GET of the pay request → 200 with the course and requester', pub.status === 200 && pub.json?.course_title === course.title && typeof pub.json?.requester_name === 'string' && pub.json.requester_name.length > 0, brief(pub));
  check("the payer's email is nowhere in the body", pub.status === 200 && !pub.text.toLowerCase().includes(payer), pub.text);
  const unknown = await call(`/pay-requests/${[...TOKEN_ALPHABET].reverse().join('').slice(0, 24)}`);
  check('a well-formed unknown token → 404', unknown.status === 404, brief(unknown));
  const badAlphabet = await call(`/pay-requests/${'0'.repeat(24)}`);
  const tooShort = await call('/pay-requests/ABCDEFGH');
  check('a malformed token (wrong alphabet, wrong length) → 400', badAlphabet.status === 400 && tooShort.status === 400, `${badAlphabet.status}, ${tooShort.status}`);
  const anonPay = await call(`/pay-requests/${token}/pay`, { method: 'POST', body: {} });
  check('paying without a token → 401', anonPay.status === 401, brief(anonPay));

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall security checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
