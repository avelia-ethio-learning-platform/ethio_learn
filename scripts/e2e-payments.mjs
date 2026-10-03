#!/usr/bin/env node
/**
 * E2E for exactly-once payments (P0-04, P0-05, P1-12, P1-14) against a RUNNING
 * stack in CHAPA_MODE=mock, after demo-seed (it needs published paid courses).
 *
 *   • a wallet top-up confirmed by many concurrent mock webhooks is credited
 *     once, with one notification. Reconcile only verifies in live mode, so on
 *     a mock stack the race is webhook against webhook; every path goes through
 *     the same conditional UPDATE, and the cross-path races (webhook against
 *     reconcile, sweep or settlement) are unit tests (payment.service.spec.ts)
 *   • a paid course confirmed concurrently: enrollment active, one receipt in the
 *     inbox, one cashback, and the access event acknowledged (effects_completed_at)
 *   • a wallet purchase debits once; a mock "failed" checkout fails the payment
 *   • the webhook refuses an unsigned or chapa-signature-only request (401)
 *   • two concurrent payout runs over backdated payments: at least one payout,
 *     each payment in exactly one, and one disbursement per payout
 *   • a purchase's cashback is pending and outside the balance; an
 *     auto-approved refund voids it and leaves the balance alone
 *   • a matured cashback (backdated) is released once by two concurrent
 *     wallet reads
 *   • refund against payout, in sequence: a refund under admin review keeps a
 *     cleared payment out of a payout run; once denied, the next run claims it
 *     (the hold and the refund window run 7 days on one clock, so a concurrent
 *     race on a claimable payment could only be auto-denied)
 *   • the same bank transfer recorded twice at once: one payment, one cashback
 *   • a gift refused for a fully used coupon leaves no sponsorship behind
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

/** A Chapa checkout for the course, confirmed by one mock webhook. Returns the checkout (payment_id, tx_ref). */
async function buyCourse(learner, course) {
  const session = must(await call('/payments/initiate', { method: 'POST', token: learner.token, body: { course_id: course.id } }), `initiate ${course.id}`);
  const confirmed = await mockComplete(session.tx_ref);
  if (confirmed.json?.reason !== 'confirmed') throw new Error(`mock confirmation of ${session.tx_ref} failed: ${brief(confirmed)}`);
  return session;
}

/** Waits for the learner's entitlement to the course to turn active (the access event is asynchronous). */
async function waitEnrolled(learner, courseId) {
  const active = (rows) => rows.some((e) => e.course_id === courseId && e.entitlement_status === 'active');
  const rows = await waitFor(async () => must(await call('/enrollments', { token: learner.token }), 'enrollments'), active);
  if (!active(rows)) throw new Error(`no active enrollment in ${courseId}`);
}

/** The spendable balance as stored (a wallet read through the API would release matured credits first). */
const storedBalance = (userId) => Number(sql(`SELECT COALESCE((SELECT balance_etb FROM financial.wallets WHERE user_id = ${uuid(userId)}), 0)`)[0][0]);
const sameAmount = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

