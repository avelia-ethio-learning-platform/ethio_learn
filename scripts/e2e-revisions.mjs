#!/usr/bin/env node
/**
 * E2E assertions for post-approval re-review, resumable uploads and the AI
 * outline endpoints, against a RUNNING stack (gateway + services + infra).
 * Run scripts/demo-seed.mjs first (it provides published courses + accounts).
 *
 * Covers:
 *   • edits to a live course are staged — learners keep seeing the approved version
 *   • submit → QO queue (kind 'revision', diff) → coach → resubmit → approve → live
 *   • reject and discard leave the live course untouched
 *   • first-time withdraw removes the item from the QO queue
 *   • multipart upload: resume from the server's part list, 409 on missing parts,
 *     attach-on-complete, owner scoping
 *   • lesson video keys must belong to the course's instructor
 *   • generate-structure / apply-structure limits
 *
 * Usage: node scripts/e2e-revisions.mjs      (exits 1 on any failure)
 */
const API = process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Unique per run so re-running against the same database never matches an earlier run's rows. */
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
  return { token: r.json.access_token, id: r.json.user?.id };
}

/** Poll until fn() returns a truthy value (event-bus hops are async). */
async function until(fn, tries = 25, ms = 400) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(ms);
  }
  return null;
}

async function qaItemFor(qo, courseId, kind) {
  return until(async () => {
    const q = await call('/qa/queue', { token: qo });
    return ok(q) ? q.json.find((it) => it.course_id === courseId && (!kind || it.kind === kind)) : null;
  });
}

