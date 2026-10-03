#!/usr/bin/env node
/**
 * E2E for learning integrity (P1-04, P1-09, P1-10) against a RUNNING stack,
 * after demo-seed (it needs the demo educator and quality officer). It builds
 * its own free course through the API (a stand-in video lesson, a text lesson,
 * a quiz and a project, all optional), publishes it, and enrols a fresh learner.
 *
 *   • five concurrent quiz starts open one attempt (the advisory lock, on real Postgres)
 *   • once max_attempts attempts are finished, a start is refused
 *   • a heartbeat claiming 100% right after the start is recorded but does not
 *     complete the video lesson (the time rule)
 *   • /complete on that video lesson answers 409 with a retry hint, since only
 *     the time is missing; a lesson without video completes through it as before
 *   • a project start with a file size above the cap → 400; without a body it
 *     opens the attempt and issues no upload URL
 *   • a project submit with nothing uploaded → 400
 *
 * Every account and course is fresh per run, so it re-runs on the same database.
 * Usage: node scripts/e2e-learning.mjs
 */
import { existsSync, readFileSync } from 'node:fs';

const API = process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:4000';
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Matches PROJECT_MAX_BYTES in the outcomes service. */
const PROJECT_MAX_BYTES = 50 * 1024 * 1024;

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
const NEW_PASSWORD = `E2e-${RUN}-pass`;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

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

/** A stand-in video: the upload endpoints check type and size, not content. */
async function uploadStandInVideo(educator) {
  const bytes = Buffer.from(`e2e stand-in video ${RUN}`);
  const grant = must(
    await call('/uploads', { method: 'POST', token: educator.token, body: { kind: 'video', filename: `e2e-${RUN}.mp4`, content_type: 'video/mp4', size: bytes.length } }),
    'video upload grant',
  );
  const put = await fetch(grant.upload_url, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'video/mp4' } });
  if (!put.ok) throw new Error(`video upload failed: ${put.status}`);
  return grant.key;
}

/** A free, published course with a video lesson, a text lesson, an optional quiz and an optional project. */
async function publishCourse(educator, qo) {
  const videoKey = await uploadStandInVideo(educator);
  const course = must(
    await call('/courses', {
      method: 'POST',
      token: educator.token,
      body: {
        title: `E2E learning integrity ${RUN}`,
        description: 'A throwaway course the learning integrity e2e script builds and publishes on every run.',
        category: 'tech',
        language: 'en',
        pricing_type: 'free',
        sections: [
          {
            title: 'Watch and read',
            is_free_preview: false,
            lessons: [
              { title: 'A video lesson', video_s3_key: videoKey, video_duration_seconds: 600 },
              { title: 'A text lesson', duration_seconds: 300 },
            ],
          },
        ],
      },
    }),
    'create course',
  );

  // Added while the course is a draft, so both are live at once.
  const quiz = must(
    await call('/assessments', {
      method: 'POST',
      token: educator.token,
      body: {
        course_id: course.id,
        type: 'quiz',
        is_required: false,
        pass_score: 50,
        config: {
          shuffle: false, // the served order is the written order, so wrong answers are known
          max_attempts: 2,
          cooldown_minutes: 0,
          questions: [
            { prompt: 'Which tag creates a hyperlink?', options: ['<link>', '<a>'], correct_index: 1 },
            { prompt: 'What does CSS style?', options: ['Pages', 'Databases'], correct_index: 0 },
          ],
        },
      },
    }),
    'create quiz',
  );
  const project = must(
    await call('/assessments', {
      method: 'POST',
      token: educator.token,
      body: { course_id: course.id, type: 'project', is_required: false, config: { instructions: 'Upload a short write-up.' } },
    }),
    'create project',
  );

  must(await call(`/courses/${course.id}/submit`, { method: 'POST', token: educator.token }), 'submit course');
  const queued = await waitFor(
    async () => (await call('/qa/queue', { token: qo.token })).json,
    (queue) => Array.isArray(queue) && queue.some((it) => it.course_id === course.id),
  );
  if (!queued?.some?.((it) => it.course_id === course.id)) throw new Error('the course never reached the QA queue');
  must(await call(`/qa/courses/${course.id}/decision`, { method: 'POST', token: qo.token, body: { action: 'approve' } }), 'approve course');
  const live = await waitFor(
    async () => (await call(`/courses/${course.id}`)).json,
    (c) => c?.status === 'published',
  );
  if (live?.status !== 'published') throw new Error(`the course did not publish (status ${live?.status})`);

  const lessons = live.sections.flatMap((s) => s.lessons);
  const video = lessons.find((l) => l.has_video);
  const text = lessons.find((l) => !l.has_video);
  if (!video || !text) throw new Error('the published course lacks its video or text lesson');
  return { id: course.id, video, text, quiz, project };
}

