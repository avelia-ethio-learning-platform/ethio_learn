// node --test scripts/run-jobs.test.mjs  (stub gateway; no real services)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const TOKEN = 'test-jobs-token';

async function stub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req, res, requests);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { requests, port: server.address().port, close: () => server.close() };
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/run-jobs.mjs', ...args], {
      env: { PATH: process.env.PATH, WAKE_INTERVAL_MS: '200', WAKE_TIMEOUT_MS: '20000', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const urlsFor = (port) =>
  ['gateway', 'financial'].map((s) => `http://${s}.localhost:${port}/health`).join(',');

function jobsHandler(started) {
  return (req, res) => {
    if (req.url === '/health') return res.writeHead(200).end('ok');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end('{}');
    res.writeHead(req.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' });
    if (req.method === 'GET') return res.end(JSON.stringify([{ name: 'sweep', last_started_at: 'T1', last_finished_at: 'T2', last_result: { n: 1 }, running: false }]));
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
  assert.match(r.out, /financial\/nudges: started/);
  assert.match(r.out, /financial\/sweep: started=T1/);
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
