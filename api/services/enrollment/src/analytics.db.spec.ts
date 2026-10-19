import { randomUUID } from 'crypto';
import { DataSource, In, Repository } from 'typeorm';
import { buildTypeOrmOptions } from '@ethiopialearn/common';
import { EntitlementStatus, Role } from '@ethiopialearn/contracts';
import { entities, migrations, SCHEMA } from './database';
import { Enrollment, LessonProgress } from './entities';
import { EnrollmentService } from './enrollment.service';

/**
 * Phase 9e oracle: the SQL learner funnels answer the same JSON as the
 * in-memory code they replaced (kept below, in the spec only), over a
 * connection in Addis time, and the progress batch counts live lessons only.
 *
 * Opt-in: runs only when TEST_DATABASE_URL names a scratch database (the CI
 * e2e job creates one). It runs the enrollment migrations there and deletes
 * only the rows it created.
 */
const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;

function oldByMonth(dates: Date[]) {
  const months: Record<string, number> = {};
  const start = new Date();
  start.setUTCDate(1);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - i, 1));
    months[d.toISOString().slice(0, 7)] = 0;
  }
  for (const d of dates) {
    const key = d.toISOString().slice(0, 7);
    if (key in months) months[key] += 1;
  }
  return Object.entries(months).map(([month, count]) => ({ month, count }));
}

/** The pre-9e per-course funnel, for one course with `lessonCount` live lessons. */
async function oldCourseFunnel(enrollments: Repository<Enrollment>, progress: Repository<LessonProgress>, courseId: string, title: string, lessonCount: number) {
  const rows = await enrollments.find({ where: { course_id: courseId } });
  const active = rows.filter((r) => r.entitlement_status === EntitlementStatus.ACTIVE);
  const completed = active.filter((r) => !!r.completed_at);
  const doneRows = active.length
    ? await progress
        .createQueryBuilder('p')
        .select('p.enrollment_id', 'enrollment_id')
        .addSelect('COUNT(*)', 'done')
        .where('p.enrollment_id IN (:...ids)', { ids: active.map((r) => r.id) })
        .groupBy('p.enrollment_id')
        .getRawMany<{ enrollment_id: string; done: string }>()
    : [];
  const doneMap = new Map(doneRows.map((r) => [r.enrollment_id, Number(r.done)]));
  const avgProgress =
    active.length && lessonCount
      ? Math.round(active.reduce((s, r) => s + Math.min(100, ((doneMap.get(r.id) ?? 0) / lessonCount) * 100), 0) / active.length)
      : 0;
  const week = Date.now() - 7 * 86_400_000;
  const month = Date.now() - 30 * 86_400_000;
  return {
    course_id: courseId,
    course_title: title,
    enrolled: active.length,
    refunded: rows.filter((r) => r.entitlement_status === EntitlementStatus.REFUNDED).length,
    completed: completed.length,
    completion_rate: active.length ? Math.round((completed.length / active.length) * 100) : 0,
    avg_progress_percent: avgProgress,
    active_last_7d: active.filter((r) => r.last_activity_at && r.last_activity_at.getTime() > week).length,
    active_last_30d: active.filter((r) => r.last_activity_at && r.last_activity_at.getTime() > month).length,
    never_started: active.filter((r) => !r.last_activity_at && !(doneMap.get(r.id) ?? 0)).length,
    sponsored: active.filter((r) => r.source === 'sponsorship').length,
    enrollments_by_month: oldByMonth(active.map((r) => r.enrolled_at)),
    completions_by_month: oldByMonth(completed.map((r) => r.completed_at!)),
  };
}

async function oldAdmin(enrollments: Repository<Enrollment>) {
  const rows = await enrollments.find();
  const active = rows.filter((r) => r.entitlement_status === EntitlementStatus.ACTIVE);
  const week = Date.now() - 7 * 86_400_000;
  return {
    enrollments_total: rows.length,
    active: active.length,
    completed: active.filter((r) => !!r.completed_at).length,
    refunded: rows.filter((r) => r.entitlement_status === EntitlementStatus.REFUNDED).length,
    sponsored: active.filter((r) => r.source === 'sponsorship').length,
    active_last_7d: active.filter((r) => r.last_activity_at && r.last_activity_at.getTime() > week).length,
    distinct_learners: new Set(active.map((r) => r.learner_id)).size,
    enrollments_by_month: oldByMonth(active.map((r) => r.enrolled_at)),
    completions_by_month: oldByMonth(active.filter((r) => r.completed_at).map((r) => r.completed_at!)),
  };
}

