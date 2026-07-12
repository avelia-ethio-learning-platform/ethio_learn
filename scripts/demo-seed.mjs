#!/usr/bin/env node
/**
 * End-to-end demo seed — drives the REAL API through the gateway to populate a
 * testable platform:
 *   • uploads a sample video to MinIO (so lessons actually play)
 *   • creates ~8 courses across every category (free / freemium / paid)
 *   • submits each → QO approves → published (exercises the event bus)
 *   • enrolls the learner in a free course, completes it → certificate issued
 *
 * Prereqs: full stack running (`pnpm dev`) AND `pnpm seed` (demo accounts).
 * Usage:   node scripts/demo-seed.mjs
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = process.env.GATEWAY_PUBLIC_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';
const SAMPLE_VIDEO_URL = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

const login = async (email) => (await call('/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).access_token;

/** Download the sample video once (cached in tmp), return its bytes — or null if offline. */
async function loadSampleVideo() {
  const cache = join(tmpdir(), 'ethiopialearn-sample.mp4');
  if (existsSync(cache)) return readFileSync(cache);
  try {
    console.log('→ downloading sample video…');
    const res = await fetch(SAMPLE_VIDEO_URL);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(cache, buf);
    return buf;
  } catch (err) {
    console.warn(`  ! could not fetch sample video (${err.message}) — lessons will have no playable video`);
    return null;
  }
}

/** Upload the video to MinIO via a signed PUT URL; returns the object key (shared by all lessons). */
async function uploadVideo(educatorToken, bytes) {
  if (!bytes) return undefined;
  const grant = await call('/uploads', { method: 'POST', token: educatorToken, body: { kind: 'video', filename: 'sample.mp4', content_type: 'video/mp4' } });
  const put = await fetch(grant.upload_url, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'video/mp4' } });
  if (!put.ok) throw new Error(`video upload failed: ${put.status}`);
  console.log(`→ uploaded sample video to MinIO (${(bytes.length / 1024).toFixed(0)} KB, key ${grant.key})`);
  return grant.key;
}

const COURSES = [
  { title: 'Intro to Web Development in Ethiopia', category: 'tech', pricing_type: 'free',
    description: 'Learn HTML, CSS and JavaScript from scratch with locally relevant projects — build your first website and a portfolio you can share with employers.' },
  { title: 'Python for Data Analysis', category: 'tech', pricing_type: 'paid', price_etb: 450,
    description: 'Go from zero to analysing real datasets with pandas and matplotlib. Practical notebooks, Ethiopian open-data examples, and a capstone project.' },
  { title: 'Starting a Small Business in Addis', category: 'business', pricing_type: 'freemium', price_etb: 300,
    description: 'A practical guide to registering, pricing, and marketing a small business in Ethiopia — the first section is free so you can try before you buy.' },
  { title: 'Digital Marketing with Telegram & TikTok', category: 'business', pricing_type: 'paid', price_etb: 350,
    description: 'Grow a brand on the channels Ethiopians actually use. Content planning, short-form video, and measuring what works.' },
  { title: 'Freelancing on Upwork from Ethiopia', category: 'freelancing', pricing_type: 'free',
    description: 'Set up a winning profile, get paid with Chapa/Payoneer, and land your first international client. Real proposal templates included.' },
  { title: 'Graphic Design with Free Tools', category: 'freelancing', pricing_type: 'freemium', price_etb: 250,
    description: 'Design logos, flyers and social posts using Canva and GIMP. Build a client-ready portfolio without expensive software.' },
  { title: 'First Aid & Home Health Basics', category: 'healthcare', pricing_type: 'free',
    description: 'Essential first-aid, hygiene and home care skills every household should know, taught by an Addis-based nurse.' },
  { title: 'Community Health Worker Foundations', category: 'healthcare', pricing_type: 'paid', price_etb: 500,
    description: 'Foundational training for community health work: maternal health, vaccination outreach, and record-keeping.' },
];

