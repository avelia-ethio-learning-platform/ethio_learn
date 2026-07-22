#!/usr/bin/env node
/**
 * E2E smoke assertions against a RUNNING stack (gateway + services + infra).
 * Complements scripts/demo-seed.mjs (which populates courses/enrollments):
 * run demo-seed first, then this. Verifies the security envelope and the
 * video watch-progress flow end to end. Exits 1 on the first failure.
 *
 * Usage:            node scripts/e2e-smoke.mjs
 * Extra checks:     E2E_CHECK_RATE_LIMIT=1 node scripts/e2e-smoke.mjs
 *                   (hammers the login limiter — leaves your IP throttled for
 *                    ~1 min, so it is off by default outside CI)
 */
const API = process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';

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

async function main() {
  console.log(`e2e smoke against ${API}`);

  // ---- gateway envelope ----
  const health = await fetch(`${API}/health`);
  check('gateway /health is up', health.ok);

  const unknown = await call('/definitely-not-a-route');
  check('unknown route → 404', unknown.status === 404);

  const internal = await call('/internal/users/whoever');
  check('internal route without token → 401', internal.status === 401);

  const spoofed = await fetch(`${API}/api/v1/enrollments`, { headers: { 'x-user-id': 'u1', 'x-user-role': 'learner' } });
  check('spoofed identity headers are stripped → 401', spoofed.status === 401);

  const noAuth = await call('/enrollments');
  check('JWT route without token → 401', noAuth.status === 401);

  const badLogin = await call('/auth/login', { method: 'POST', body: { email: 'learner@ethiopialearn.et', password: 'wrong' } });
  check('wrong password rejected', badLogin.status === 401 || badLogin.status === 400);

  // ---- learner flow: video progress ----
  const login = await call('/auth/login', { method: 'POST', body: { email: 'learner@ethiopialearn.et', password: PASSWORD } });
  check('learner login', login.status === 201 || login.status === 200, JSON.stringify(login.json));
  const token = login.json?.access_token;
  if (!token) throw new Error('cannot continue without a learner token');

  const enrollments = await call('/enrollments', { token });
  const active = (enrollments.json ?? []).find((e) => e.entitlement_status === 'active');
  check('learner has an active enrollment (run demo-seed first)', !!active);
  if (active) {
    const course = await call(`/courses/${active.course_id}`, { token });
    const lesson = course.json?.sections?.flatMap((s) => s.lessons)[0];
    check('enrolled course has lessons', !!lesson);

    if (lesson) {
      const beat = await call(`/progress/lessons/${lesson.id}/video`, {
        method: 'POST',
        token,
        body: { position_seconds: 30, duration_seconds: 100 },
      });
      // ≥ not ===: percent_watched is a high-water mark, so reruns against the
      // same lesson legitimately report an already-higher value.
      check('video heartbeat accepted', beat.status === 201 && beat.json?.percent_watched >= 30, JSON.stringify(beat.json));

      const state = await call(`/enrollments/${active.id}/video-progress`, { token });
      const saved = state.json?.lessons?.find((l) => l.lesson_id === lesson.id);
      check('resume position persisted', saved?.position_seconds === 30 && state.json?.last_lesson_id === lesson.id);

      const finish = await call(`/progress/lessons/${lesson.id}/video`, {
        method: 'POST',
        token,
        body: { position_seconds: 95, duration_seconds: 100 },
      });
      check('≥90% heartbeat accepted', finish.status === 201 && finish.json?.percent_watched >= 90);

      const progress = await call(`/enrollments/${active.id}/progress`, { token });
      const completed = progress.json?.completed_lessons?.some((l) => l.lesson_id === lesson.id);
      check('lesson auto-completed at ≥90% watched', !!completed);

      const rewind = await call(`/progress/lessons/${lesson.id}/video`, {
        method: 'POST',
        token,
        body: { position_seconds: 10, duration_seconds: 100 },
      });
      check('rewind keeps the high-water mark', rewind.json?.percent_watched >= 90 && rewind.json?.position_seconds === 10);

      const invalid = await call(`/progress/lessons/${lesson.id}/video`, {
        method: 'POST',
        token,
        body: { position_seconds: -5, duration_seconds: 'nope' },
      });
      check('invalid heartbeat body rejected', invalid.status === 400);
    }

    // Ownership: another authenticated user must not read this learner's progress.
    const eduLogin = await call('/auth/login', { method: 'POST', body: { email: 'educator@ethiopialearn.et', password: PASSWORD } });
    if (eduLogin.json?.access_token) {
      const foreign = await call(`/enrollments/${active.id}/video-progress`, { token: eduLogin.json.access_token });
      check("other users cannot read someone else's progress", foreign.status === 403);
    }
  }

  // ---- rate limiting (opt-in: pollutes the limiter for ~1 min) ----
  if (process.env.E2E_CHECK_RATE_LIMIT === '1') {
    let limited = false;
    for (let i = 0; i < 15; i += 1) {
      const res = await call('/auth/login', { method: 'POST', body: { email: 'nobody@nowhere.et', password: 'x' } });
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    check('login brute force hits 429', limited);
  }

  if (failures > 0) {
    console.error(`\n${failures} smoke check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall smoke checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