async function main() {
  console.log(`e2e revisions against ${API}`);
  const educator = await login('educator@ethiopialearn.et');
  const qo = await login('qo@ethiopialearn.et');
  const learner = await login('learner@ethiopialearn.et');

  // ---- pick a live free course of the demo educator ------------------------------------------------
  const own = await call('/courses', { token: educator.token });
  const course = own.json?.find((c) => c.status === 'published' && c.pricing_type === 'free');
  if (!course) throw new Error('no published free course for the demo educator — run scripts/demo-seed.mjs first');
  const C = course.id;
  console.log(`course: ${course.title} (${C})`);
  await call('/enrollments', { method: 'POST', token: learner.token, body: { course_id: C } }); // 409 when already enrolled is fine

  const liveBefore = (await call(`/courses/${C}`)).json;
  const liveTitle = liveBefore.title;
  const liveSectionCount = liveBefore.sections.length;
  const firstLesson = liveBefore.sections[0].lessons[0];
  const lastSection = liveBefore.sections[liveBefore.sections.length - 1];
  const doomedLesson = lastSection.lessons[lastSection.lessons.length - 1];

  // ---- staged edits are invisible to learners -----------------------------------------------------
  console.log('staging');
  let r = await call(`/courses/${C}`, { method: 'PUT', token: educator.token, body: { title: `${liveTitle} (2026 edition)` } });
  check('title edit on a live course is accepted', ok(r), brief(r));
  check('public detail still shows the approved title', (await call(`/courses/${C}`)).json.title === liveTitle);

  r = await call(`/courses/${C}/sections`, {
    method: 'POST',
    token: educator.token,
    body: { title: `Bonus: shipping it (${RUN})`, is_free_preview: false, lessons: [{ title: 'Deploying your project', summary: 'Put the project online so employers can open it.' }] },
  });
  check('section added to a live course', ok(r), brief(r));
  let working = (await call(`/courses/${C}/working`, { token: educator.token })).json;
  const bonus = working.sections.find((s) => s.title === `Bonus: shipping it (${RUN})`);
  check('working view marks the new section as added', bonus?.pending_state === 'added', JSON.stringify(bonus)?.slice(0, 200));
  check('working view keeps the lesson summary', bonus?.lessons?.[0]?.summary?.startsWith('Put the project online'));
  check('working view lists the title as a pending field', working.pending_fields?.includes('title'));
  const bonusLesson = bonus?.lessons?.[0];
  check('public detail has no new section', (await call(`/courses/${C}`)).json.sections.length === liveSectionCount);
  r = await call(`/lessons/${bonusLesson?.id}/stream-url`, { token: learner.token });
  check('learner cannot stream a staged lesson', r.status === 404, brief(r));
  r = await call(`/progress/lessons/${bonusLesson?.id}/complete`, { method: 'POST', token: learner.token });
  check('learner cannot complete a staged lesson', r.status === 404, brief(r));

  r = await call(`/lessons/${firstLesson.id}`, { method: 'PUT', token: educator.token, body: { title: `${firstLesson.title} (updated)` } });
  check('live lesson rename is staged', ok(r), brief(r));
  r = await call(`/lessons/${doomedLesson.id}`, { method: 'DELETE', token: educator.token });
  check('live lesson delete is staged', ok(r) && r.json?.staged === true, brief(r));
  const pub = (await call(`/courses/${C}`)).json;
  check('public detail keeps the old lesson title', pub.sections[0].lessons[0].title === firstLesson.title);
  check('public detail keeps the lesson marked for removal', pub.sections.at(-1).lessons.some((l) => l.id === doomedLesson.id));

  // ---- resumable multipart upload into the staged lesson -----------------------------------------
  console.log('upload');
  const MiB = 1024 * 1024;
  const size = 12 * MiB + 12345; // 2 parts at the 8 MiB minimum part size
  r = await call('/uploads/multipart', {
    method: 'POST',
    token: educator.token,
    body: { kind: 'video', filename: 'deploy walkthrough.mp4', size, content_type: 'video/mp4', lesson_id: bonusLesson?.id },
  });
  check('multipart session created', ok(r) && r.json.part_count === 2 && r.json.part_size === 8 * MiB, brief(r));
  const session = r.json;
  r = await call(`/uploads/multipart/${session.session_id}`, { token: learner.token });
  check("another user cannot read someone's upload session", r.status === 404 || r.status === 403, brief(r));
  r = await call(`/uploads/multipart/${session.session_id}/parts`, { method: 'POST', token: educator.token, body: { part_numbers: [1, 2] } });
  check('part URLs signed', ok(r) && r.json.urls.length === 2, brief(r));
  const urls = Object.fromEntries(r.json.urls.map((u) => [u.part_number, u.url]));
  const bytes = Buffer.alloc(size, 7);
  let put = await fetch(urls[1], { method: 'PUT', body: bytes.subarray(0, 8 * MiB) });
  check('part 1 uploaded to storage', put.ok, `status ${put.status}`);
  // "Browser closed" here — the client resumes from the server's part list.
  r = await call(`/uploads/multipart/${session.session_id}`, { token: educator.token });
  check('status lists part 1 as done', ok(r) && r.json.parts?.length === 1 && r.json.uploaded_bytes === 8 * MiB, brief(r));
  r = await call(`/uploads/multipart/${session.session_id}/complete`, { method: 'POST', token: educator.token, body: {} });
  check('complete with a missing part → 409', r.status === 409, brief(r));
  put = await fetch(urls[2], { method: 'PUT', body: bytes.subarray(8 * MiB) });
  check('part 2 uploaded after resume', put.ok, `status ${put.status}`);
  r = await call(`/uploads/multipart/${session.session_id}/complete`, { method: 'POST', token: educator.token, body: {} });
  check('complete attaches the video to the lesson', ok(r) && r.json.lesson_updated === true && r.json.size === size, brief(r));
  r = await call(`/uploads/multipart/${session.session_id}/complete`, { method: 'POST', token: educator.token, body: {} });
  check('complete is idempotent', ok(r) && r.json.key === session.key, brief(r));
  working = (await call(`/courses/${C}/working`, { token: educator.token })).json;
  check('working view shows the staged lesson has a video', working.sections.find((s) => s.id === bonus?.id)?.lessons[0]?.has_video === true);
  r = await call(`/lessons/${bonusLesson?.id}/stream-url?version=pending`, { token: educator.token });
  check('owner can preview the staged video', ok(r) && typeof r.json.url === 'string', brief(r));

  // ---- lesson video keys must belong to the course's instructor ---------------------------------
  r = await call(`/lessons/${firstLesson.id}`, {
    method: 'PUT',
    token: educator.token,
    body: { video_s3_key: `videos/${qo.id ?? '00000000-0000-0000-0000-000000000000'}/00000000-0000-0000-0000-000000000000-x.mp4` },
  });
  check("attaching another user's video key → 400", r.status === 400, brief(r));
  r = await call(`/lessons/${firstLesson.id}`, {
    method: 'PUT',
    token: educator.token,
    body: { video_s3_key: `videos/${educator.id}/11111111-1111-1111-1111-111111111111-never-uploaded.mp4` },
  });
  check('attaching a key that was never uploaded → 400', r.status === 400, brief(r));

  // ---- diff, submit, lock ---------------------------------------------------------------------------
  console.log('review');
  r = await call(`/courses/${C}/revisions/current/diff`, { token: educator.token });
  const diff = r.json;
  check('diff lists the title change', ok(r) && diff.metadata?.some((m) => m.field === 'title'), brief(r));
  check('diff lists the added section', diff?.sections?.added?.length === 1);
  check('diff lists the removed lesson', diff?.lessons?.removed?.some((l) => l.id === doomedLesson.id));
  check('diff lists the renamed lesson', diff?.lessons?.changed?.some((l) => l.id === firstLesson.id));
  r = await call(`/courses/${C}/revisions/current/diff`, { token: learner.token });
  check('learner cannot read the diff', r.status === 403 || r.status === 404, brief(r));

  r = await call(`/courses/${C}/revisions/submit`, { method: 'POST', token: educator.token, body: { summary: `New bonus section on deploying your project (${RUN})`, major: true } });
  check('revision submitted', ok(r) && r.json.status === 'submitted', brief(r));
  r = await call(`/courses/${C}`, { method: 'PUT', token: educator.token, body: { description: `${liveBefore.description} ` } });
  check('editing while in review → 409', r.status === 409, brief(r));

  let item = await qaItemFor(qo.token, C, 'revision');
  check('revision reaches the QO queue', !!item);
  check('queue item carries a diff summary', item?.diff_summary?.sections_added === 1 && item?.diff_summary?.lessons_removed === 1, JSON.stringify(item?.diff_summary));
  check('revision SLA is 24h', item && new Date(item.sla_deadline) - new Date(item.created_at) === 24 * 3600 * 1000);
  r = await call(`/courses/${C}/revisions/current/diff`, { token: qo.token });
  check('QO can read the diff', ok(r), brief(r));
  r = await call(`/qa/items/${item?.id}/decision`, { method: 'POST', token: qo.token, body: { action: 'flag' } });
  check('flag is not a revision action → 400', r.status === 400, brief(r));
  r = await call(`/qa/items/${item?.id}/decision`, { method: 'POST', token: qo.token, body: { action: 'coach' } });
  check('coach without notes → 400', r.status === 400, brief(r));
  r = await call(`/qa/items/${item?.id}/claim`, { method: 'POST', token: qo.token });
  check('QO claims the item', ok(r), brief(r));
  r = await call(`/qa/items/${item?.id}/decision`, { method: 'POST', token: qo.token, body: { action: 'coach', notes: 'Please add a one-line summary to the deploy lesson video.' } });
  check('QO requests changes', ok(r), brief(r));
  working = await until(async () => {
    const w = (await call(`/courses/${C}/working`, { token: educator.token })).json;
    return w?.revision?.status === 'draft' ? w : null;
  });
  check('coached revision returns to draft with notes', working?.revision?.decision_notes?.includes('one-line summary'));
  check('staged changes are kept after coaching', working?.has_pending_changes === true);
  check('course stays published', working?.status === 'published');

  r = await call(`/courses/${C}/revisions/submit`, { method: 'POST', token: educator.token, body: { summary: `New bonus section on deploying your project (${RUN})`, major: true } });
  check('revision resubmitted', ok(r), brief(r));
  item = await until(async () => {
    const q = await call('/qa/queue', { token: qo.token });
    return q.json.find((it) => it.course_id === C && it.kind === 'revision' && it.status === 'pending') ?? null;
  });
  r = await call(`/qa/items/${item?.id}/decision`, { method: 'POST', token: qo.token, body: { action: 'approve' } });
  check('QO approves the update', ok(r), brief(r));

  const after = await until(async () => {
    const d = (await call(`/courses/${C}`)).json;
    return d?.title === `${liveTitle} (2026 edition)` ? d : null;
  });
  check('approved title is live', !!after);
  check('course is still published (not re-published)', after?.status === 'published');
  check('new section is live', after?.sections?.some((s) => s.title === `Bonus: shipping it (${RUN})`));
  check('removed lesson is gone', !after?.sections?.some((s) => s.lessons.some((l) => l.id === doomedLesson.id)));
  check('renamed lesson is live', after?.sections?.[0]?.lessons?.[0]?.title === `${firstLesson.title} (updated)`);
  r = await call(`/lessons/${bonusLesson?.id}/stream-url`, { token: learner.token });
  check('learner can stream the new lesson', ok(r), brief(r));
  const log = (await call(`/courses/${C}/changelog`)).json;
  const entries = Array.isArray(log) ? log : log?.items ?? [];
  check('one change-log entry was written', entries.filter((e) => (e.summary ?? e.text ?? '').includes(RUN)).length === 1, JSON.stringify(entries).slice(0, 300));
  working = (await call(`/courses/${C}/working`, { token: educator.token })).json;
  check('working copy is clean after apply', working.has_pending_changes === false && !working.revision, JSON.stringify(working.revision));

  // ---- reject leaves the live course untouched --------------------------------------------------
  console.log('reject + discard');
  r = await call(`/courses/${C}`, { method: 'PUT', token: educator.token, body: { description: 'A much worse description that the QO should reject outright.' } });
  check('second edit staged', ok(r), brief(r));
  r = await call(`/courses/${C}/revisions/submit`, { method: 'POST', token: educator.token, body: {} });
  check('second revision submitted', ok(r), brief(r));
  item = await until(async () => {
    const q = await call('/qa/queue', { token: qo.token });
    return q.json.find((it) => it.course_id === C && it.kind === 'revision' && it.status === 'pending') ?? null;
  });
  r = await call(`/qa/items/${item?.id}/decision`, { method: 'POST', token: qo.token, body: { action: 'reject', notes: 'The new description is less clear than the current one.' } });
  check('QO rejects the update', ok(r), brief(r));
  working = await until(async () => {
    const w = (await call(`/courses/${C}/working`, { token: educator.token })).json;
    return w && !w.revision && !w.has_pending_changes ? w : null;
  });
  check('rejected changes are discarded', !!working);
  check('live description unchanged', (await call(`/courses/${C}`)).json.description === after?.description);

  r = await call(`/courses/${C}`, { method: 'PUT', token: educator.token, body: { title: 'Scratch title' } });
  r = await call(`/courses/${C}/revisions/discard`, { method: 'POST', token: educator.token });
  check('educator discards staged changes', ok(r), brief(r));
  working = (await call(`/courses/${C}/working`, { token: educator.token })).json;
  check('nothing pending after discard', working.has_pending_changes === false && working.title === after?.title);

  // ---- first-time submission withdraw clears the QO item ----------------------------------------
  console.log('withdraw');
  r = await call('/courses', {
    method: 'POST',
    token: educator.token,
    body: {
      title: 'E2E withdraw check',
      description: 'A short course used only to check that withdrawing a submission clears the review queue.',
      category: 'other',
      language: 'en',
      pricing_type: 'free',
      thumbnail_url: liveBefore.thumbnail_url ?? 'https://example.com/t.png',
      sections: [{ title: 'Only section', is_free_preview: true, lessons: [{ title: 'Only lesson' }] }],
    },
  });
  check('draft created', ok(r), brief(r));
  const D = r.json?.id;
  r = await call(`/courses/${D}/submit`, { method: 'POST', token: educator.token });
  check('draft submitted', ok(r), brief(r));
  check('submission queued', !!(await qaItemFor(qo.token, D, 'new_course')));
  r = await call(`/courses/${D}/withdraw`, { method: 'POST', token: educator.token });
  check('submission withdrawn', ok(r), brief(r));
  const gone = await until(async () => {
    const q = await call('/qa/queue', { token: qo.token });
    return !q.json.some((it) => it.course_id === D);
  });
  check('withdrawn submission leaves the QO queue', !!gone);

  // ---- AI outline limits -----------------------------------------------------------------------------
  console.log('outline');
  const digest = [
    'DOCUMENT OUTLINE (authoritative order):',
    '1 Getting started',
    '  1.1 Installing the tools',
    '2 Building the first page',
    '  2.1 Structure with HTML',
    '  2.2 Style with CSS',
    '',
    'EXCERPTS:',
    '[1 Getting started] Install a code editor and a browser.',
  ].join('\n');
  r = await call('/courses/generate-structure', { method: 'POST', token: educator.token, body: { title: 'Web basics', source_text: digest, section_count: 2 } });
  check('outline generated from a digest', ok(r) && r.json.sections?.length >= 1, brief(r));
  const tooLong = await call('/courses/generate-structure', { method: 'POST', token: educator.token, body: { title: 'x', source_text: 'a'.repeat(30001) } });
  check('source over 30,000 chars → 400 with a clear message', tooLong.status === 400 && /30,000/.test(JSON.stringify(tooLong.json)), brief(tooLong));
  const thirteen = Array.from({ length: 13 }, (_, i) => ({ title: `Section ${i + 1}`, is_free_preview: false, lessons: [{ title: 'Lesson' }] }));
  r = await call(`/courses/${D}/apply-structure`, { method: 'POST', token: educator.token, body: { sections: thirteen } });
  check('apply-structure rejects more than 12 sections', r.status === 400, brief(r));
  r = await call(`/courses/${D}/apply-structure`, {
    method: 'POST',
    token: educator.token,
    body: { sections: [{ title: 'From the outline', is_free_preview: false, lessons: [{ title: 'Structure with HTML', summary: 'Tags, nesting and semantics.' }] }] },
  });
  check('apply-structure adds sections in one call', ok(r) && r.json.sections_added === 1 && r.json.lessons_added === 1, brief(r));
  await call(`/courses/${D}/archive`, { method: 'POST', token: educator.token });

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall revision/upload/outline checks passed');
}

main().catch((err) => {
  console.error(`✖ ${err?.stack ?? err}`);
  process.exit(1);
});