describeWithDb('Enrollment analytics in SQL match the in-memory oracle (TEST_DATABASE_URL)', () => {
  let dataSource: DataSource;
  let enrollments: Repository<Enrollment>;
  let progress: Repository<LessonProgress>;
  let service: EnrollmentService;
  const owner = randomUUID();
  const courses: string[] = [randomUUID(), randomUUID(), randomUUID()];
  /** Live lessons per course; the third course has none. */
  const lessons = new Map(courses.map((c, i) => [c, Array.from({ length: [4, 3, 0][i] }, () => randomUUID())]));
  const created: string[] = [];
  const now = new Date();
  const at = (monthsAgo: number, day = 10) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, day, 12));
  /** 22:30 UTC on the last day of last month: already next month in Addis (UTC+3). */
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 22, 30));
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

  async function enroll(courseId: string, patch: Partial<Enrollment>, done: string[] = []) {
    const row = await enrollments.save(
      enrollments.create({ learner_id: randomUUID(), course_id: courseId, entitlement_status: EntitlementStatus.ACTIVE, source: 'payment', ...patch }),
    );
    created.push(row.id);
    if (patch.enrolled_at) await enrollments.update({ id: row.id }, { enrolled_at: patch.enrolled_at });
    for (const lessonId of done) await progress.save(progress.create({ enrollment_id: row.id, lesson_id: lessonId, completed_at: new Date() }));
    return row;
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      ...buildTypeOrmOptions(SCHEMA, entities, migrations),
      url,
      migrationsRun: false,
      logging: false,
      extra: { options: '-c TimeZone=Africa/Addis_Ababa' },
    });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await dataSource.runMigrations({ transaction: 'each' });
    enrollments = dataSource.getRepository(Enrollment);
    progress = dataSource.getRepository(LessonProgress);
    const internal = {
      get: jest.fn(async (path: string) => {
        if (path.includes('/courses/lesson-ids?ids=')) {
          const ids = decodeURIComponent(path.split('ids=')[1]).split(',');
          return Object.fromEntries(ids.map((id) => [id, lessons.get(id) ?? []]));
        }
        const id = path.split('/').pop()!;
        return { id, title: `Title ${id.slice(0, 4)}`, owner_id: owner, owner_type: 'educator', pricing_type: 'paid', status: 'published' };
      }),
    };
    service = new EnrollmentService(enrollments, progress, {} as never, {} as never, { subscribe: jest.fn() } as never, internal as never, {} as never);

    const [c0, c1, c2] = courses;
    const l0 = lessons.get(c0)!;
    const l1 = lessons.get(c1)!;
    await enroll(c0, { enrolled_at: at(0), last_activity_at: daysAgo(1) }, l0.slice(0, 1));
    await enroll(c0, { enrolled_at: at(3), last_activity_at: daysAgo(10), completed_at: at(1) }, l0);
    await enroll(c0, { enrolled_at: monthEnd, last_activity_at: daysAgo(40), source: 'sponsorship' }, [...l0.slice(0, 3), randomUUID()]);
    await enroll(c0, { enrolled_at: at(5) }); // never started
    await enroll(c0, { enrolled_at: at(14), completed_at: monthEnd }, l0); // enrolled outside the window
    await enroll(c0, { enrolled_at: at(2), entitlement_status: EntitlementStatus.REFUNDED }, l0.slice(0, 2));
    await enroll(c1, { enrolled_at: at(1), last_activity_at: daysAgo(3) }, l1.slice(0, 2));
    await enroll(c1, { enrolled_at: at(6) }, [randomUUID()]); // progress on a removed lesson only
    await enroll(c2, { enrolled_at: at(4), last_activity_at: daysAgo(2) });
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    if (created.length) {
      await progress.delete({ enrollment_id: In(created) });
      await enrollments.delete({ id: In(created) });
    }
    await dataSource.destroy();
  });

  it('analytics: the same JSON per course, from one lesson-ids batch call', async () => {
    const admin = { id: randomUUID(), role: Role.PLATFORM_ADMIN, email: 'a@e.et' } as never;
    const actual = await service.analytics(admin, courses);
    const expected = [];
    for (const c of courses) expected.push(await oldCourseFunnel(enrollments, progress, c, `Title ${c.slice(0, 4)}`, lessons.get(c)!.length));
    expect(actual).toEqual(expected);
    expect(expected[0].enrollments_by_month.find((m) => m.month === monthEnd.toISOString().slice(0, 7))!.count).toBeGreaterThan(0);
  });

  it('adminAnalytics: the same JSON as the in-memory funnel over every row', async () => {
    expect(await service.adminAnalytics()).toEqual(await oldAdmin(enrollments));
  });

  it('progressForPairs counts live lessons only, on Postgres', async () => {
    const rows = await enrollments.find({ where: { id: In(created) }, order: { enrolled_at: 'ASC' } });
    const out = await service.progressForPairs(rows.map((r) => `${r.learner_id}:${r.course_id}`));
    const byLearner = new Map(out.map((p) => [p.learner_id, p]));
    const sponsored = rows.find((r) => r.source === 'sponsorship')!;
    expect(byLearner.get(sponsored.learner_id)?.progress_percent).toBe(75); // 3 of 4 live; the removed lesson doesn't count
    expect(out).toHaveLength(rows.length);
  });
});
