#!/usr/bin/env node
/**
 * Broker outage drill (Phase 9a), against a RUNNING local stack started with
 * scripts/start-backend.sh after scripts/demo-seed.mjs. Local only, not in CI:
 * it stops the shared RabbitMQ container for 90 s.
 *
 * Checks that during the outage every service stays up (/health 200, same
 * PIDs), /ready says broker: down, and a request that publishes fails fast
 * with a 503 instead of hanging; and that once RabbitMQ is back every service
 * reconnects on its own and events flow again.
 *
 * Usage: node scripts/e2e-broker-outage.mjs      (exits 1 on any failure)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';
const OUTAGE_MS = Number(process.env.OUTAGE_MS ?? 90_000);
const SERVICES = { auth: 4101, course: 4102, enrollment: 4103, outcomes: 4104, financial: 4105, quality: 4106, notification: 4107 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

const ok = (r) => r.status >= 200 && r.status < 300;
const brief = (r) => `${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`;

async function login(email) {
  const r = await call('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (!ok(r)) throw new Error(`login ${email} failed: ${brief(r)}`);
  return r.json.access_token;
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

function pids() {
  return readFileSync(join(ROOT, '.devlogs/pids'), 'utf8')
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

/** A free course the learner can enrol in, published through the QO queue. */
async function draftAndSubmit(educator, qo, title) {
  const r = await call('/courses', {
    method: 'POST',
    token: educator,
    body: {
      title,
      description: 'A short course used only by the broker outage drill.',
      category: 'other',
      language: 'en',
      pricing_type: 'free',
      thumbnail_url: 'https://example.com/t.png',
      sections: [{ title: 'Only section', is_free_preview: true, lessons: [{ title: 'Only lesson' }] }],
    },
  });
  if (!ok(r)) throw new Error(`draft failed: ${brief(r)}`);
  const id = r.json.id;
  const s = await call(`/courses/${id}/submit`, { method: 'POST', token: educator });
  if (!ok(s)) throw new Error(`submit failed: ${brief(s)}`);
  const item = await until(async () => (await call('/qa/queue', { token: qo })).json?.find((it) => it.course_id === id));
  if (!item) throw new Error(`course ${id} never reached the QO queue`);
  return { id, item };
}

async function main() {
  console.log(`broker outage drill against ${API} (outage ${OUTAGE_MS / 1000} s)`);

  console.log('before');
  const before = pids();
  check('every service process is running', before.every((p) => alive(p.pid)), JSON.stringify(before));
  const readyBefore = await readyAll();
  check('every service is ready', Object.values(readyBefore).every((r) => r.status === 200), JSON.stringify(readyBefore));
  check('/health names the service', (await probe(SERVICES.quality, '/health')).json?.service === 'quality');

  const educator = await login('educator@ethiopialearn.et');
  const qo = await login('qo@ethiopialearn.et');
  const learner = await login('learner@ethiopialearn.et');
  const live = await draftAndSubmit(educator, qo, `Outage drill live ${RUN}`);
  const approve = await call(`/qa/items/${live.item.id}/decision`, { method: 'POST', token: qo, body: { action: 'approve' } });
  check('QO approval before the outage', ok(approve), brief(approve));
  const published = await until(async () => (await call(`/courses/${live.id}`, { token: learner })).json?.status === 'published');
  check('the course is published', !!published);
  const pending = await draftAndSubmit(educator, qo, `Outage drill pending ${RUN}`);

  console.log('outage');
  compose('stop', 'rabbitmq');
  const stoppedAt = Date.now();
  try {
    const down = await until(async () => {
      const ready = await readyAll();
      return Object.values(ready).every((r) => r.status === 503 && r.json?.checks?.broker === 'down') ? ready : null;
    }, 15_000, 1_000);
    check('every /ready says broker: down (503)', !!down, JSON.stringify(await readyAll()));
    check('the database check stays ok', !!down && Object.values(down).every((r) => r.json.checks.db === 'ok'));

    const started = Date.now();
    const decide = await call(`/qa/items/${pending.item.id}/decision`, { method: 'POST', token: qo, body: { action: 'approve' } });
    const tookMs = Date.now() - started;
    check(`a QO decision fails fast with 503 (${tookMs} ms)`, decide.status === 503 && tookMs <= 6_000, brief(decide));
    const reopened = (await call('/qa/queue', { token: qo })).json?.some((it) => it.id === pending.item.id);
    check('the undelivered decision is reverted: the item is still in the queue', !!reopened);

    let healthy = true;
    while (Date.now() - stoppedAt < OUTAGE_MS) {
      const health = await healthAll();
      if (!health.every((h) => h.status === 200)) healthy = false;
      await sleep(5_000);
    }
    check('every /health stayed 200 through the outage', healthy);
    check('no service process exited', before.every((p) => alive(p.pid)), JSON.stringify(before.filter((p) => !alive(p.pid))));
  } finally {
    compose('start', 'rabbitmq');
  }

  console.log('recovery');
  const restartedAt = Date.now();
  const back = await until(async () => {
    const ready = await readyAll();
    return Object.values(ready).every((r) => r.status === 200) ? ready : null;
  }, 60_000, 1_000);
  check(`every service is ready again within 60 s (${Math.round((Date.now() - restartedAt) / 1000)} s)`, !!back, JSON.stringify(await readyAll()));
  check('the same processes, none restarted', before.every((p) => alive(p.pid)));

  const enrol = await call('/enrollments', { method: 'POST', token: learner, body: { course_id: live.id } });
  check('a free enrollment after the outage', ok(enrol), brief(enrol));
  const counted = await until(async () => (await call(`/courses/${live.id}`, { token: learner })).json?.enrolled_count === 1);
  check('EnrollmentCreated reached course: enrolled_count is 1', !!counted, brief(await call(`/courses/${live.id}`, { token: learner })));
  const inbox = await until(async () =>
    (await call('/notifications', { token: learner })).json?.find((n) => n.type === 'enrolled' && n.link === `/learn/${live.id}`),
  );
  check('EnrollmentCreated reached notification: one inbox row', !!inbox);
  const decideAgain = await call(`/qa/items/${pending.item.id}/decision`, { method: 'POST', token: qo, body: { action: 'approve' } });
  check('the reverted decision can be made again', ok(decideAgain), brief(decideAgain));

  console.log(failures ? `\n${failures} check(s) failed` : '\nbroker outage drill passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
