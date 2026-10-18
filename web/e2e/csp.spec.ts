import { expect, test } from './test';
import { apiGet, authFile, COLD_URL, firstCourseId, ownCourseId } from './support';

// Phase 10: the flows whose sources the Content Security Policy must allow.
// The fixture in ./test fails each of these on any violation; the assertions
// here make sure the flow really ran (a blocked load can also fail silently).

test('the web app sends the enforced policy, not Report-Only', async ({ page }) => {
  const res = await page.goto('/');
  const headers = res!.headers();
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['content-security-policy']).not.toContain("'unsafe-eval'");
  expect(headers['content-security-policy-report-only']).toBeUndefined();
  expect(headers['x-frame-options']).toBe('DENY');
});

test('fonts are self-hosted: no request goes to Google Fonts', async ({ page }) => {
  const google: string[] = [];
  page.on('request', (r) => {
    if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) google.push(r.url());
  });
  await page.goto('/');
  await page.goto('/courses');
  await page.waitForLoadState('networkidle');
  expect(google).toEqual([]);
});

test('the Google sign-in button renders', async ({ page }) => {
  test.skip(!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID, 'built without NEXT_PUBLIC_GOOGLE_CLIENT_ID (CI): the button is not rendered');
  await page.goto('/login');
  await expect(page.locator('iframe[src^="https://accounts.google.com/gsi/"]').first()).toBeVisible({ timeout: 15_000 });
});

test.describe('as the educator', () => {
  test.use({ storageState: authFile('educator') });

  test('a thumbnail uploads straight to storage and shows', async ({ page, request }) => {
    await page.goto(`/teach/courses/${await ownCourseId(request)}`);
    const put = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().startsWith('http://localhost:9000/'));
    await page
      .locator('label', { hasText: /Upload image|Replace image/ })
      .locator('input[type="file"]')
      .setInputFiles({ name: 'thumb.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1PX, 'base64') });
    expect((await put).status()).toBeLessThan(300);
    const img = page.getByRole('img', { name: 'Course thumbnail' });
    await expect(img).toHaveAttribute('src', /^http:\/\/localhost:9000\//);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  });

  test('a PDF is read in the browser for the outline (pdf.js worker)', async ({ page, request }) => {
    await page.goto(`/teach/courses/${await ownCourseId(request)}`);
    await page.getByRole('heading', { name: /Generate an outline with AI/ }).locator('..').getByRole('button', { name: 'Open' }).click();
    await page
      .locator('label', { hasText: 'Upload PDF / Word / notes' })
      .locator('input[type="file"]')
      .setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: tinyPdf(PDF_LINES) });
    await expect(page.getByPlaceholder(/paste your document/)).toHaveValue(/budget for a small shop/, { timeout: 20_000 });
  });
});

test.describe('as the learner', () => {
  test.use({ storageState: authFile('learner') });

  test('a free preview video loads from storage', async ({ page, request }) => {
    const id = await firstCourseId(request);
    const course = await apiGet<{ sections: { is_free_preview: boolean; lessons: { title: string; has_video: boolean }[] }[] }>(request, `/courses/${id}`);
    const lesson = course.sections.filter((s) => s.is_free_preview).flatMap((s) => s.lessons).find((l) => l.has_video);
    test.skip(!lesson, 'the seed made no sample video (scripts/demo-seed.mjs: video is optional)');
    await page.goto(`/courses/${id}`);
    const media = page.waitForResponse((r) => r.request().resourceType() === 'media');
    await page.getByRole('button', { name: lesson!.title }).first().click();
    await expect.poll(() => page.locator('video').getAttribute('src')).toMatch(/^(https?:|blob:)/);
    expect((await media).status()).toBeLessThan(400);
  });

  test('a proctored exam loads its face detector (wasm)', async ({ page, request }) => {
    // The seed has no proctored exam the learner can open. The preflight screen only reads the
    // course's assessment list, so the page is served one and runs the real detector, which
    // loads with or without a camera.
    const [{ course_id }] = await apiGet<{ course_id: string }[]>(request, '/enrollments', 'learner');
    const id = '00000000-0000-4000-8000-0000000000c5';
    await page.route(
      (url) => url.pathname === '/api/v1/assessments' && url.searchParams.get('course_id') === course_id,
      (route) => route.fulfill({ json: [{ id, type: 'quiz', proctored: true, question_count: 3, pass_score: 60, time_limit_minutes: null }] }),
    );
    await page.goto(`/learn/${course_id}/exam/${id}`);
    await expect(page.getByText(/^(Face detection ready|One face detected|Position your face in view|Multiple faces in view)$/)).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('with the API asleep', () => {
  test.use({ baseURL: COLD_URL });

  test('the waking-up page pings every wake URL', async ({ page, request }) => {
    const urls = (process.env.NEXT_PUBLIC_WAKE_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
    test.skip(urls.length === 0, 'built without NEXT_PUBLIC_WAKE_URLS: there is nothing to ping');
    const pings = urls.map((u) => page.waitForRequest(u));
    await page.goto(`/courses/${await firstCourseId(request)}`);
    await expect(page.getByRole('status')).toContainText("We're waking up the server");
    await Promise.all(pings);
  });
});

/** A 1×1 PNG. */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const PDF_LINES = [
  'Keeping the books for a small business.',
  'This lesson shows how to plan a monthly budget for a small shop.',
  'Write down what you sell each day, and what you spend.',
];

/** A one-page PDF with a real text layer, built by hand so the suite needs no fixture files. */
function tinyPdf(lines: string[]): Buffer {
  const text = lines.map((line, i) => `BT /F1 12 Tf 40 ${200 - i * 20} Td (${line}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 260] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
