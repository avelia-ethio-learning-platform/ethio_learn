#!/usr/bin/env node
// Scheduler client: wakes the sleeping Render free-tier services a job needs, then starts the
// job(s) through the gateway and prints each service's job status. Run by .github/workflows/jobs.yml.
//
//   node scripts/run-jobs.mjs <frequent|daily|financial/sweep|financial/effects|
//                              financial/nudges|financial/payouts|enrollment/inactivity>
//
// Env: JOBS_TOKEN, RENDER_SERVICE_URLS (comma-separated public /health URLs) - both required,
//      except that a local run (GATEWAY_URL + WAKE=0) needs no service URLs and wakes nothing.
//      GATEWAY_URL (optional: gateway base instead of the gateway health URL minus /health),
//      WAKE_INTERVAL_MS / WAKE_TIMEOUT_MS (default 10000 / 180000),
//      POLL_INTERVAL_MS / POLL_TIMEOUT_MS (default 5000 / 120000: how long to wait for the jobs' results).
// Exits 1 when a service stays down (its jobs are skipped, the rest run), a start is refused,
// or a job this run started finished with { failed: true }.
// Test: node --test scripts/run-jobs.test.mjs

// The services each job calls, so a run wakes only those (each wake costs free instance-hours).
// A sleeping peer the job doesn't list here only degrades it safely (e.g. no learner name).
const NEEDS = {
  'financial/sweep': ['financial'], // Chapa verify; the receipt looks the learner up later
  'financial/effects': ['financial'],
  'financial/nudges': ['financial', 'enrollment', 'auth'], // ownership fails closed; the learner's email
  'financial/payouts': ['financial', 'quality', 'auth'], // trust tier (hold days); the payee's email
  'enrollment/inactivity': ['enrollment', 'course'], // lesson ids for progress (fails closed)
};
const groupOf = (jobs) => ({ wake: [...new Set(['gateway', ...jobs.flatMap((j) => NEEDS[j])])], jobs });
const GROUPS = {
  frequent: groupOf(['financial/sweep', 'financial/effects']),
  daily: groupOf(Object.keys(NEEDS)),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

function resolveGroup(arg) {
  if (Object.hasOwn(GROUPS, arg ?? '')) return GROUPS[arg];
  if (Object.hasOwn(NEEDS, arg ?? '')) return groupOf([arg]);
  return fail(`usage: run-jobs.mjs <${[...Object.keys(GROUPS), ...Object.keys(NEEDS)].join('|')}>`);
}

function findUrl(urls, service) {
  return urls.find((u) => {
    try {
      const host = new URL(u).hostname;
      return host.includes(`-${service}.`) || host.startsWith(`${service}.`);
    } catch {
      return false;
    }
  });
}

/** Polls the service's /health until it answers 200; false (logged) when the deadline passes first. */
async function wakeOne(service, url, intervalMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(intervalMs, 1000)) });
      if (res.ok) {
        console.log(`${service}: up`);
        return true;
      }
    } catch {
      // not reachable yet - keep trying until the deadline
    }
    if (Date.now() + intervalMs > deadline) {
      console.log(`${service}: not up after ${timeoutMs / 1000}s (${url})`);
      return false;
    }
    await sleep(intervalMs);
  }
}

/** This run's job is done once its lease is free and it finished after it started. */
const finished = (r) => r && !r.running && r.last_finished_at && Date.parse(r.last_finished_at) >= Date.parse(r.last_started_at);

async function main() {
  const group = resolveGroup(process.argv[2]);
  const token = process.env.JOBS_TOKEN?.trim();
  // A local run: the gateway named directly, nothing woken, no service URLs read.
  const local = process.env.WAKE === '0' && !!process.env.GATEWAY_URL;
  const urls = local ? [] : (process.env.RENDER_SERVICE_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!token || (!local && urls.length === 0)) fail('JOBS_TOKEN and RENDER_SERVICE_URLS must be set (see DEPLOYMENT.md)');

  const serviceUrls = {};
  if (!local) {
    for (const s of group.wake) {
      serviceUrls[s] = findUrl(urls, s);
      if (!serviceUrls[s] && !(s === 'gateway' && process.env.GATEWAY_URL)) fail(`no URL for service "${s}" in RENDER_SERVICE_URLS`);
    }
  }
  const gatewayBase = (process.env.GATEWAY_URL ?? serviceUrls.gateway.replace(/\/health\/?$/, '')).replace(/\/$/, '');

  // One slow service skips only the jobs that need it; the run still fails at the end.
  let failed = false;
  const down = new Set();
  if (!local) {
    const interval = Number(process.env.WAKE_INTERVAL_MS) || 10000;
    const timeout = Number(process.env.WAKE_TIMEOUT_MS) || 180000;
    const woken = group.wake.filter((s) => serviceUrls[s]);
    const up = await Promise.all(woken.map((s) => wakeOne(s, serviceUrls[s], interval, timeout)));
    woken.forEach((s, i) => !up[i] && down.add(s));
    if (down.has('gateway')) fail('gateway: not up, no job can start');
    if (down.size) failed = true;
  }

  const auth = { Authorization: `Bearer ${token}` };
  const mine = []; // jobs this run started, polled below
  for (const job of group.jobs) {
    const missing = NEEDS[job].filter((s) => down.has(s));
    if (missing.length) {
      console.log(`${job}: skipped, ${missing.join(', ')} not up`);
      continue;
    }
    try {
      const res = await fetch(`${gatewayBase}/api/v1/jobs/${job}`, { method: 'POST', headers: auth });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) {
        console.log(`${job}: ${body.started === false ? 'already running' : 'started'}`);
        if (body.started !== false) mine.push(job);
      } else {
        console.log(`${job}: HTTP ${res.status}`);
        failed = true;
      }
    } catch (err) {
      console.log(`${job}: request failed (${err.message})`);
      failed = true;
    }
  }

  // Wait for this run's jobs to finish, then judge their results (not the previous run's).
  const services = [...new Set(group.jobs.map((j) => j.split('/')[0]))];
  const pollEvery = Number(process.env.POLL_INTERVAL_MS) || 5000;
  const pollUntil = Date.now() + (Number(process.env.POLL_TIMEOUT_MS) || 120000);
  let rows = {};
  for (;;) {
    rows = {};
    for (const service of services) {
      try {
        const res = await fetch(`${gatewayBase}/api/v1/jobs/${service}`, { headers: auth });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        for (const r of await res.json()) rows[`${service}/${r.name}`] = r;
      } catch (err) {
        console.log(`${service}: status unavailable (${err.message})`);
      }
    }
    if (mine.every((job) => finished(rows[job])) || Date.now() + pollEvery > pollUntil) break;
    await sleep(pollEvery);
  }
  for (const [job, r] of Object.entries(rows)) {
    console.log(`${job}: started=${r.last_started_at} finished=${r.last_finished_at} running=${r.running} result=${JSON.stringify(r.last_result)}`);
  }
  for (const job of mine) {
    const r = rows[job];
    if (!finished(r)) console.log(`${job}: still running at the end of the wait; its result shows on the next run`);
    else if (r.last_result?.failed === true) {
      console.log(`${job}: FAILED (see the service log)`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}

main();
