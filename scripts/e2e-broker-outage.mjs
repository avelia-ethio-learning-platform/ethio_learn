#!/usr/bin/env node
/**
 * Broker outage drill (Phases 9a and 9b), against a RUNNING local stack started
 * with scripts/start-backend.sh after scripts/demo-seed.mjs. Local only, not in
 * CI: it stops the shared RabbitMQ container for 90 s, and kills and restarts
 * the auth service once.
 *
 * 9a: during the outage every service stays up (/health 200, no process exits
 * on its own) and /ready says broker: down; once RabbitMQ is back every
 * service reconnects on its own and events flow again.
 *
 * 9b (the outbox): with RabbitMQ stopped, five actions commit and answer 2xx in
 * under 1 s, each leaving its event unpublished in its service's `outbox`:
 * completing a course, an admin approving a refund, a new user registering, an
 * admin raising a fraud flag, and a QO approving a queued course (the item
 * leaves the queue; nothing reverts). Then a crash between commit and publish:
 * auth, holding the unpublished UserRegistered, is killed with SIGKILL and
 * started again from dist. Once RabbitMQ is back and every service is ready,
 * the relays deliver within two ticks (OUTBOX_POLL_MS, default 5 s): a
 * certificate, access revoked, one verification email, a payout hold, and the
 * course published into enrollment's course cache; every one of those outbox
 * rows is marked published.
 *
 * Reads rows through the compose Postgres container's own credentials, in the
 * database DATABASE_URL names. Usage: node scripts/e2e-broker-outage.mjs
 * (exits 1 on any failure)
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, readlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';
const OUTAGE_MS = Number(process.env.OUTAGE_MS ?? 90_000);
const POLL_MS = Number(process.env.OUTBOX_POLL_MS ?? 5_000);
const SERVICES = { auth: 4101, course: 4102, enrollment: 4103, outcomes: 4104, financial: 4105, quality: 4106, notification: 4107 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const NEW_PASSWORD = `Drill-${RUN}-pass`;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A variable from the environment, else from the api env file the stack uses. */
function apiEnv(name) {
  if (process.env[name]) return process.env[name];
  for (const file of ['api/.env', 'api/.env.example']) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    const line = readFileSync(path, 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim();
  }
  throw new Error(`${name} is not set and no api/.env(.example) defines it`);
}
/** The database the services use (its name only; the container supplies the credentials). */
const DB_NAME = new URL(apiEnv('DATABASE_URL')).pathname.slice(1);

/** One SQL statement through the compose Postgres container; rows as arrays of fields. */
function sql(statement) {
  const res = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'sh', '-c', 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -At -F "|" -c "$0"', statement, DB_NAME],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`psql failed: ${res.stderr.trim()}`);
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|'));
}
const uuid = (id) => {
  if (!/^[0-9a-f-]{36}$/.test(id ?? '')) throw new Error(`not a uuid: ${id}`);
  return `'${id}'`;
};

/** One request. Credential endpoints share a per-IP limit, so outside the timed actions a 429 there waits and retries. */
async function call(path, { method = 'GET', token, body, retry = true } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && retry && path.startsWith('/auth/') && attempt < 6) {
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

async function login(email, password = PASSWORD) {
  const r = must(await call('/auth/login', { method: 'POST', body: { email, password } }), `login ${email}`);
  return { token: r.access_token, id: r.user?.id };
}

/** Self-signup, verified by the platform admin (no inbox in a drill), then logged in. */
async function newLearner(admin, label) {
  const email = `${label}-${RUN}@e2e.test`;
  const r = must(await call('/auth/signup', { method: 'POST', body: { email, name: `Drill ${label} ${RUN}`, password: NEW_PASSWORD, role: 'learner' } }), `signup ${email}`);
  must(await call(`/admin/users/${r.user_id}/verify-email`, { method: 'POST', token: admin.token }), `verify ${email}`);
  return { email, ...(await login(email, NEW_PASSWORD)) };
}

/** Poll until fn() returns a truthy value. */
async function until(fn, timeoutMs = 10_000, everyMs = 400) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}

