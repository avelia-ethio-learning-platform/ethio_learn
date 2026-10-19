// node --test scripts/run-jobs.test.mjs  (stub gateway; no real services)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const TOKEN = 'test-jobs-token';

async function stub(handler) {
  const requests = [];
  const hosts = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/health') hosts.push(req.headers.host.split('.')[0]);
    handler(req, res, requests);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { requests, hosts, port: server.address().port, close: () => server.close() };
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/run-jobs.mjs', ...args], {
      env: { PATH: process.env.PATH, WAKE_INTERVAL_MS: '200', WAKE_TIMEOUT_MS: '20000', POLL_INTERVAL_MS: '100', POLL_TIMEOUT_MS: '3000', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const urlsFor = (port) =>
  ['gateway', 'financial'].map((s) => `http://${s}.localhost:${port}/health`).join(',');

const T1 = '2026-10-19T02:15:00.000Z';
const T2 = '2026-10-19T02:15:01.000Z';
const JOBS = { financial: ['sweep', 'effects', 'nudges', 'payouts'], enrollment: ['inactivity'] };
/** Every job's status row: finished after it started, with `result(service/job)` as its last result. */
const statusRows = (service, result = () => ({ n: 1 })) =>
  JOBS[service].map((name) => ({ name, last_started_at: T1, last_finished_at: T2, last_result: result(`${service}/${name}`), running: false }));

function jobsHandler(started, result) {
  return (req, res) => {
    if (req.url === '/health') return res.writeHead(200).end('ok');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end('{}');
    res.writeHead(req.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' });
    if (req.method === 'GET') return res.end(JSON.stringify(statusRows(req.url.split('/').pop(), result)));
    res.end(JSON.stringify(started(req.url)));
  };
}

test('missing env exits 1 before any request', async () => {
  const s = await stub(jobsHandler(() => ({})));
  const r = await run(['frequent'], { RENDER_SERVICE_URLS: urlsFor(s.port) });
  s.close();
  assert.equal(r.code, 1);
  assert.match(r.out, /JOBS_TOKEN and RENDER_SERVICE_URLS must be set/);
  assert.equal(s.requests.length, 0);
});

test('wake retries a 503 health URL, then started and already-running are printed', async () => {
  let health = 0;
  const s = await stub((req, res, reqs) => {
    if (req.url === '/health' && req.headers.host.startsWith('financial.') && ++health <= 2) return res.writeHead(503).end();
    jobsHandler((url) => (url.endsWith('/effects') ? { job: 'effects', started: false, reason: 'running' } : { job: 'x', started: true }))(req, res, reqs);
  });
  const r = await run(['frequent'], { JOBS_TOKEN: TOKEN, RENDER_SERVICE_URLS: urlsFor(s.port) });
  s.close();
  assert.equal(r.code, 0, r.out);
  assert.ok(health >= 3, 'health retried');
  assert.match(r.out, /financial\/sweep: started/);
  assert.match(r.out, /financial\/effects: already running/);
  assert.match(r.out, new RegExp(`financial/sweep: started=${T1}`));
  // frequent wakes only the gateway and financial
  assert.deepEqual([...new Set(s.hosts)].sort(), ['financial', 'gateway']);
  assert.ok(!r.out.includes(TOKEN));
});

test('a 401 exits 1 and never leaks the token', async () => {
  const s = await stub(jobsHandler(() => ({})));
  const r = await run(['financial/sweep'], { JOBS_TOKEN: 'wrong-jobs-token', RENDER_SERVICE_URLS: urlsFor(s.port) });
  s.close();
  assert.equal(r.code, 1);
  assert.match(r.out, /financial\/sweep: HTTP 401/);
  assert.ok(!r.out.includes('wrong-jobs-token'));
});

test('a service that never wakes exits 1 naming it', async () => {
  const s = await stub((req, res) => res.writeHead(503).end());
  const r = await run(['financial/sweep'], { JOBS_TOKEN: TOKEN, RENDER_SERVICE_URLS: urlsFor(s.port), WAKE_TIMEOUT_MS: '600' });
  s.close();
  assert.equal(r.code, 1);
  assert.match(r.out, /not up after/);
});

test('daily wakes only the services its jobs call, and starts all five jobs', async () => {
  const s = await stub(jobsHandler(() => ({ started: true })));
  const services = ['gateway', 'financial', 'enrollment', 'auth', 'course', 'quality', 'notification', 'outcomes'];
  const urls = services.map((x) => `http://${x}.localhost:${s.port}/health`).join(',');
  const r = await run(['daily'], { JOBS_TOKEN: TOKEN, RENDER_SERVICE_URLS: urls });
  s.close();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([...new Set(s.hosts)].sort(), ['auth', 'course', 'enrollment', 'financial', 'gateway', 'quality']);
  for (const job of ['financial/sweep', 'financial/effects', 'financial/nudges', 'financial/payouts', 'enrollment/inactivity']) assert.match(r.out, new RegExp(`${job}: started`));
});

test('a local run (GATEWAY_URL + WAKE=0) needs no service URLs and wakes nothing', async () => {
  const s = await stub(jobsHandler(() => ({ started: true })));
  const r = await run(['financial/sweep'], { JOBS_TOKEN: TOKEN, GATEWAY_URL: `http://127.0.0.1:${s.port}`, WAKE: '0' });
  s.close();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(s.hosts, []);
  assert.deepEqual(s.requests, ['POST /api/v1/jobs/financial/sweep', 'GET /api/v1/jobs/financial']);
});

test('an unknown group exits 1 with the usage', async () => {
  const r = await run(['payouts'], { JOBS_TOKEN: TOKEN, RENDER_SERVICE_URLS: 'http://gateway.localhost:1/health' });
  assert.equal(r.code, 1);
  assert.match(r.out, /usage: run-jobs.mjs <frequent\|daily\|financial\/sweep/);
});

test("a job this run started that failed exits 1, after the others' results are printed", async () => {
  const s = await stub(jobsHandler(() => ({ started: true }), (job) => (job === 'financial/payouts' ? { failed: true } : { n: 0 })));
  const r = await run(['financial/payouts'], { JOBS_TOKEN: TOKEN, GATEWAY_URL: `http://127.0.0.1:${s.port}`, WAKE: '0' });
  s.close();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /financial\/payouts: FAILED/);
});

test("waits for this run's result: a job still running is polled until it finishes", async () => {
  let polls = 0;
  const s = await stub((req, res, reqs) => {
    if (req.method === 'GET' && req.url === '/api/v1/jobs/financial' && ++polls < 3) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(statusRows('financial').map((row) => ({ ...row, running: true, last_finished_at: null }))));
    }
    jobsHandler(() => ({ started: true }), () => ({ failed: true }))(req, res, reqs);
  });
  const r = await run(['financial/sweep'], { JOBS_TOKEN: TOKEN, GATEWAY_URL: `http://127.0.0.1:${s.port}`, WAKE: '0' });
  s.close();
  assert.ok(polls >= 3, 'polled until finished');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /financial\/sweep: FAILED/);
});

test('one service that never wakes skips only its jobs; the rest run and the run exits 1', async () => {
  const s = await stub((req, res, reqs) => {
    if (req.url === '/health' && req.headers.host.startsWith('quality.')) return res.writeHead(503).end();
    jobsHandler(() => ({ started: true }))(req, res, reqs);
  });
  const services = ['gateway', 'financial', 'enrollment', 'auth', 'course', 'quality'];
  const urls = services.map((x) => `http://${x}.localhost:${s.port}/health`).join(',');
  const r = await run(['daily'], { JOBS_TOKEN: TOKEN, RENDER_SERVICE_URLS: urls, WAKE_TIMEOUT_MS: '600' });
  s.close();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /financial\/payouts: skipped, quality not up/);
  for (const job of ['financial/sweep', 'financial/effects', 'financial/nudges', 'enrollment/inactivity']) assert.match(r.out, new RegExp(`${job}: started$`, 'm'));
});
