#!/usr/bin/env node
/**
 * Retry and park drill (Phase 9a), on the real broker, against a RUNNING local
 * stack started with scripts/start-backend.sh after scripts/demo-seed.mjs.
 * Local only, not in CI: it restarts the notification service.
 *
 * Notification is restarted with SMTP pointed at a closed local port, a 3 s
 * retry delay and 3 attempts, so a learner's enrollment email fails:
 *   A. it keeps failing → retried twice, then parked in notification.events.parked,
 *      with one inbox row across the attempts;
 *   B. it fails once, then a small SMTP server comes up → the retry sends it,
 *      logs `sent`, and writes no second inbox row.
 * Notification is then restarted on its normal env and the drill's queues cleaned.
 *
 * Needs DATABASE_URL in the environment (the stack's database) and docker compose.
 * Usage: node scripts/e2e-retry-drill.mjs      (exits 1 on any failure)
 */
import { execFileSync, spawn } from 'node:child_process';
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';
const DB = new URL(process.env.DATABASE_URL).pathname.slice(1);
const SMTP_PORT = 2626;
const PIDS = join(ROOT, '.devlogs/pids');
const LOG = join(ROOT, '.devlogs/notification.log');
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function login(email) {
  const r = await call('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status !== 200 && r.status !== 201) throw new Error(`login ${email} failed: ${r.status}`);
  return r.json.access_token;
}

async function until(fn, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  return null;
}

const docker = (...args) => execFileSync('docker', ['compose', ...args], { cwd: ROOT }).toString();
const sql = (query) => docker('exec', '-T', 'postgres', 'sh', '-c', `psql -U "$POSTGRES_USER" -d ${DB} -Atc "${query}"`).trim();
const rabbitmqctl = (...args) => docker('exec', '-T', 'rabbitmq', 'rabbitmqctl', '-q', ...args);
function queueDepth(name) {
  const row = rabbitmqctl('list_queues', 'name', 'messages')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([queue]) => queue === name);
  return row ? Number(row[1]) : null;
}