async function probe(port, path) {
  try {
    const res = await fetch(`http://localhost:${port}${path}`, { signal: AbortSignal.timeout(5_000) });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch (err) {
    return { status: 0, json: { error: err.message } };
  }
}

const readyAll = async () => Object.fromEntries(await Promise.all(Object.entries(SERVICES).map(async ([name, port]) => [name, await probe(port, '/ready')])));
const healthAll = async () => Promise.all([4000, ...Object.values(SERVICES)].map((port) => probe(port, '/health')));

const PIDS = join(ROOT, '.devlogs/pids');
function pids() {
  return readFileSync(PIDS, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(' '))
    .map(([pid, name]) => ({ pid: Number(pid), name }));
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const compose = (...args) => execFileSync('docker', ['compose', ...args], { cwd: ROOT, stdio: 'pipe' });

/** A free course, submitted and waiting in the QO queue. */
async function draftAndSubmit(educator, qo, title, lessons = 1) {
  const r = await call('/courses', {
    method: 'POST',
    token: educator.token,
    body: {
      title,
      description: 'A short course used only by the broker outage drill.',
      category: 'other',
      language: 'en',
      pricing_type: 'free',
      thumbnail_url: 'https://example.com/t.png',
      sections: [{ title: 'Only section', is_free_preview: true, lessons: Array.from({ length: lessons }, (_, i) => ({ title: `Lesson ${i + 1}` })) }],
    },
  });
  if (!ok(r)) throw new Error(`draft failed: ${brief(r)}`);
  const id = r.json.id;
  const s = await call(`/courses/${id}/submit`, { method: 'POST', token: educator.token });
  if (!ok(s)) throw new Error(`submit failed: ${brief(s)}`);
  const item = await until(async () => (await call('/qa/queue', { token: qo.token })).json?.find((it) => it.course_id === id));
  if (!item) throw new Error(`course ${id} never reached the QO queue`);
  return { id, item };
}

/** The course's lessons, in order (the public outline). */
async function lessonsOf(courseId) {
  return (must(await call(`/courses/${courseId}`), 'course detail').sections ?? []).flatMap((s) => s.lessons ?? []);
}

/** Completes lessons as a learner would: a video lesson only by watching it (a start heartbeat, a wait, then the end). */
async function completeLessons(learner, lessons) {
  const videos = lessons.filter((l) => l.has_video);
  for (const l of videos) must(await call(`/progress/lessons/${l.id}/video`, { method: 'POST', token: learner.token, body: { position_seconds: 0, duration_seconds: 2 } }), 'video heartbeat');
  if (videos.length) await sleep(1100);
  let progress = null;
  for (const l of lessons) {
    progress = must(
      await call(`/progress/lessons/${l.id}/complete`, { method: 'POST', token: learner.token, body: l.has_video ? { position_seconds: 2 } : undefined }),
      `complete lesson ${l.title}`,
    );
  }
  return progress;
}

/** Waits for the learner's entitlement to the course to reach `status` (the access events are asynchronous). */
async function entitlement(learner, courseId) {
  return must(await call('/enrollments', { token: learner.token }), 'enrollments').find((e) => e.course_id === courseId)?.entitlement_status;
}

/** A SQL condition `field = 'id'`, or `false` when the id is missing (its action failed, already reported). */
const eq = (field, id) => (/^[0-9a-f-]{36}$/.test(id ?? '') ? `${field} = '${id}'` : 'false');

/** The outbox rows an action left: `[id, published]` per row, oldest first. Schema and event type are constants here. */
const outboxRows = (schema, eventType, where) =>
  sql(`SELECT id, published_at IS NOT NULL FROM ${schema}.outbox WHERE event_type = '${eventType}' AND ${where} ORDER BY created_at, id`);

/**
 * Kills a service with SIGKILL (no shutdown hooks, so nothing it holds gets a
 * chance to publish) and starts it again the way start-backend.sh does: the
 * same binary, arguments, working directory and environment, detached, logging
 * to .devlogs/<name>.log. Updates .devlogs/pids.
 */
async function crashAndRestart(name) {
  const list = pids();
  const target = list.find((p) => p.name === name);
  if (!target || !alive(target.pid)) throw new Error(`${name} is not running (${PIDS})`);
  const proc = `/proc/${target.pid}`;
  const exe = readlinkSync(`${proc}/exe`);
  const args = readFileSync(`${proc}/cmdline`, 'utf8').split('\0').filter(Boolean).slice(1);
  const cwd = readlinkSync(`${proc}/cwd`);
  const env = Object.fromEntries(
    readFileSync(`${proc}/environ`, 'utf8')
      .split('\0')
      .filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
  );
  process.kill(target.pid, 'SIGKILL');
  const gone = await until(async () => !alive(target.pid), 10_000, 100);
  if (!gone) throw new Error(`${name} (pid ${target.pid}) survived SIGKILL`);

  const log = openSync(join(ROOT, `.devlogs/${name}.log`), 'a');
  writeSync(log, `\n---- ${name} killed (SIGKILL) and restarted by e2e-broker-outage.mjs ----\n`);
  const child = spawn(exe, args, { cwd, env, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  writeFileSync(PIDS, `${list.map((p) => `${p.name === name ? child.pid : p.pid} ${p.name}`).join('\n')}\n`);
  return { killed: target.pid, pid: child.pid };
}

/** Times one request, in ms. */
async function timed(fn) {
  const started = Date.now();
  const r = await fn();
  return { r, ms: Date.now() - started };
}

async function main() {
  console.log(`broker outage drill against ${API} (outage ${OUTAGE_MS / 1000} s, relay tick ${POLL_MS / 1000} s, database ${DB_NAME})`);

  console.log('before');
  const before = pids();
  check('every service process is running', before.every((p) => alive(p.pid)), JSON.stringify(before));
  const readyBefore = await readyAll();
  check('every service is ready', Object.values(readyBefore).every((r) => r.status === 200), JSON.stringify(readyBefore));
  check('/health names the service', (await probe(SERVICES.quality, '/health')).json?.service === 'quality');

  const educator = await login('educator@ethiopialearn.et');
  const qo = await login('qo@ethiopialearn.et');
  const admin = await login('admin@ethiopialearn.et');
  const learner = await newLearner(admin, 'drill-learner');
  const payeeSignup = must(
    await call('/auth/signup', { method: 'POST', body: { email: `drill-payee-${RUN}@e2e.test`, name: `Drill payee ${RUN}`, password: NEW_PASSWORD, role: 'educator' } }),
    'payee signup',
  );
  const payeeId = payeeSignup.user_id;

  // A free course, published through the QO queue, that the learner is one lesson from completing.
  const live = await draftAndSubmit(educator, qo, `Outage drill live ${RUN}`, 2);
  const approve = await call(`/qa/items/${live.item.id}/decision`, { method: 'POST', token: qo.token, body: { action: 'approve' } });
  check('QO approval before the outage', ok(approve), brief(approve));
  const published = await until(async () => (await call(`/courses/${live.id}`, { token: learner.token })).json?.status === 'published');
  check('the course is published', !!published);
  const enrolledLive = await until(async () => ok(await call('/enrollments', { method: 'POST', token: learner.token, body: { course_id: live.id } })));
  check('the learner enrols in it', !!enrolledLive);
  const [firstLesson, lastLesson] = await lessonsOf(live.id);
  const halfway = await completeLessons(learner, [firstLesson]);
  check('the learner is one lesson from completing it (50 %)', halfway?.progress_percent === 50, JSON.stringify(halfway));

  // A paid course bought through the Chapa mock, with a refund waiting for an admin (20–50 % progress).
  const paid = (must(await call('/search?pricing_type=paid&limit=12'), 'catalog').items ?? []).find((c) => Number(c.price_etb) > 0);
  if (!paid) throw new Error('no published paid course: run scripts/demo-seed.mjs first');
  const checkout = must(await call('/payments/initiate', { method: 'POST', token: learner.token, body: { course_id: paid.id } }), 'initiate');
  const confirmed = await call('/payments/mock/complete', { method: 'POST', body: { tx_ref: checkout.tx_ref, outcome: 'success' } });
  check('the paid course is bought through the Chapa mock', confirmed.json?.reason === 'confirmed', brief(confirmed));
  check('its enrollment is active', (await until(async () => (await entitlement(learner, paid.id)) === 'active')) === true);
  const paidLessons = await lessonsOf(paid.id);
  const banded = await completeLessons(learner, paidLessons.slice(0, Math.ceil(paidLessons.length * 0.3)));
  const refundRequest = await call('/refunds', { method: 'POST', token: learner.token, body: { payment_id: checkout.payment_id, reason: 'outage drill' } });
  check(
    `a refund at ${banded?.progress_percent} % waits for an admin`,
    ok(refundRequest) && refundRequest.json.status === 'pending',
    brief(refundRequest),
  );
  const refundId = refundRequest.json?.refund_id;

  // A course submitted and waiting in the QO queue.
  const pending = await draftAndSubmit(educator, qo, `Outage drill pending ${RUN}`);
  check('a second course waits in the QO queue', !!pending.item);

  console.log('outage');
  const newEmail = `drill-signup-${RUN}@e2e.test`;
  const actions = {};
  /** The outbox row each action left: { schema, type, id } (id null when not exactly one). */
  const outbox = {};
  const unpublishedRow = (name, schema, type, where) => {
    const found = outboxRows(schema, type, where);
    outbox[name] = { schema, type, id: found.length === 1 ? found[0][0] : null };
    check(`${schema}.outbox holds ${type}, unpublished`, found.length === 1 && found[0][1] === 'f', JSON.stringify(found));
  };
  const isPublished = ({ schema, type, id }) => id !== null && outboxRows(schema, type, eq('id', id))[0]?.[1] === 't';
  let newUserId = null;
  let flagId = null;
  let restarted = null;
  compose('stop', 'rabbitmq');
  const stoppedAt = Date.now();
  try {
    const down = await until(async () => {
      const ready = await readyAll();
      return Object.values(ready).every((r) => r.status === 503 && r.json?.checks?.broker === 'down') ? ready : null;
    }, 15_000, 1_000);
    check('every /ready says broker: down (503)', !!down, JSON.stringify(await readyAll()));
    check('the database check stays ok', !!down && Object.values(down).every((r) => r.json.checks.db === 'ok'));

    // The five actions: each commits with its event in the outbox and answers without waiting for the broker.
    actions.completion = await timed(() =>
      call(`/progress/lessons/${lastLesson.id}/complete`, { method: 'POST', token: learner.token, body: lastLesson.has_video ? { position_seconds: 2 } : undefined }),
    );
    actions.refund = await timed(() => call(`/refunds/${refundId}/decide`, { method: 'POST', token: admin.token, body: { action: 'approve' } }));
    actions.signup = await timed(() =>
      call('/auth/signup', { method: 'POST', retry: false, body: { email: newEmail, name: `Drill signup ${RUN}`, password: NEW_PASSWORD, role: 'learner' } }),
    );
    actions.fraud = await timed(() =>
      call('/fraud/signals', {
        method: 'POST',
        token: admin.token,
        body: { subject_type: 'user', subject_id: payeeId, signal_type: 'outage_drill', detail: `broker outage drill ${RUN}`, payee_id: payeeId },
      }),
    );
    actions.decision = await timed(() => call(`/qa/items/${pending.item.id}/decision`, { method: 'POST', token: qo.token, body: { action: 'approve' } }));

    const fast = (a) => ok(a.r) && a.ms < 1_000;
    check(`completing the course answers 2xx in under 1 s (${actions.completion.ms} ms)`, fast(actions.completion) && actions.completion.r.json?.progress_percent === 100, brief(actions.completion.r));
    check(`an admin approving the refund answers 2xx in under 1 s (${actions.refund.ms} ms)`, fast(actions.refund) && actions.refund.r.json?.status === 'approved', brief(actions.refund.r));
    check(`a new user registering answers 2xx in under 1 s (${actions.signup.ms} ms)`, fast(actions.signup) && !!actions.signup.r.json?.user_id, brief(actions.signup.r));
    check(`an admin raising a fraud flag answers 2xx in under 1 s (${actions.fraud.ms} ms)`, fast(actions.fraud) && !!actions.fraud.r.json?.id, brief(actions.fraud.r));
    check(`the QO approving the queued course answers 2xx in under 1 s (${actions.decision.ms} ms)`, fast(actions.decision), brief(actions.decision.r));
    const stillQueued = (await call('/qa/queue', { token: qo.token })).json?.some((it) => it.id === pending.item.id);
    check('the decided item left the queue (nothing reverts)', stillQueued === false);

    // Each event waits, unpublished, in its own service's outbox.
    newUserId = actions.signup.r.json?.user_id;
    flagId = actions.fraud.r.json?.id;
    unpublishedRow('completion', 'enrollment', 'CourseCompleted', `${eq(`payload->>'learner_id'`, learner.id)} AND ${eq(`payload->>'course_id'`, live.id)}`);
    unpublishedRow('refund', 'financial', 'RefundApproved', eq(`payload->>'refund_request_id'`, refundId));
    unpublishedRow('signup', 'auth', 'UserRegistered', eq(`payload->>'user_id'`, newUserId));
    unpublishedRow('fraud', 'quality', 'FraudFlagRaised', eq(`payload->>'flag_id'`, flagId));
    unpublishedRow('decision', 'quality', 'CourseReviewed', eq(`payload->>'course_id'`, pending.id));

    // A crash between commit and publish: auth dies holding the unpublished UserRegistered.
    restarted = await crashAndRestart('auth');
    check(`auth killed with SIGKILL (pid ${restarted.killed}) and started again from dist (pid ${restarted.pid})`, alive(restarted.pid));
    const authBack = await until(async () => (await probe(SERVICES.auth, '/health')).status === 200, 30_000, 500);
    check('the restarted auth answers /health without the broker', !!authBack);
    const authReady = await probe(SERVICES.auth, '/ready');
    check('the restarted auth says broker: down', authReady.status === 503 && authReady.json?.checks?.broker === 'down', JSON.stringify(authReady));
    const survived = outboxRows('auth', 'UserRegistered', eq('id', outbox.signup.id));
    check('the UserRegistered row survived the crash, still unpublished', survived.length === 1 && survived[0][1] === 'f', JSON.stringify(survived));

    let healthy = true;
    while (Date.now() - stoppedAt < OUTAGE_MS) {
      const health = await healthAll();
      if (!health.every((h) => h.status === 200)) healthy = false;
      await sleep(5_000);
    }
    check('every /health stayed 200 through the outage (auth after its restart)', healthy);
    const others = before.filter((p) => p.name !== 'auth');
    check('no other service process exited', others.every((p) => alive(p.pid)), JSON.stringify(others.filter((p) => !alive(p.pid))));
  } finally {
    compose('start', 'rabbitmq');
  }

  console.log('recovery');
  const restartedAt = Date.now();
  const back = await until(async () => {
    const ready = await readyAll();
    return Object.values(ready).every((r) => r.status === 200) ? ready : null;
  }, 60_000, 1_000);
  const readyAt = Date.now();
  check(`every service is ready again within 60 s (${Math.round((readyAt - restartedAt) / 1000)} s)`, !!back, JSON.stringify(await readyAll()));
  const now = pids();
  check(
    'the same processes, except auth, restarted once on purpose',
    before.filter((p) => p.name !== 'auth').every((p) => alive(p.pid) && now.find((n) => n.name === p.name)?.pid === p.pid) &&
      now.find((n) => n.name === 'auth')?.pid === restarted?.pid &&
      alive(restarted?.pid),
    JSON.stringify(now),
  );

  // The five effects, each within two relay ticks of the services being ready again.
  const deadline = readyAt + 2 * POLL_MS;
  const effect = async (read, done) => {
    let value = await read();
    while (!done(value) && Date.now() < deadline) {
      await sleep(250);
      value = await read();
    }
    return { done: done(value), value, s: ((Date.now() - readyAt) / 1000).toFixed(1) };
  };
  const count = (statement) => Number(sql(statement)[0][0]);
  const [certificate, revoked, email, hold, course] = await Promise.all([
    effect(() => count(`SELECT count(*) FROM outcomes.certificates WHERE learner_id = ${uuid(learner.id)} AND course_id = ${uuid(live.id)}`), (n) => n === 1),
    effect(() => entitlement(learner, paid.id), (s) => s === 'refunded'),
    effect(() => count(`SELECT count(*) FROM notification.notification_log WHERE event_type = 'UserRegistered' AND recipient = '${newEmail}' AND status = 'sent'`), (n) => n >= 1),
    effect(() => count(`SELECT count(*) FROM financial.payout_holds WHERE ${eq('flag_id', flagId)} AND payee_id = ${uuid(payeeId)}`), (n) => n === 1),
    effect(
      async () => ({
        status: (await call(`/courses/${pending.id}`, { token: learner.token })).json?.status,
        cached: count(`SELECT count(*) FROM enrollment.course_cache WHERE course_id = ${uuid(pending.id)}`),
      }),
      (c) => c.status === 'published' && c.cached === 1,
    ),
  ]);
  const within = `within two relay ticks (${(2 * POLL_MS) / 1000} s)`;
  check(`completion → a certificate is issued ${within}: ${certificate.s} s`, certificate.done, JSON.stringify(certificate.value));
  check(`refund approval → access revoked ${within}: ${revoked.s} s`, revoked.done, JSON.stringify(revoked.value));
  check(`registration → the verification email went out (console provider) ${within}: ${email.s} s`, email.done, JSON.stringify(email.value));
  check(`fraud flag → a payout hold for the payee ${within}: ${hold.s} s`, hold.done, JSON.stringify(hold.value));
  check(`QO approval → the course is published and in enrollment's course cache ${within}: ${course.s} s`, course.done, JSON.stringify(course.value));

  // Every outbox row from the outage is now marked published.
  const marked = await until(async () => Object.values(outbox).every(isPublished), 5_000, 250);
  check(
    'every outbox row from the outage has published_at set',
    !!marked,
    JSON.stringify(Object.fromEntries(Object.entries(outbox).map(([name, row]) => [name, row.id === null ? 'no row' : isPublished(row)]))),
  );

  // The restarted auth published its UserRegistered once: one email, carrying that row's id as its event id.
  await sleep(1_500); // let any duplicate arrive before counting
  const sent = sql(`SELECT event_id FROM notification.notification_log WHERE event_type = 'UserRegistered' AND recipient = '${newEmail}'`);
  check('exactly one verification email logged, for the outbox row', sent.length === 1 && sent[0][0] === outbox.signup?.id, JSON.stringify(sent));
  const printed = readFileSync(join(ROOT, '.devlogs/notification.log'), 'utf8').split(`To: ${newEmail}\n`).length - 1;
  check('the console provider printed it once', printed === 1, `${printed} times`);

  // 9a: events flow again — an enrollment in the course published after the outage.
  const enrol = await call('/enrollments', { method: 'POST', token: learner.token, body: { course_id: pending.id } });
  check('a free enrollment in that course after the outage', ok(enrol), brief(enrol));
  const counted = await until(async () => (await call(`/courses/${pending.id}`, { token: learner.token })).json?.enrolled_count === 1);
  check('EnrollmentCreated reached course: enrolled_count is 1', !!counted, brief(await call(`/courses/${pending.id}`, { token: learner.token })));
  const inbox = await until(async () =>
    (await call('/notifications', { token: learner.token })).json?.find((n) => n.type === 'enrolled' && n.link === `/learn/${pending.id}`),
  );
  check('EnrollmentCreated reached notification: one inbox row', !!inbox);

  const timings = Object.entries(actions)
    .map(([name, a]) => `${name} ${a.ms} ms`)
    .join(', ');
  console.log(`\noutage actions: ${timings}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nbroker outage drill passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
