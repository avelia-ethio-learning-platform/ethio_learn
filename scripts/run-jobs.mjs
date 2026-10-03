#!/usr/bin/env node
// Scheduler client: wakes the sleeping Render free-tier services a job needs, then starts the
// job(s) through the gateway and prints each service's job status. Run by .github/workflows/jobs.yml.
//
//   node scripts/run-jobs.mjs <frequent|payouts|inactivity|financial/sweep|financial/effects|
//                              financial/nudges|financial/payouts|enrollment/inactivity>
//
// Env: JOBS_TOKEN, RENDER_SERVICE_URLS (comma-separated public /health URLs) - both required.
//      GATEWAY_URL (optional, local runs: gateway base instead of the gateway health URL minus /health),
//      WAKE=0 (with GATEWAY_URL: skip waking), WAKE_INTERVAL_MS / WAKE_TIMEOUT_MS (default 10000 / 90000).
// Test: node --test scripts/run-jobs.test.mjs

const GROUPS = {
  frequent: { wake: ['gateway', 'financial'], jobs: ['financial/sweep', 'financial/effects', 'financial/nudges'] },
  payouts: { wake: ['gateway', 'financial', 'auth'], jobs: ['financial/payouts'] },
  inactivity: { wake: ['gateway', 'enrollment', 'course'], jobs: ['enrollment/inactivity'] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

function resolveGroup(arg) {
  if (GROUPS[arg]) return GROUPS[arg];
  const m = /^(financial|enrollment)\/(sweep|effects|nudges|payouts|inactivity)$/.exec(arg ?? '');
  if (!m) fail(`usage: run-jobs.mjs <${Object.keys(GROUPS).join('|')}|financial/<job>|enrollment/inactivity>`);
  const wake = ['gateway', m[1]];
  if (arg === 'financial/payouts') wake.push('auth');
  if (arg === 'enrollment/inactivity') wake.push('course');
  return { wake, jobs: [arg] };
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

async function wakeOne(service, url, intervalMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(intervalMs, 1000)) });
      if (res.ok) return console.log(`${service}: up`);
    } catch {
      // not reachable yet - keep trying until the deadline
    }
    if (Date.now() + intervalMs > deadline) return fail(`${service}: not up after ${timeoutMs / 1000}s (${url})`);
    await sleep(intervalMs);
  }
}

async function main() {
  const group = resolveGroup(process.argv[2]);
  const token = process.env.JOBS_TOKEN?.trim();
  const urls = (process.env.RENDER_SERVICE_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!token || urls.length === 0) fail('JOBS_TOKEN and RENDER_SERVICE_URLS must be set (see DEPLOYMENT.md)');

  const serviceUrls = {};
  for (const s of group.wake) {
    serviceUrls[s] = findUrl(urls, s);
    if (!serviceUrls[s] && !(s === 'gateway' && process.env.GATEWAY_URL)) fail(`no URL for service "${s}" in RENDER_SERVICE_URLS`);
  }
  const gatewayBase = (process.env.GATEWAY_URL ?? serviceUrls.gateway.replace(/\/health\/?$/, '')).replace(/\/$/, '');

  if (!(process.env.WAKE === '0' && process.env.GATEWAY_URL)) {
    const interval = Number(process.env.WAKE_INTERVAL_MS) || 10000;
    const timeout = Number(process.env.WAKE_TIMEOUT_MS) || 90000;
    await Promise.all(group.wake.filter((s) => serviceUrls[s]).map((s) => wakeOne(s, serviceUrls[s], interval, timeout)));
  }

  const auth = { Authorization: `Bearer ${token}` };
  let failed = false;
  for (const job of group.jobs) {
    try {
      const res = await fetch(`${gatewayBase}/api/v1/jobs/${job}`, { method: 'POST', headers: auth });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202) console.log(`${job}: ${body.started === false ? 'already running' : 'started'}`);
      else {
        console.log(`${job}: HTTP ${res.status}`);
        failed = true;
      }
    } catch (err) {
      console.log(`${job}: request failed (${err.message})`);
      failed = true;
    }
  }

  for (const service of [...new Set(group.jobs.map((j) => j.split('/')[0]))]) {
    try {
      const res = await fetch(`${gatewayBase}/api/v1/jobs/${service}`, { headers: auth });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const r of await res.json()) {
        console.log(`${service}/${r.name}: started=${r.last_started_at} finished=${r.last_finished_at} running=${r.running} result=${JSON.stringify(r.last_result)}`);
      }
    } catch (err) {
      console.log(`${service}: status unavailable (${err.message})`);
    }
  }
  if (failed) process.exit(1);
}

main();
