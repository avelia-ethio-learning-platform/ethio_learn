#!/usr/bin/env node
/**
 * E2E for exactly-once payments (P0-04, P0-05, P1-12, P1-14) against a RUNNING
 * stack in CHAPA_MODE=mock, after demo-seed (it needs published paid courses).
 *
 *   • a wallet top-up confirmed by many concurrent mock webhooks and reconcile
 *     calls is credited once, with one notification
 *   • a paid course confirmed concurrently: enrollment active, one receipt in the
 *     inbox, one cashback, and the access event acknowledged (effects_completed_at)
 *   • a wallet purchase debits once; a mock "failed" checkout fails the payment
 *   • the webhook refuses an unsigned or chapa-signature-only request (401)
 *   • two concurrent payout runs over backdated payments: at least one payout,
 *     each payment in exactly one, and one disbursement per payout
 *
 * Reads and backdates rows through the compose Postgres container's own
 * credentials, never written out here. Usage: node scripts/e2e-payments.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:4000';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUN = Date.now().toString(36);
const RACERS = 8;
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
const NEW_PASSWORD = `E2e-${RUN}-pass`;

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
const uuid = (id) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`not a uuid: ${id}`);
  return `'${id}'`;
};

/** One request. Credential endpoints share a per-IP limit with the other e2e scripts, so a 429 there waits and retries. */
async function call(path, { method = 'GET', token, body, raw, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: {
        ...(body || raw ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
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
    return { status: res.status, json };
  }
}

const ok = (r) => r.status >= 200 && r.status < 300;
const brief = (r) => `${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`;
const must = (r, what) => {
  if (!ok(r)) throw new Error(`${what} failed: ${brief(r)}`);
  return r.json;
};

async function login(email, password) {
  const r = must(await call('/auth/login', { method: 'POST', body: { email, password } }), `login ${email}`);
  return { token: r.access_token, id: r.user?.id };
}

/** Self-signup, verified by the platform admin (no inbox in a test run), then logged in. */
async function newLearner(admin, label) {
  const email = `${label}-${RUN}@e2e.test`;
  const r = must(await call('/auth/signup', { method: 'POST', body: { email, name: `E2E ${label} ${RUN}`, password: NEW_PASSWORD, role: 'learner' } }), `signup ${email}`);
  must(await call(`/admin/users/${r.user_id}/verify-email`, { method: 'POST', token: admin.token }), `verify ${email}`);
  return { email, ...(await login(email, NEW_PASSWORD)) };
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

/** Fires every racer at once; resolves when all have answered. */
const race = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const mockComplete = (txRef, outcome = 'success') => call('/payments/mock/complete', { method: 'POST', body: { tx_ref: txRef, outcome } });

async function inbox(token, type) {
  const r = must(await call('/notifications', { token }), 'notifications');
  return r.filter((n) => n.type === type);
}

async function main() {
  console.log(`e2e payments against ${API}`);
  const admin = await login('admin@ethiopialearn.et', SEED_PASSWORD);
  const learner = await newLearner(admin, 'payer');

  // ---- wallet top-up: many concurrent confirmations, one credit ----
  const topup = must(await call('/wallet/topup', { method: 'POST', token: learner.token, body: { amount_etb: 100 } }), 'top-up');
  const confirms = await race(RACERS, (i) =>
    i % 2 ? call('/payments/reconcile', { method: 'POST', token: learner.token, body: { tx_ref: topup.tx_ref } }) : mockComplete(topup.tx_ref),
  );
  check('every concurrent confirmation answered', confirms.every(ok), confirms.filter((r) => !ok(r)).map(brief).join('; '));
  const mockReasons = confirms.filter((_, i) => i % 2 === 0).map((r) => r.json?.reason);
  check('exactly one mock webhook confirmed the top-up', mockReasons.filter((r) => r === 'confirmed').length === 1, mockReasons.join(', '));
  let wallet = must(await call('/wallet', { token: learner.token }), 'wallet');
  check('the top-up was credited once', wallet.balance_etb === 100, `balance ${wallet.balance_etb}`);
  check('one top-up movement for the payment', wallet.transactions.filter((t) => t.kind === 'topup' && t.reference === topup.payment_id).length === 1);
  const topupPings = await waitFor(() => inbox(learner.token, 'wallet'), (rows) => rows.length >= 1);
  await sleep(1500); // let any duplicate arrive before counting
  check('one wallet notification for the top-up', (await inbox(learner.token, 'wallet')).length === 1, `${topupPings.length}`);

  // ---- a paid course, confirmed concurrently ----
  const catalog = must(await call('/search?pricing_type=paid&limit=12'), 'catalog').items ?? [];
  const paid = catalog.filter((c) => Number(c.price_etb) > 0);
  if (paid.length < 2) throw new Error('need two published paid courses: run scripts/demo-seed.mjs first');
  const [course, otherCourse] = paid;
  const checkout = must(await call('/payments/initiate', { method: 'POST', token: learner.token, body: { course_id: course.id } }), 'initiate');
  const courseConfirms = await race(RACERS, () => mockComplete(checkout.tx_ref));
  check('exactly one webhook confirmed the course payment', courseConfirms.filter((r) => r.json?.reason === 'confirmed').length === 1, courseConfirms.map((r) => r.json?.reason).join(', '));

  const enrolled = await waitFor(
    async () => must(await call('/enrollments', { token: learner.token }), 'enrollments'),
    (rows) => rows.some((e) => e.course_id === course.id && e.entitlement_status === 'active'),
  );
  check('enrollment active for the paid course', enrolled.some((e) => e.course_id === course.id && e.entitlement_status === 'active'));
  await waitFor(() => inbox(learner.token, 'payment_confirmed'), (rows) => rows.length >= 1);
  await sleep(1500);
  const receipts = (await inbox(learner.token, 'payment_confirmed')).filter((n) => n.link === `/learn/${course.id}`);
  check('one receipt in the inbox', receipts.length === 1, `${receipts.length} receipts`);
  wallet = must(await call('/wallet', { token: learner.token }), 'wallet');
  const cashback = wallet.transactions.filter((t) => t.kind === 'cashback' && t.reference === checkout.payment_id);
  check('one cashback for the course payment', cashback.length === 1, JSON.stringify(cashback));
  const [[effectsDone]] = await waitFor(
    async () => sql(`SELECT effects_completed_at IS NOT NULL FROM financial.payments WHERE id = ${uuid(checkout.payment_id)}`),
    (rows) => rows[0]?.[0] === 't',
    5_000,
  );
  check('PaymentConfirmed acknowledged by the broker (effects_completed_at set)', effectsDone === 't');

  // ---- a wallet purchase debits once ----
  const bigTopup = must(await call('/wallet/topup', { method: 'POST', token: learner.token, body: { amount_etb: Math.ceil(Number(otherCourse.price_etb)) } }), 'second top-up');
  await race(2, () => mockComplete(bigTopup.tx_ref));
  const before = must(await call('/wallet', { token: learner.token }), 'wallet').balance_etb;
  const walletBuy = await call('/payments/initiate', { method: 'POST', token: learner.token, body: { course_id: otherCourse.id, use_wallet: true } });
  check('a wallet purchase settles instantly', ok(walletBuy) && walletBuy.json.confirmed === true, brief(walletBuy));
  wallet = must(await call('/wallet', { token: learner.token }), 'wallet');
  const debits = wallet.transactions.filter((t) => t.kind === 'purchase' && t.reference === walletBuy.json?.payment_id);
  check('one debit, for the course price', debits.length === 1 && Math.abs(wallet.balance_etb - (before - Number(otherCourse.price_etb))) < 0.01, `${debits.length} debits, balance ${wallet.balance_etb}`);

  // ---- a failed mock checkout fails the payment ----
  const failing = must(await call('/wallet/topup', { method: 'POST', token: learner.token, body: { amount_etb: 50 } }), 'failing top-up');
  const failed = await mockComplete(failing.tx_ref, 'failed');
  const failedView = must(await call(`/payments/${failing.payment_id}`, { token: learner.token }), 'payment detail');
  check('a "failed" mock checkout marks the payment failed', failed.json?.reason === 'failed' && failedView.status === 'failed', `${brief(failed)} / ${failedView.status}`);

  // ---- the webhook authenticates x-chapa-signature only ----
  const body = JSON.stringify({ tx_ref: failing.tx_ref, status: 'success' });
  const unsigned = await call('/payments/webhook/chapa', { method: 'POST', raw: body });
  const constantOnly = await call('/payments/webhook/chapa', { method: 'POST', raw: body, headers: { 'chapa-signature': 'f'.repeat(64) } });
  const forged = await call('/payments/webhook/chapa', { method: 'POST', raw: body, headers: { 'x-chapa-signature': '0'.repeat(64) } });
  check('webhook without a valid x-chapa-signature → 401', [unsigned, constantOnly, forged].every((r) => r.status === 401), [unsigned, constantOnly, forged].map((r) => r.status).join(','));

  // ---- payouts: two concurrent runs over cleared payments ----
  const ours = [checkout.payment_id, walletBuy.json.payment_id].map(uuid).join(', ');
  sql(`UPDATE financial.payments SET webhook_received_at = now() - interval '15 days' WHERE id IN (${ours})`);
  const [[startedAt]] = sql(`SELECT now()`);
  const runs = await race(2, () => call('/payouts/run', { method: 'POST', token: admin.token }));
  check('both payout runs answered', runs.every(ok), runs.map(brief).join('; '));

  const attached = sql(`SELECT p.id, p.payout_id, po.status FROM financial.payments p LEFT JOIN financial.payouts po ON po.id = p.payout_id WHERE p.id IN (${ours})`);
  check('at least one payout was created', attached.some(([, payoutId]) => payoutId), JSON.stringify(attached));
  check('each of our payments is in a paid payout', attached.every(([, payoutId, status]) => payoutId && status === 'paid'), JSON.stringify(attached));
  const payoutIds = [...new Set(attached.map(([, payoutId]) => payoutId).filter(Boolean))];
  for (const id of payoutIds) {
    const [[gross, sum]] = sql(`SELECT po.gross_amount_etb, (SELECT sum(amount_etb) FROM financial.payments WHERE payout_id = po.id) FROM financial.payouts po WHERE po.id = ${uuid(id)}`);
    check(`payout ${id.slice(0, 8)} is exactly its payments`, Number(gross) === Number(sum), `gross ${gross}, payments ${sum}`);
  }
  // One PayoutCompleted per disbursement → one inbox row per paid payout.
  const payees = sql(`SELECT DISTINCT payee_id FROM financial.payouts WHERE paid_at >= '${startedAt}'`).map(([p]) => uuid(p)).join(', ');
  const [[paidCount]] = sql(`SELECT count(*) FROM financial.payouts WHERE paid_at >= '${startedAt}'`);
  const pings = async () => sql(`SELECT count(*) FROM notification.inbox_notifications WHERE type = 'payout' AND user_id IN (${payees}) AND created_at >= '${startedAt}'`)[0][0];
  await waitFor(pings, (n) => Number(n) >= Number(paidCount));
  await sleep(1500);
  const pingCount = await pings();
  check('one disbursement per payout (one PayoutCompleted each)', Number(pingCount) === Number(paidCount), `${pingCount} notifications for ${paidCount} payouts`);

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall payment checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
