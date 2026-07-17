#!/usr/bin/env node
/**
 * End-to-end demo seed — drives the REAL API through the gateway to populate a
 * testable platform:
 *   • uploads a sample video to MinIO if available (so lessons actually play);
 *     video is OPTIONAL — download/upload failures never abort the seed
 *   • creates 15 courses: free, freemium and paid in ALL five categories
 *     (tech / business / freelancing / healthcare / other), each with its own
 *     sections & lessons
 *   • submits each → QO approves → published (exercises the event bus)
 *   • adds a quiz to a tech course; enrolls the learner in a free course and
 *     completes it → certificate issued
 *   • safe to re-run: courses whose titles already exist are skipped
 *
 * Prereqs: full stack running (`pnpm dev`) AND `pnpm seed` (demo accounts).
 * Usage:   node scripts/demo-seed.mjs
 * Env:     SEED_VIDEO_FILE=/path/to/local.mp4  (use a local file, no download)
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

/**
 * Best-effort sample video: local file (SEED_VIDEO_FILE) → tmp cache → download.
 * NEVER throws — returns null when unavailable so seeding continues without video.
 */
async function loadSampleVideo() {
  try {
    const local = process.env.SEED_VIDEO_FILE;
    if (local && existsSync(local)) {
      console.log(`→ using local sample video ${local}`);
      return readFileSync(local);
    }
    const cache = join(tmpdir(), 'ethiopialearn-sample.mp4');
    if (existsSync(cache)) return readFileSync(cache);
    console.log('→ downloading sample video…');
    const res = await fetch(SAMPLE_VIDEO_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(cache, buf);
    return buf;
  } catch (err) {
    console.warn(`  ! no sample video (${err?.message ?? err}) — lessons will be created without playable video`);
    console.warn('    tip: set SEED_VIDEO_FILE=/path/to/any.mp4 to seed playable lessons offline');
    return null;
  }
}

/** Upload the video to MinIO via a signed PUT URL; returns the object key (shared by all lessons). NEVER throws. */
async function uploadVideo(educatorToken, bytes) {
  if (!bytes) return undefined;
  try {
    const grant = await call('/uploads', { method: 'POST', token: educatorToken, body: { kind: 'video', filename: 'sample.mp4', content_type: 'video/mp4' } });
    const put = await fetch(grant.upload_url, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'video/mp4' } });
    if (!put.ok) throw new Error(`status ${put.status}`);
    console.log(`→ uploaded sample video to MinIO (${(bytes.length / 1024).toFixed(0)} KB, key ${grant.key})`);
    return grant.key;
  } catch (err) {
    console.warn(`  ! video upload failed (${err?.message ?? err}) — continuing without video`);
    return undefined;
  }
}