async function main() {
  console.log('→ logging in demo accounts (run `pnpm seed` first if this fails)');
  const educator = await login('educator@ethiopialearn.et');
  const qo = await login('qo@ethiopialearn.et');
  const learner = await login('learner@ethiopialearn.et');

  const videoBytes = await loadSampleVideo();
  const videoKey = await uploadVideo(educator, videoBytes);

  const published = [];
  for (const spec of COURSES) {
    const body = {
      title: spec.title,
      description: spec.description,
      category: spec.category,
      language: 'en',
      pricing_type: spec.pricing_type,
      ...(spec.price_etb ? { price_etb: spec.price_etb } : {}),
      thumbnail_url: `https://placehold.co/640x360/0f766e/white?text=${encodeURIComponent(spec.title.split(' ').slice(0, 2).join(' '))}`,
      sections: [
        {
          title: 'Getting started',
          is_free_preview: true,
          lessons: [
            { title: 'Welcome & overview', duration_seconds: 300, video_s3_key: videoKey },
            { title: 'Setting up', duration_seconds: 540, video_s3_key: videoKey },
          ],
        },
        {
          title: 'Core concepts',
          is_free_preview: false,
          lessons: [
            { title: 'Fundamentals', duration_seconds: 720, video_s3_key: videoKey },
            { title: 'Hands-on practice', duration_seconds: 660, video_s3_key: videoKey },
          ],
        },
      ],
    };
    const course = await call('/courses', { method: 'POST', token: educator, body });
    await call(`/courses/${course.id}/submit`, { method: 'POST', token: educator });
    process.stdout.write(`→ ${spec.title} … submitted`);

    // wait for it to hit the QO queue (event bus), then approve
    let queued = false;
    for (let i = 0; i < 15 && !queued; i++) {
      await sleep(600);
      queued = (await call('/qa/queue', { token: qo })).some((it) => it.course_id === course.id);
    }
    if (!queued) { console.log(' … NOT queued (check quality service)'); continue; }
    await call(`/qa/courses/${course.id}/decision`, { method: 'POST', token: qo, body: { action: 'approve' } });

    let live = false;
    for (let i = 0; i < 15 && !live; i++) {
      await sleep(600);
      live = (await call(`/courses/${course.id}`)).status === 'published';
    }
    console.log(live ? ' → published ✓' : ' → approve sent (publishing…)');
    published.push({ ...spec, id: course.id });
  }

  // Add a quiz to the first tech course so assessments are testable.
  const quizCourse = published.find((c) => c.category === 'tech');
  if (quizCourse) {
    await call('/assessments', {
      method: 'POST',
      token: educator,
      body: {
        course_id: quizCourse.id,
        type: 'quiz',
        is_required: true,
        pass_score: 50,
        config: {
          questions: [
            { prompt: 'What does HTML stand for?', options: ['Hyperlinks and Text Markup Language', 'HyperText Markup Language', 'Home Tool Markup Language'], correct_index: 1 },
            { prompt: 'Which tag creates a hyperlink?', options: ['<a>', '<link>', '<href>'], correct_index: 0 },
          ],
        },
      },
    });
    console.log(`→ added a quiz to "${quizCourse.title}"`);
  }

  // Enroll the learner in a free course and complete every lesson → certificate.
  const freeCourse = published.find((c) => c.pricing_type === 'free' && c.id !== quizCourse?.id) ?? published.find((c) => c.pricing_type === 'free');
  if (freeCourse) {
    await call('/enrollments', { method: 'POST', token: learner, body: { course_id: freeCourse.id } });
    const detail = await call(`/courses/${freeCourse.id}`);
    const lessonIds = detail.sections.flatMap((s) => s.lessons.map((l) => l.id));
    for (const lessonId of lessonIds) await call(`/progress/lessons/${lessonId}/complete`, { method: 'POST', token: learner });
    console.log(`→ learner completed "${freeCourse.title}" (${lessonIds.length} lessons) → certificate issued`);
  }

  console.log(`\n✔ seed complete — ${published.length} published courses with playable video`);
  console.log(`  browse:   ${process.env.WEB_URL ?? 'http://localhost:3000'}`);
  console.log('  accounts: educator@ / learner@ / qo@ / admin@ / institution@ ethiopialearn.et  ·  password ' + PASSWORD);
  console.log('  paid courses → test the mock Chapa checkout as the learner');
}

main().catch((err) => {
  console.error('\n✖ seed failed:', err.message);
  process.exit(1);
});