/** Restarts notification as start-backend.sh runs it, with `extraEnv` on top. */
async function restartNotification(extraEnv) {
  const lines = readFileSync(PIDS, 'utf8').split('\n').filter(Boolean);
  const current = lines.find((line) => line.endsWith(' notification'));
  if (current) {
    try {
      process.kill(Number(current.split(' ')[0]), 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await until(async () => !(await fetch('http://localhost:4107/health').catch(() => null)), 10_000);
  const log = openSync(LOG, 'a');
  const child = spawn('node', [join(ROOT, 'api/services/notification/dist/main.js')], {
    cwd: join(ROOT, 'api'),
    env: { ...process.env, PORT: '4107', ...extraEnv },
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  writeFileSync(PIDS, [...lines.filter((line) => line !== current), `${child.pid} notification`].join('\n') + '\n');
  return !!(await until(async () => (await fetch('http://localhost:4107/ready').catch(() => null))?.status === 200, 30_000));
}

/** A free course, approved by the QO, so the learner can enrol in it. */
async function freeCourse(educator, qo, title) {
  const draft = await call('/courses', {
    method: 'POST',
    token: educator,
    body: {
      title,
      description: 'A short course used only by the retry drill.',
      category: 'other',
      language: 'en',
      pricing_type: 'free',
      thumbnail_url: 'https://example.com/t.png',
      sections: [{ title: 'Only section', is_free_preview: true, lessons: [{ title: 'Only lesson' }] }],
    },
  });
  const id = draft.json.id;
  await call(`/courses/${id}/submit`, { method: 'POST', token: educator });
  const item = await until(async () => (await call('/qa/queue', { token: qo })).json?.find((it) => it.course_id === id));
  await call(`/qa/items/${item.id}/decision`, { method: 'POST', token: qo, body: { action: 'approve' } });
  if (!(await until(async () => (await call(`/courses/${id}`, { token: educator })).json?.status === 'published'))) {
    throw new Error(`course ${id} was not published`);
  }
  return id;
}

/** The smallest SMTP server nodemailer talks to: accepts every message. */
function smtpSink(received) {
  return net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    socket.write('220 drill ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(Date.now());
            socket.write('250 queued\r\n');
          }
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250 drill\r\n');
        else if (command === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (command === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
}

/** The enrollment email's event: its log rows (oldest first) and its inbox rows. */
function enrollmentEvent(courseTitle) {
  const eventId = sql(
    `SELECT event_id FROM notification.notification_log WHERE event_type = 'EnrollmentCreated' AND subject LIKE '%${courseTitle}%' ORDER BY sent_at LIMIT 1`,
  );
  if (!eventId) return null;
  return {
    eventId,
    log: sql(`SELECT status FROM notification.notification_log WHERE event_id = '${eventId}' ORDER BY sent_at`).split('\n').filter(Boolean),
    inbox: Number(sql(`SELECT count(*) FROM notification.inbox_notifications WHERE source_event_id = '${eventId}'`)),
  };
}

async function main() {
  console.log(`retry drill against ${API} (database ${DB})`);
  const educator = await login('educator@ethiopialearn.et');
  const qo = await login('qo@ethiopialearn.et');
  const learner = await login('learner@ethiopialearn.et');
  const parkTitle = `Retry drill park ${RUN}`;
  const retryTitle = `Retry drill retry ${RUN}`;
  const parkCourse = await freeCourse(educator, qo, parkTitle);
  const retryCourse = await freeCourse(educator, qo, retryTitle);
  const parkedBefore = queueDepth('notification.events.parked') ?? 0;

  console.log('notification restarted: SMTP on a closed port, retry delay 3 s, 3 attempts');
  check(
    'notification ready',
    await restartNotification({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(SMTP_PORT),
      SMTP_FALLBACK_PORT: String(SMTP_PORT),
      SMTP_SECURE: 'false',
      EVENT_RETRY_DELAY_MS: '3000',
      EVENT_MAX_ATTEMPTS: '3',
    }),
  );
  check('a retry queue named for the delay exists', queueDepth('notification.events.retry.3s') === 0);

  try {
    console.log('A: the send keeps failing');
    const startA = Date.now();
    await call('/enrollments', { method: 'POST', token: learner, body: { course_id: parkCourse } });
    const parked = await until(async () => queueDepth('notification.events.parked') === parkedBefore + 1, 30_000);
    const secondsA = (Date.now() - startA) / 1000;
    check(`parked after 3 attempts, ${secondsA.toFixed(1)} s (two 3 s delays)`, !!parked && secondsA >= 6);
    const a = enrollmentEvent(parkTitle);
    check('each attempt logged failed', JSON.stringify(a?.log) === '["failed","failed","failed"]', JSON.stringify(a));
    check('one inbox row across the 3 attempts', a?.inbox === 1, JSON.stringify(a));
    const parkedLine = readFileSync(LOG, 'utf8').split('\n').filter((line) => line.includes('event parked: EnrollmentCreated')).pop();
    check('the error log names the parked event and handler', !!parkedLine);
    if (parkedLine) console.log(`    ${parkedLine.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 300)}`);

    console.log('B: the first send fails, the retry succeeds');
    const received = [];
    const sink = smtpSink(received);
    const startB = Date.now();
    await call('/enrollments', { method: 'POST', token: learner, body: { course_id: retryCourse } });
    const firstFailed = await until(async () => enrollmentEvent(retryTitle)?.log.length === 1, 15_000);
    await new Promise((resolve) => sink.listen(SMTP_PORT, '127.0.0.1', resolve));
    const sent = await until(async () => enrollmentEvent(retryTitle)?.log.includes('sent'), 20_000);
    const b = enrollmentEvent(retryTitle);
    check(
      `the first attempt failed, the retry sent it, ${((Date.now() - startB) / 1000).toFixed(1)} s`,
      !!firstFailed && !!sent && JSON.stringify(b?.log) === '["failed","sent"]',
      JSON.stringify(b),
    );
    check('one inbox row after the successful retry', b?.inbox === 1, JSON.stringify(b));
    check('the SMTP server got exactly one message', received.length === 1, String(received.length));
    check('nothing more was parked', queueDepth('notification.events.parked') === parkedBefore + 1);
    await new Promise((resolve) => sink.close(resolve));
  } finally {
    console.log('restore: notification on its normal env, drill queues cleaned');
    check('notification ready again', await restartNotification({}));
    if (parkedBefore === 0) rabbitmqctl('purge_queue', 'notification.events.parked');
    rabbitmqctl('delete_queue', 'notification.events.retry.3s');
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nretry drill passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