/** Compact catalog: [sectionTitle, [lesson titles…]] — expanded into API payloads below. */
const COURSES = [
  // ───────── tech ─────────
  {
    title: 'Intro to Web Development in Ethiopia', category: 'tech', pricing_type: 'free',
    description: 'Learn HTML, CSS and JavaScript from scratch with locally relevant projects — build your first website and a portfolio you can share with employers.',
    outline: [
      ['Getting started with the web', ['Welcome & what you will build', 'How the internet actually works', 'Setting up VS Code and your first file']],
      ['HTML & CSS foundations', ['Your first HTML page', 'Styling with CSS', 'Responsive layouts with Flexbox']],
      ['JavaScript essentials', ['Variables, types and loops', 'Making pages interactive with the DOM', 'Project: interactive portfolio page']],
    ],
  },
  {
    title: 'Python for Data Analysis', category: 'tech', pricing_type: 'paid', price_etb: 450,
    description: 'Go from zero to analysing real datasets with pandas and matplotlib. Practical notebooks, Ethiopian open-data examples, and a capstone project.',
    outline: [
      ['Python fundamentals', ['Installing Python and Jupyter', 'Lists, dictionaries and loops', 'Writing reusable functions']],
      ['Working with pandas', ['DataFrames explained', 'Cleaning messy real-world data', 'Grouping and aggregation']],
      ['Visualisation & capstone', ['Charts with matplotlib', 'Case study: Ethiopian coffee export data', 'Capstone: your own analysis']],
    ],
  },
  {
    title: 'Mobile Apps with Flutter', category: 'tech', pricing_type: 'freemium', price_etb: 550,
    description: 'Build beautiful Android apps with one codebase. From Dart basics to publishing on the Play Store — the first section is free to try.',
    outline: [
      ['Flutter setup & Dart basics', ['Installing Flutter the easy way', 'Dart in 40 minutes', 'Widgets: everything is a widget']],
      ['Building real UIs', ['Layouts, rows and columns', 'Navigation between screens', 'State management for beginners']],
      ['Ship it', ['Working with a REST API', 'App icons and splash screens', 'Publishing to the Play Store']],
    ],
  },
  // ───────── business ─────────
  {
    title: 'Starting a Small Business in Addis', category: 'business', pricing_type: 'freemium', price_etb: 300,
    description: 'A practical guide to registering, pricing, and marketing a small business in Ethiopia — the first section is free so you can try before you buy.',
    outline: [
      ['Foundations', ['Finding an idea that fits the market', 'Validating demand before you spend', 'Trade licence and registration walkthrough']],
      ['Money matters', ['Pricing your product in Birr', 'Simple cash-flow tracking', 'Working with Ethiopian banks and microfinance']],
      ['Growth & marketing', ['Your first 100 customers', 'Word of mouth and community marketing', 'When and how to hire help']],
    ],
  },
  {
    title: 'Digital Marketing with Telegram & TikTok', category: 'business', pricing_type: 'paid', price_etb: 350,
    description: 'Grow a brand on the channels Ethiopians actually use. Content planning, short-form video, and measuring what works.',
    outline: [
      ['Strategy first', ['Choosing the right channel for your brand', 'Understanding your Ethiopian audience', 'Setting goals you can measure']],
      ['Telegram playbook', ['Building a channel people join', 'Content calendars that stick', 'Running promotions and polls']],
      ['TikTok & short video', ['Shooting good video on a phone', 'Hooks, trends and sounds', 'Reading analytics and doubling down']],
    ],
  },
  {
    title: 'Bookkeeping & Tax Basics for Ethiopian SMEs', category: 'business', pricing_type: 'free',
    description: 'Keep clean books and stay compliant. Simple double-entry bookkeeping, VAT and TOT explained, and the yearly filing calendar for small businesses.',
    outline: [
      ['Bookkeeping from zero', ['Why clean books save you money', 'The five accounts every business needs', 'Recording daily sales and expenses']],
      ['Tax in Ethiopia', ['VAT vs TOT: which applies to you', 'Payroll and income tax basics', 'The filing calendar and penalties to avoid']],
      ['Tools & habits', ['A simple spreadsheet system', 'Receipts, invoices and records', 'Preparing for an audit calmly']],
    ],
  },
  // ───────── freelancing ─────────
  {
    title: 'Freelancing on Upwork from Ethiopia', category: 'freelancing', pricing_type: 'free',
    description: 'Set up a winning profile, get paid with Chapa/Payoneer, and land your first international client. Real proposal templates included.',
    outline: [
      ['Setting up for success', ['How Upwork really works', 'A profile that gets interviews', 'Portfolio pieces when you have no clients']],
      ['Winning work', ['Reading job posts like a pro', 'Proposal templates that get replies', 'Pricing: hourly vs fixed']],
      ['Getting paid & growing', ['Payoneer and Chapa payout setup', 'Delivering so clients come back', 'Raising your rate with confidence']],
    ],
  },
  {
    title: 'Graphic Design with Free Tools', category: 'freelancing', pricing_type: 'freemium', price_etb: 250,
    description: 'Design logos, flyers and social posts using Canva and GIMP. Build a client-ready portfolio without expensive software.',
    outline: [
      ['Design foundations', ['Seeing like a designer', 'Colour, contrast and hierarchy', 'Typography that communicates']],
      ['Canva in practice', ['Social posts that stop the scroll', 'Flyers and posters for print', 'Brand kits and templates']],
      ['Client-ready work', ['Logo design process end to end', 'Preparing files for clients', 'Building your portfolio page']],
    ],
  },
  {
    title: 'Copywriting that Sells', category: 'freelancing', pricing_type: 'paid', price_etb: 300,
    description: 'Write words that make people act — landing pages, ads and product descriptions for local and international clients, in English and Amharic.',
    outline: [
      ['Persuasion basics', ['Features vs benefits', 'Knowing the reader better than they do', 'The classic formulas: AIDA and PAS']],
      ['Writing the pieces', ['Headlines that earn the click', 'Landing pages step by step', 'Short ads for Telegram and Facebook']],
      ['The freelance side', ['Finding copywriting clients', 'Pricing and packaging your service', 'Building a swipe file']],
    ],
  },
  // ───────── healthcare ─────────
  {
    title: 'First Aid & Home Health Basics', category: 'healthcare', pricing_type: 'free',
    description: 'Essential first-aid, hygiene and home care skills every household should know, taught by an Addis-based nurse.',
    outline: [
      ['Emergency response', ['Assessing a scene safely', 'Bleeding, burns and fractures', 'When and how to get help fast']],
      ['Everyday care', ['Fever and dehydration at home', 'Wound cleaning and dressing', 'A sensible home medicine cabinet']],
      ['Prevention & hygiene', ['Hand hygiene that actually works', 'Safe food and water at home', 'Caring for children and elders']],
    ],
  },
  {
    title: 'Community Health Worker Foundations', category: 'healthcare', pricing_type: 'paid', price_etb: 500,
    description: 'Foundational training for community health work: maternal health, vaccination outreach, and record-keeping.',
    outline: [
      ['The CHW role', ['What community health workers do', 'Ethics and confidentiality', 'Working with the local health post']],
      ['Core services', ['Maternal and newborn checkups', 'Vaccination outreach and cold chain', 'Recognising danger signs early']],
      ['Records & reporting', ['Household registers done right', 'Monthly reporting without stress', 'Using data to plan visits']],
    ],
  },
  {
    title: 'Nutrition for Ethiopian Families', category: 'healthcare', pricing_type: 'freemium', price_etb: 200,
    description: 'Balanced, affordable meals from local ingredients — child nutrition, pregnancy nutrition and meal planning on a budget. First section free.',
    outline: [
      ['Nutrition essentials', ['Macro and micronutrients simply', 'Reading the Ethiopian food landscape', 'Myths and facts about diet']],
      ['Feeding the family', ['First 1000 days: child nutrition', 'Eating well during pregnancy', 'Affordable protein from local foods']],
      ['Planning & practice', ['A week of balanced injera-based meals', 'Shopping smart at the gulit', 'Healthy cooking methods']],
    ],
  },
  // ───────── other ─────────
  {
    title: 'Amharic for Beginners', category: 'other', pricing_type: 'free',
    description: 'Read, write and speak basic Amharic. Master the fidel script, everyday greetings and market conversations with audio practice.',
    outline: [
      ['The fidel script', ['How the fidel system works', 'Reading your first 33 letters', 'Writing practice made fun']],
      ['Everyday conversation', ['Greetings for every time of day', 'Numbers, prices and bargaining', 'Asking for directions']],
      ['Real situations', ['At the café: ordering food', 'Taxi and transport phrases', 'Putting it all together']],
    ],
  },
  {
    title: 'Photography with Your Phone', category: 'other', pricing_type: 'freemium', price_etb: 220,
    description: 'Take professional-looking photos with any smartphone — composition, light, editing with free apps, and selling your photos online.',
    outline: [
      ['Camera craft', ['Knowing your phone camera settings', 'Composition: the rule of thirds and beyond', 'Working with natural light']],
      ['Editing like a pro', ['Free editing apps compared', 'A simple editing workflow', 'Colour and mood']],
      ['Photos that earn', ['Portraits and events', 'Product photos for small businesses', 'Selling stock photos online']],
    ],
  },
  {
    title: 'English for Job Interviews', category: 'other', pricing_type: 'paid', price_etb: 280,
    description: 'Interview confidently in English — answer the classic questions, talk about your experience naturally, and practice with model dialogues.',
    outline: [
      ['Getting ready', ['Researching the company in English', 'Your 60-second self introduction', 'CV vocabulary that stands out']],
      ['The classic questions', ['Strengths and weaknesses honestly', 'Tell me about a challenge you solved', 'Questions YOU should ask']],
      ['Polish & practice', ['Sounding natural: fillers and pace', 'Video interview etiquette', 'Full mock interview walkthrough']],
    ],
  },
];