async function main() {
  console.log(`e2e learning integrity against ${API}`);
  // One login per role; the tokens are reused throughout.
  const admin = await login('admin@ethiopialearn.et', SEED_PASSWORD);
  const educator = await login('educator@ethiopialearn.et', SEED_PASSWORD);
  const qo = await login('qo@ethiopialearn.et', SEED_PASSWORD);
  const learner = await newLearner(admin, 'learning');

  const course = await publishCourse(educator, qo);
  must(await call('/enrollments', { method: 'POST', token: learner.token, body: { course_id: course.id } }), 'enrol');
  console.log(`  (course ${course.id} published, learner enrolled)`);

  // ---- quiz attempt starts ----
  const starts = await Promise.all(Array.from({ length: 5 }, () => call(`/assessments/${course.quiz.id}/attempts`, { method: 'POST', token: learner.token })));
  const ids = new Set(starts.map((r) => r.json?.attempt_id));
  check('5 parallel quiz starts all succeed and share one attempt id', starts.every(ok) && ids.size === 1 && !ids.has(undefined), starts.map(brief).join('; '));

  // Wrong on purpose: with shuffle off, the right answers are [1, 0].
  const submitWrong = (attemptId) => call(`/attempts/${attemptId}/submit`, { method: 'PUT', token: learner.token, body: { answers: [0, 1] } });
  const first = starts[0].json?.attempt_id;
  const done1 = await submitWrong(first);
  check('first attempt submitted (graded, not passed)', ok(done1) && done1.json?.passed !== true, brief(done1));
  const second = await call(`/assessments/${course.quiz.id}/attempts`, { method: 'POST', token: learner.token });
  check('a start after one finished attempt opens a new attempt', ok(second) && !!second.json?.attempt_id && second.json.attempt_id !== first, brief(second));
  const done2 = second.json?.attempt_id ? await submitWrong(second.json.attempt_id) : null;
  check('second attempt submitted (graded, not passed)', !!done2 && ok(done2) && done2.json?.passed !== true, done2 && brief(done2));
  const third = await call(`/assessments/${course.quiz.id}/attempts`, { method: 'POST', token: learner.token });
  check('a start after max_attempts finished attempts is refused', third.status >= 400 && third.status < 500 && /attempts/.test(JSON.stringify(third.json?.message)), brief(third));

  // ---- video lesson watch rule ----
  const heartbeat = (position_seconds) =>
    call(`/progress/lessons/${course.video.id}/video`, { method: 'POST', token: learner.token, body: { position_seconds, duration_seconds: 600 } });
  const begin = await heartbeat(0);
  const claim = await heartbeat(600);
  check('a heartbeat at 100% right after the start is recorded but not completed', ok(begin) && ok(claim) && claim.json?.completed === false && claim.json?.percent_watched >= 90, `${brief(begin)}; ${brief(claim)}`);

  const early = await call(`/progress/lessons/${course.video.id}/complete`, { method: 'POST', token: learner.token });
  check(
    '/complete on the video lesson → 409 with a retry hint',
    early.status === 409 && early.json?.message === 'Finish watching this lesson to complete it.' && early.json?.retry_after_seconds > 0,
    brief(early),
  );

  const control = await call(`/progress/lessons/${course.text.id}/complete`, { method: 'POST', token: learner.token });
  check('/complete on the text lesson succeeds', ok(control), brief(control));

  // ---- project uploads ----
  const startProject = (body) => call(`/assessments/${course.project.id}/attempts`, { method: 'POST', token: learner.token, body });
  const tooBig = await startProject({ file_size: PROJECT_MAX_BYTES + 1 });
  check('a project start above the size cap → 400', tooBig.status === 400 && /50 MB/.test(JSON.stringify(tooBig.json?.message)), brief(tooBig));

  const bare = await startProject();
  check('a project start without a body opens the attempt and issues no upload URL', ok(bare) && !!bare.json?.attempt_id && typeof bare.json?.instructions === 'string' && !('upload_url' in (bare.json ?? {})), brief(bare));

  const sized = await startProject({ file_size: 1024 });
  const attemptId = sized.json?.attempt_id;
  check('a project start with a size returns an upload URL for the same attempt', ok(sized) && !!sized.json?.upload_url && attemptId === bare.json?.attempt_id, brief(sized));
  // Nothing is uploaded to that URL.
  const empty = attemptId && (await call(`/attempts/${attemptId}/submit`, { method: 'PUT', token: learner.token, body: { file_key: sized.json?.file_key } }));
  check('a project submit without an upload → 400', !!empty && empty.status === 400 && empty.json?.message === 'Upload your file before submitting.', empty ? brief(empty) : 'no attempt to submit');

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall learning checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