async function main() {
  console.log(`e2e payments against ${API}`);
  const admin = await login('admin@ethiopialearn.et', SEED_PASSWORD);
  const learner = await newLearner(admin, 'payer');

  // ---- wallet top-up: many concurrent confirmations, one credit ----
  const topup = must(await call('/wallet/topup', { method: 'POST', token: learner.token, body: { amount_etb: 100 } }), 'top-up');
  const confirms = await race(RACERS, () => mockComplete(topup.tx_ref));
  check('every concurrent webhook answered', confirms.every(ok), confirms.filter((r) => !ok(r)).map(brief).join('; '));
  const mockReasons = confirms.map((r) => r.json?.reason);
  check('exactly one mock webhook confirmed the top-up', mockReasons.filter((r) => r === 'confirmed').length === 1, mockReasons.join(', '));
  const view = must(await call('/payments/reconcile', { method: 'POST', token: learner.token, body: { tx_ref: topup.tx_ref } }), 'reconcile');
  check('reconcile reports the top-up as confirmed', view.status === 'confirmed', view.status);
  let wallet = must(await call('/wallet', { token: learner.token }), 'wallet');
  check('the top-up was credited once', wallet.balance_etb === 100, `balance ${wallet.balance_etb}`);
  check('one top-up movement for the payment', wallet.transactions.filter((t) => t.kind === 'topup' && t.reference === topup.payment_id).length === 1);
  const topupPings = await waitFor(() => inbox(learner.token, 'wallet'), (rows) => rows.length >= 1);
  await sleep(1500); // let any duplicate arrive before counting
  check('one wallet notification for the top-up', (await inbox(learner.token, 'wallet')).length === 1, `${topupPings.length}`);

  // ---- a paid course, confirmed concurrently ----
  const catalog = must(await call('/search?pricing_type=paid&limit=12'), 'catalog').items ?? [];
  const paid = catalog.filter((c) => Number(c.price_etb) > 0);
  if (paid.length < 3) throw new Error('need three published paid courses: run scripts/demo-seed.mjs first');
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

  // New learners and their own purchases from here on, so every run starts
  // clean. Each learner buys a course once; the courses repeat across learners.
  const [firstCourse, secondCourse, thirdCourse] = paid;

  // ---- a purchase's cashback is pending until the refund window passes; a refund voids it ----
  const refunder = await newLearner(admin, 'refunder');
  const startBalance = must(await call('/wallet', { token: refunder.token }), 'wallet').balance_etb;
  const refunded = await buyCourse(refunder, firstCourse);
  wallet = must(await call('/wallet', { token: refunder.token }), 'wallet');
  const held = wallet.transactions.filter((t) => t.kind === 'cashback' && t.reference === refunded.payment_id);
  const heldDays = held.length === 1 ? (new Date(held[0].available_at).getTime() - Date.now()) / 86_400_000 : 0;
  check('the cashback is pending, available in 7 days and an hour', held.length === 1 && held[0].state === 'pending' && heldDays > 7 && heldDays < 7.1, JSON.stringify(held));
  check('the pending cashback is outside the balance', wallet.balance_etb === startBalance && sameAmount(wallet.pending_etb, held[0]?.amount_etb), `balance ${wallet.balance_etb} (was ${startBalance}), pending ${wallet.pending_etb}`);

  await waitEnrolled(refunder, firstCourse.id);
  const autoRefund = await call('/refunds', { method: 'POST', token: refunder.token, body: { payment_id: refunded.payment_id, reason: 'e2e: changed my mind' } });
  check('a refund at 0 % progress is auto-approved', ok(autoRefund) && autoRefund.json.status === 'approved', brief(autoRefund));
  const voided = sql(`SELECT t.state, p.status FROM financial.wallet_transactions t JOIN financial.payments p ON p.id = t.payment_id WHERE t.payment_id = ${uuid(refunded.payment_id)} AND t.kind = 'cashback'`);
  check('the refund voids the pending cashback', voided.length === 1 && voided[0][0] === 'void' && voided[0][1] === 'refunded', JSON.stringify(voided));
  wallet = must(await call('/wallet', { token: refunder.token }), 'wallet');
  check('the refund leaves the balance unchanged', wallet.balance_etb === startBalance && wallet.pending_etb === 0, `balance ${wallet.balance_etb} (was ${startBalance}), pending ${wallet.pending_etb}`);

  // ---- a matured cashback is released once, even by concurrent wallet reads ----
  const matured = await buyCourse(refunder, secondCourse);
  const pendingCashback = sql(`SELECT amount_etb FROM financial.wallet_transactions WHERE payment_id = ${uuid(matured.payment_id)} AND kind = 'cashback' AND state = 'pending'`);
  check('the second purchase holds one pending cashback', pendingCashback.length === 1, JSON.stringify(pendingCashback));
  const cashbackEtb = Number(pendingCashback[0]?.[0] ?? 0);
  sql(`UPDATE financial.wallet_transactions SET available_at = available_at - interval '8 days' WHERE payment_id = ${uuid(matured.payment_id)} AND kind = 'cashback'`);
  sql(`UPDATE financial.payments SET webhook_received_at = webhook_received_at - interval '8 days' WHERE id = ${uuid(matured.payment_id)}`);
  const beforeRelease = storedBalance(refunder.id);
  const reads = await race(2, () => call('/wallet', { token: refunder.token }));
  check('both concurrent wallet reads answered', reads.every(ok), reads.filter((r) => !ok(r)).map(brief).join('; '));
  const afterRelease = storedBalance(refunder.id);
  check('the matured cashback raised the balance exactly once', cashbackEtb > 0 && sameAmount(afterRelease, beforeRelease + cashbackEtb), `before ${beforeRelease}, cashback ${cashbackEtb}, after ${afterRelease}`);
  const released = sql(`SELECT state FROM financial.wallet_transactions WHERE payment_id = ${uuid(matured.payment_id)} AND kind = 'cashback'`);
  check('the released cashback row is available', released.length === 1 && released[0][0] === 'available', JSON.stringify(released));
  wallet = must(await call('/wallet', { token: refunder.token }), 'wallet');
  check('a later wallet read releases nothing more', sameAmount(wallet.balance_etb, afterRelease) && sameAmount(storedBalance(refunder.id), afterRelease) && wallet.pending_etb === 0, `balance ${wallet.balance_etb}, pending ${wallet.pending_etb}`);

  // ---- refund against payout, in sequence: a refund under review keeps the payment out of payouts ----
  const reviewer = await newLearner(admin, 'reviewer');
  const reviewed = await buyCourse(reviewer, thirdCourse);
  await waitEnrolled(reviewer, thirdCourse.id);
  const outline = must(await call(`/courses/${thirdCourse.id}`), 'course detail');
  const lessonIds = (outline.sections ?? []).flatMap((s) => s.lessons ?? []).map((l) => l.id);
  // About a third of the lessons: inside the 20–50 % band an admin reviews.
  let progress = null;
  for (const id of lessonIds.slice(0, Math.ceil(lessonIds.length * 0.3))) {
    progress = must(await call(`/progress/lessons/${id}/complete`, { method: 'POST', token: reviewer.token }), 'complete lesson');
  }
  check('lesson completions put progress in the 20–50 % band', progress?.progress_percent >= 20 && progress?.progress_percent <= 50, `${progress?.progress_percent}% of ${lessonIds.length} lessons`);
  const review = await call('/refunds', { method: 'POST', token: reviewer.token, body: { payment_id: reviewed.payment_id, reason: 'e2e: refund under review' } });
  const [[markedAtRequest]] = sql(`SELECT refund_requested_at IS NOT NULL FROM financial.payments WHERE id = ${uuid(reviewed.payment_id)}`);
  check('an in-window refund at 20–50 % waits for an admin and marks the payment', ok(review) && review.json.status === 'pending' && markedAtRequest === 't', `${brief(review)}; marked ${markedAtRequest}`);
  // Past the payout hold (14 days for a new educator), on the same clock as the refund window.
  sql(`UPDATE financial.payments SET webhook_received_at = now() - interval '15 days', created_at = now() - interval '15 days' WHERE id = ${uuid(reviewed.payment_id)}`);
  const inPayout = () => sql(`SELECT payout_id IS NOT NULL FROM financial.payments WHERE id = ${uuid(reviewed.payment_id)}`)[0][0];
  must(await call('/payouts/run', { method: 'POST', token: admin.token }), 'payout run');
  check('a payout run skips the payment while its refund is under review', inPayout() === 'f', `in a payout: ${inPayout()}`);
  const denial = await call(`/refunds/${review.json?.refund_id}/decide`, { method: 'POST', token: admin.token, body: { action: 'deny' } });
  const [[markedAfterDenial]] = sql(`SELECT refund_requested_at IS NOT NULL FROM financial.payments WHERE id = ${uuid(reviewed.payment_id)}`);
  check("the admin's denial clears the payment's refund mark", ok(denial) && denial.json.status === 'denied' && markedAfterDenial === 'f', `${brief(denial)}; marked ${markedAfterDenial}`);
  must(await call('/payouts/run', { method: 'POST', token: admin.token }), 'payout run');
  check('the next payout run claims the payment', inPayout() === 't', `in a payout: ${inPayout()}`);

  // ---- the same bank transfer recorded twice at once: one payment ----
  const bankReference = `E2E-${RUN}`.toUpperCase();
  const transfer = { learner_id: reviewer.id, course_id: firstCourse.id, bank_reference: bankReference };
  const transfers = await race(2, () => call('/admin/payments/bank-transfer', { method: 'POST', token: admin.token, body: transfer }));
  check('one submit records the transfer (201), the other replays it (200)', transfers.map((r) => r.status).sort().join() === '200,201', transfers.map(brief).join('; '));
  check('both answers carry the same payment', !!transfers[0].json?.id && transfers[0].json.id === transfers[1].json?.id, transfers.map((r) => r.json?.id).join(' vs '));
  const bankRows = sql(`SELECT id, status FROM financial.payments WHERE chapa_tx_ref = 'bank-${bankReference}'`);
  check('one payment for the bank reference, confirmed', bankRows.length === 1 && bankRows[0][1] === 'confirmed', JSON.stringify(bankRows));
  const bankCashback = bankRows.length === 1 ? sql(`SELECT state FROM financial.wallet_transactions WHERE payment_id = ${uuid(bankRows[0][0])} AND kind = 'cashback'`) : [];
  check('one pending cashback for the transfer', bankCashback.length === 1 && bankCashback[0][0] === 'pending', JSON.stringify(bankCashback));

  // ---- a gift refused for a fully used coupon leaves no sponsorship ----
  const coupon = must(await call('/coupons', { method: 'POST', token: admin.token, body: { code: `FULL-${RUN}`, kind: 'percent', value: 100, max_uses: 1, note: 'e2e: fully used' } }), 'coupon');
  const freeBuy = await call('/payments/initiate', { method: 'POST', token: reviewer.token, body: { course_id: secondCourse.id, coupon_code: coupon.code } });
  const [[uses, maxUses]] = sql(`SELECT uses, max_uses FROM financial.coupons WHERE id = ${uuid(coupon.id)}`);
  check("a purchase uses up the coupon's only use", ok(freeBuy) && freeBuy.json.confirmed === true && uses === maxUses, `${brief(freeBuy)}; uses ${uses} of ${maxUses}`);
  const giftCount = () => sql(`SELECT count(*) FROM financial.sponsorships WHERE source = 'gift' AND sponsor_id = ${uuid(refunder.id)}`)[0][0];
  const giftsBefore = giftCount();
  const gift = await call('/gifts', { method: 'POST', token: refunder.token, body: { course_id: thirdCourse.id, recipient_email: `giftee-${RUN}@e2e.test`, coupon_code: coupon.code } });
  check('a gift with the fully used coupon → 400', gift.status === 400 && /fully used/.test(JSON.stringify(gift.json)), brief(gift));
  const giftsAfter = giftCount();
  check("the refused gift leaves the sponsor's gift count unchanged", giftsAfter === giftsBefore, `${giftsBefore} → ${giftsAfter}`);

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
