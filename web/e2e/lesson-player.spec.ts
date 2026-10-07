import { expect, test, type APIRequestContext } from './test';
import { apiGet, authFile } from './support';

// Phase 7b: the lesson player on a phone. Reuses the stored learner login.
test.use({ storageState: authFile('learner'), viewport: { width: 375, height: 800 } });

const START = /^(Start lesson 1|Resume: )/;

async function enrolledCourse(request: APIRequestContext): Promise<{ id: string; firstLessonHasVideo: boolean }> {
  const enrollments = await apiGet<{ course_id: string }[]>(request, '/enrollments', 'learner');
  expect(enrollments.length, 'the seeded learner is enrolled (scripts/demo-seed.mjs)').toBeGreaterThan(0);
  const courses = await Promise.all(
    enrollments.map((e) => apiGet<{ id: string; sections: { lessons: { has_video: boolean }[] }[] }>(request, `/courses/${e.course_id}`)),
  );
  // Prefer a course whose first lesson has a video, so "Start lesson 1" can be checked end to end.
  const playable = courses.find((c) => c.sections[0]?.lessons[0]?.has_video);
  const course = playable ?? courses[0];
  return { id: course.id, firstLessonHasVideo: !!playable };
}

test('the empty player offers Start or Resume, has no video, and the lesson list comes before the assessments', async ({ page, request }) => {
  const { id } = await enrolledCourse(request);
  await page.goto(`/learn/${id}`);
  const start = page.getByRole('button', { name: START });
  await expect(start).toBeVisible();
  await expect(page.locator('video'), 'no dead control bar before a lesson is chosen').toHaveCount(0);

  const list = page.locator('#lesson-sections');
  const assessments = page.locator('#assessments');
  await expect(list).toBeVisible();
  await expect(assessments).toBeAttached();
  const [listBox, assessmentsBox] = [(await list.boundingBox())!, (await assessments.boundingBox())!];
  expect(listBox.y, 'lesson list above the assessments panel').toBeLessThan(assessmentsBox.y);

  // Next stop after the player's own button is the lesson list.
  await start.focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('aside')), 'focus moved into the lesson list').toBe(true);
});

test('Start lesson 1 gives the video a source, and Tab goes from the player controls to the lesson list', async ({ page, request }) => {
  const { id, firstLessonHasVideo } = await enrolledCourse(request);
  test.skip(!firstLessonHasVideo, 'the seed made no sample video (scripts/demo-seed.mjs: video is optional), so there is nothing to play');
  await page.goto(`/learn/${id}`);
  await page.getByRole('button', { name: START }).click();
  const video = page.locator('video');
  await expect(video).toBeVisible();
  // A direct file gets an http(s) src; HLS goes through MediaSource and gets a blob: src.
  await expect.poll(() => video.getAttribute('src')).toMatch(/^(https?:|blob:)/);

  // Previous / Mark complete / Next are the controls after the video; the lesson list follows them.
  // Resuming a finished course opens its last lesson, where Next is disabled and can't take focus.
  await page.getByRole('button', { name: /^(Previous|Mark complete|Next)$/ }).and(page.locator(':enabled')).last().focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('aside')), 'focus moved into the lesson list').toBe(true);
});

test('an unknown or malformed course id says "Course not found"', async ({ page }) => {
  for (const courseId of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
    await page.goto(`/learn/${courseId}`);
    await expect(page.getByRole('heading', { name: 'Course not found' }), courseId).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#main').getByRole('link', { name: 'Browse courses' })).toBeVisible();
  }
});