/** Expand the compact outline into the API's sections payload. */
function buildSections(spec, videoKey) {
  return spec.outline.map(([title, lessonTitles], si) => ({
    title,
    is_free_preview: si === 0,
    lessons: lessonTitles.map((lt, li) => ({
      title: lt,
      duration_seconds: 240 + ((si * 3 + li) % 5) * 90, // 4–10 min, varied
      ...(videoKey ? { video_s3_key: videoKey } : {}),
    })),
  }));
}

async function main() {
  console.log('→ logging in demo accounts (run `pnpm seed` first if this fails)');
  const educator = await login('educator@ethiopialearn.et');
  const qo = await login('qo@ethiopialearn.et');
  const learner = await login('learner@ethiopialearn.et');

  const videoBytes = await loadSampleVideo();
  const videoKey = await uploadVideo(educator, videoBytes);

  // Idempotency: skip courses the educator already has (any status).
  const existing = await call('/courses', { token: educator });
  const existingTitles = new Set(existing.map((c) => c.title));

  const published = [];
  for (const spec of COURSES) {
    if (existingTitles.has(spec.title)) {
      console.log(`→ ${spec.title} … already exists, skipped`);
      continue;
    }
    const body = {
      title: spec.title,
      description: spec.description,
      category: spec.category,
      language: 'en',
      pricing_type: spec.pricing_type,
      ...(spec.price_etb ? { price_etb: spec.price_etb } : {}),
      thumbnail_url: `https://placehold.co/640x360/2563eb/white?text=${encodeURIComponent(spec.title.split(' ').slice(0, 2).join(' '))}`,
      sections: buildSections(spec, videoKey),
    };
    const course = await call('/courses', { method: 'POST', token: educator, body });

    // Verify contents landed (sections are created inline with the course).
    const detail = await call(`/courses/${course.id}`, { token: educator });
    const lessonCount = (detail.sections ?? []).reduce((n, s) => n + (s.lessons?.length ?? 0), 0);
    if (!detail.sections?.length || !lessonCount) {
      console.warn(`  ! "${spec.title}" was created WITHOUT contents (${detail.sections?.length ?? 0} sections) — check the course service`);
    }

    await call(`/courses/${course.id}/submit`, { method: 'POST', token: educator });
    process.stdout.write(`→ ${spec.title} [${spec.category}/${spec.pricing_type}] ${detail.sections.length} sections · ${lessonCount} lessons … submitted`);

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

  console.log(`\n✔ seed complete — ${published.length} new published courses (free/freemium/paid across all 5 categories)`);
  console.log(`  browse:   ${process.env.WEB_URL ?? 'http://localhost:3000'}`);
  console.log('  accounts: educator@ / learner@ / qo@ / admin@ / institution@ ethiopialearn.et  ·  password ' + PASSWORD);
  console.log('  paid courses → test the mock Chapa checkout as the learner');
}

main().catch((err) => {
  console.error('\n✖ seed failed:', err.message);
  process.exit(1);
});
