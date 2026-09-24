import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntitlementStatus, Role } from '@ethiopialearn/contracts';
import { EnrollmentService } from './enrollment.service';

const ctx = { id: 'u1', role: Role.LEARNER, email: 'l@e.et' } as never;

interface Options {
  entitlement?: EntitlementStatus | null; // null = no enrollment row
  existingVideoRow?: Record<string, unknown> | null;
  lessonIds?: string[];
  completedCount?: number;
  courseStatus?: string;
  pricingType?: string;
  /** `live` flag of the internal lesson; undefined = a course service that predates staged revisions. */
  lessonLive?: boolean;
}

function setup(opts: Options = {}) {
  const enrollmentRow =
    opts.entitlement === null
      ? null
      : {
          id: 'e1',
          learner_id: 'u1',
          course_id: 'c1',
          entitlement_status: opts.entitlement ?? EntitlementStatus.ACTIVE,
          completed_at: null,
        };
  const enrollments = {
    findOne: jest.fn().mockResolvedValue(enrollmentRow),
    save: jest.fn(async (e: unknown) => e),
    create: jest.fn((e: object) => e),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const progress = {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(async (p: unknown) => p),
    create: jest.fn((p: object) => p),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(opts.completedCount ?? 0),
  };
  const videoRows: Record<string, unknown>[] = [];
  const videoProgress = {
    findOne: jest.fn().mockResolvedValue(opts.existingVideoRow ?? null),
    save: jest.fn(async (r: Record<string, unknown>) => {
      videoRows.push(r);
      return r;
    }),
    create: jest.fn((r: object) => ({ percent_watched: 0, duration_seconds: 0, ...r })),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
  };
  const courseCache = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn(), create: jest.fn() };
  const bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.includes('/lesson-ids')) return { lesson_ids: opts.lessonIds ?? ['l1', 'l2'] };
      if (path.startsWith('/api/v1/internal/lessons/')) return { course_id: 'c1', live: opts.lessonLive };
      if (path.startsWith('/api/v1/internal/courses/')) {
        return {
          id: 'c1',
          title: 'Course',
          owner_id: 'edu1',
          owner_type: 'educator',
          pricing_type: opts.pricingType ?? 'free',
          status: opts.courseStatus ?? 'published',
        };
      }
      return { name: 'Someone', email: 'x@e.et' };
    }),
  };
  const service = new EnrollmentService(
    enrollments as never,
    progress as never,
    courseCache as never,
    videoProgress as never,
    bus as never,
    internal as never,
  );
  return { service, enrollments, progress, videoProgress, videoRows, bus, internal };
}

describe('EnrollmentService.saveVideoProgress', () => {
  it('stores the position and percent for a first heartbeat', async () => {
    const { service } = setup();
    const result = await service.saveVideoProgress(ctx, 'l1', 42, 120);
    expect(result).toEqual({ lesson_id: 'l1', position_seconds: 42, duration_seconds: 120, percent_watched: 35 });
  });

  it('keeps percent_watched as a high-water mark while the resume point follows rewinds', async () => {
    const { service } = setup({
      existingVideoRow: { enrollment_id: 'e1', lesson_id: 'l1', position_seconds: 100, duration_seconds: 120, percent_watched: 83 },
    });
    // Learner rewinds to 30s: resume point moves back, high-water mark stays.
    const result = await service.saveVideoProgress(ctx, 'l1', 30, 120);
    expect(result.position_seconds).toBe(30);
    expect(result.percent_watched).toBe(83);
  });

  it('auto-completes the lesson at ≥90% watched', async () => {
    const { service, progress } = setup();
    await service.saveVideoProgress(ctx, 'l1', 110, 120); // 92%
    expect(progress.save).toHaveBeenCalledWith(expect.objectContaining({ lesson_id: 'l1', enrollment_id: 'e1' }));
  });

  it('does not complete the lesson below 90%', async () => {
    const { service, progress } = setup();
    await service.saveVideoProgress(ctx, 'l1', 60, 120); // 50%
    expect(progress.save).not.toHaveBeenCalled();
  });

  it('publishes CourseCompleted when the auto-completed lesson was the last one', async () => {
    const { service, bus } = setup({ lessonIds: ['l1'], completedCount: 1 });
    await service.saveVideoProgress(ctx, 'l1', 119, 120);
    expect(bus.publish).toHaveBeenCalledWith('CourseCompleted', expect.objectContaining({ enrollment_id: 'e1' }));
  });

  it('rejects heartbeats without an active entitlement', async () => {
    const noEnrollment = setup({ entitlement: null });
    await expect(noEnrollment.service.saveVideoProgress(ctx, 'l1', 10, 120)).rejects.toThrow(ForbiddenException);

    const refunded = setup({ entitlement: EntitlementStatus.REFUNDED });
    await expect(refunded.service.saveVideoProgress(ctx, 'l1', 10, 120)).rejects.toThrow(ForbiddenException);
  });

  it('clamps a zero duration instead of dividing by it', async () => {
    const { service } = setup();
    const result = await service.saveVideoProgress(ctx, 'l1', 10, 0);
    expect(result.percent_watched).toBe(0);
  });
});

describe('EnrollmentService.videoProgressDetail', () => {
  it('returns per-lesson state with the most recently watched lesson first', async () => {
    const { service, videoProgress } = setup();
    videoProgress.find.mockResolvedValue([
      { lesson_id: 'l2', position_seconds: 12, duration_seconds: 100, percent_watched: 12, updated_at: new Date() },
      { lesson_id: 'l1', position_seconds: 90, duration_seconds: 100, percent_watched: 90, updated_at: new Date(0) },
    ]);
    const result = await service.videoProgressDetail(ctx, 'e1');
    expect(result.last_lesson_id).toBe('l2');
    expect(result.lessons).toHaveLength(2);
  });

  it("refuses another learner's enrollment", async () => {
    const { service, enrollments } = setup();
    enrollments.findOne.mockResolvedValue({ id: 'e1', learner_id: 'other', course_id: 'c1' });
    await expect(service.videoProgressDetail(ctx, 'e1')).rejects.toThrow(ForbiddenException);
  });
});

describe('EnrollmentService.enrollFree', () => {
  it('rejects paid courses — those must go through the payment flow', async () => {
    const { service } = setup({ entitlement: null, pricingType: 'paid' });
    await expect(service.enrollFree(ctx, 'c1')).rejects.toThrow(BadRequestException);
  });

  it('rejects unpublished courses', async () => {
    const { service } = setup({ entitlement: null, courseStatus: 'draft' });
    await expect(service.enrollFree(ctx, 'c1')).rejects.toThrow();
  });

  it('enrolls a learner on a free published course and publishes EnrollmentCreated', async () => {
    const { service, bus } = setup({ entitlement: null });
    const result = (await service.enrollFree(ctx, 'c1')) as { entitlement_status: EntitlementStatus };
    expect(result.entitlement_status).toBe(EntitlementStatus.ACTIVE);
    expect(bus.publish).toHaveBeenCalledWith('EnrollmentCreated', expect.objectContaining({ course_id: 'c1' }));
  });
});

describe('EnrollmentService: lessons staged in an unapproved revision', () => {
  it('refuses to complete a lesson that is not live yet', async () => {
    const { service, progress } = setup({ lessonLive: false });
    await expect(service.completeLesson(ctx, 'l9')).rejects.toThrow(NotFoundException);
    await expect(service.completeLesson(ctx, 'l9')).rejects.toThrow('Lesson not available yet');
    expect(progress.save).not.toHaveBeenCalled();
  });

  it('refuses video heartbeats on a lesson that is not live yet', async () => {
    const { service, videoProgress } = setup({ lessonLive: false });
    await expect(service.saveVideoProgress(ctx, 'l9', 10, 120)).rejects.toThrow(NotFoundException);
    expect(videoProgress.save).not.toHaveBeenCalled();
  });

  it('accepts progress on live lessons', async () => {
    const { service, progress } = setup({ lessonLive: true });
    await service.completeLesson(ctx, 'l1');
    expect(progress.save).toHaveBeenCalledWith(expect.objectContaining({ lesson_id: 'l1' }));
  });
});

describe('EnrollmentService: completion is published once', () => {
  it('does not publish CourseCompleted when another path completed the enrollment first', async () => {
    const { service, enrollments, bus } = setup({ lessonIds: ['l1'], completedCount: 1 });
    enrollments.update.mockResolvedValue({ affected: 0 });
    await service.completeLesson(ctx, 'l1');
    expect(enrollments.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1', completed_at: expect.anything() }),
      { completed_at: expect.any(Date) },
    );
    expect(bus.publish).not.toHaveBeenCalledWith('CourseCompleted', expect.anything());
  });
});

type Row = { id: string; learner_id: string; course_id: string; entitlement_status: EntitlementStatus; completed_at: Date | null };

/**
 * In-memory enrollment + progress store for the CourseRevisionClosed reaction.
 * `done` maps enrollment id → completed LIVE lessons.
 */
function revisionSetup(rows: Row[], done: Record<string, number>, liveLessonIds = ['l1', 'l2']) {
  const findCalls: Array<{ after: string | undefined; take: number }> = [];
  const enrollments = {
    find: jest.fn(async (opts: { where: Record<string, any>; take: number }) => {
      const { where } = opts;
      const after: string | undefined = where.id?.value;
      findCalls.push({ after, take: opts.take });
      return rows
        .filter((r) => r.course_id === where.course_id && r.entitlement_status === where.entitlement_status && r.completed_at === null)
        .filter((r) => after === undefined || r.id > after)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, opts.take)
        .map((r) => ({ ...r }));
    }),
    update: jest.fn(async (criteria: { id: string }, patch: { completed_at: Date }) => {
      const row = rows.find((r) => r.id === criteria.id && r.completed_at === null);
      if (!row) return { affected: 0 };
      row.completed_at = patch.completed_at;
      return { affected: 1 };
    }),
    save: jest.fn(async (e: unknown) => e),
  };
  let groupedIds: string[] = [];
  const qb: Record<string, jest.Mock> = {
    select: jest.fn(() => qb),
    addSelect: jest.fn(() => qb),
    where: jest.fn((_sql: string, params: { enrollmentIds: string[] }) => {
      groupedIds = params.enrollmentIds;
      return qb;
    }),
    andWhere: jest.fn(() => qb),
    groupBy: jest.fn(() => qb),
    getRawMany: jest.fn(async () => groupedIds.filter((id) => done[id]).map((id) => ({ enrollment_id: id, done: String(done[id]) }))),
  };
  const progress = {
    createQueryBuilder: jest.fn(() => qb),
    count: jest.fn(async ({ where }: { where: { enrollment_id: string } }) => done[where.enrollment_id] ?? 0),
    save: jest.fn(),
    delete: jest.fn(),
  };
  const videoProgress = { update: jest.fn().mockResolvedValue({ affected: 3 }) };
  const courseCache = { findOne: jest.fn(), update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.endsWith('/lesson-ids')) return { lesson_ids: liveLessonIds };
      if (path.startsWith('/api/v1/internal/users/')) return { name: 'Learner', email: `${path.split('/').pop()}@e.et` };
      if (path.startsWith('/api/v1/internal/courses/')) return { title: 'Course', owner_id: 'edu1', owner_type: 'educator' };
      return { name: 'Educator' };
    }),
  };
  const service = new EnrollmentService(
    enrollments as never,
    progress as never,
    courseCache as never,
    videoProgress as never,
    bus as never,
    internal as never,
  );
  service.onModuleInit();
  const handler = bus.subscribe.mock.calls.find(([type]) => type === 'CourseRevisionClosed')![1] as (p: unknown) => Promise<void>;
  const closed = (patch: Record<string, unknown>) =>
    handler({
      course_id: 'c1',
      revision_id: 'r1',
      outcome: 'applied',
      submitted_at: '2026-09-01T00:00:00.000Z',
      added_lesson_ids: [],
      removed_lesson_ids: [],
      replaced_video_lesson_ids: [],
      changelog_summary: null,
      major: false,
      owner_user_id: 'edu-user',
      owner_email: 'edu@e.et',
      course_title: 'Course',
      notes: null,
      ...patch,
    });
  return { closed, enrollments, progress, videoProgress, courseCache, bus, internal, findCalls, rows };
}

const row = (id: string, completed_at: Date | null = null, status = EntitlementStatus.ACTIVE): Row => ({
  id,
  learner_id: `learner-${id}`,
  course_id: 'c1',
  entitlement_status: status,
  completed_at,
});

describe('EnrollmentService: CourseRevisionClosed', () => {
  it('completes learners who now have every live lesson done after lessons were removed', async () => {
    // e1 did both remaining lessons (the removed one was the only gap); e2 did one.
    const t = revisionSetup([row('e1'), row('e2')], { e1: 2, e2: 1 });
    await t.closed({ removed_lesson_ids: ['l3'] });

    const completions = t.bus.publish.mock.calls.filter(([type]) => type === 'CourseCompleted');
    expect(completions).toHaveLength(1);
    expect(completions[0][1]).toEqual(
      expect.objectContaining({ enrollment_id: 'e1', learner_id: 'learner-e1', learner_email: 'learner-e1@e.et', course_id: 'c1' }),
    );
    expect(t.rows.find((r) => r.id === 'e1')!.completed_at).toBeInstanceOf(Date);
    expect(t.rows.find((r) => r.id === 'e2')!.completed_at).toBeNull();
    // The live lesson list is fetched once for the whole course, not per enrollment.
    expect(t.internal.get.mock.calls.filter(([path]) => String(path).endsWith('/lesson-ids'))).toHaveLength(1);
  });

  it('pages through enrollments 200 at a time without skipping the ones it completes', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `e${String(i).padStart(3, '0')}`);
    const t = revisionSetup(ids.map((id) => row(id)), Object.fromEntries(ids.map((id) => [id, 2])));
    await t.closed({ removed_lesson_ids: ['l3'] });

    expect(t.findCalls.map((c) => c.take)).toEqual([200, 200, 200]);
    expect(t.findCalls.map((c) => c.after)).toEqual([undefined, 'e199', 'e399']);
    expect(t.bus.publish.mock.calls.filter(([type]) => type === 'CourseCompleted')).toHaveLength(450);
  });

  it('skips enrollments that are already complete or not active', async () => {
    const t = revisionSetup([row('e1', new Date('2026-01-01')), row('e2', null, EntitlementStatus.REFUNDED)], { e1: 2, e2: 2 });
    await t.closed({ removed_lesson_ids: ['l3'] });
    expect(t.bus.publish).not.toHaveBeenCalled();
    expect(t.enrollments.update).not.toHaveBeenCalled();
  });

  it('does not re-check completion when no lesson was removed', async () => {
    const t = revisionSetup([row('e1')], { e1: 2 });
    await t.closed({ added_lesson_ids: ['l9'] });
    expect(t.enrollments.find).not.toHaveBeenCalled();
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('resets watch state for replaced videos but keeps lesson completions', async () => {
    const t = revisionSetup([row('e1')], { e1: 1 });
    await t.closed({ replaced_video_lesson_ids: ['l1', 'l2'] });

    expect(t.videoProgress.update).toHaveBeenCalledTimes(1);
    const [criteria, patch] = t.videoProgress.update.mock.calls[0];
    expect(criteria.lesson_id.value).toEqual(['l1', 'l2']);
    expect(patch).toEqual(expect.objectContaining({ position_seconds: 0, duration_seconds: 0, percent_watched: 0 }));
    expect(t.progress.delete).not.toHaveBeenCalled();
    expect(t.progress.save).not.toHaveBeenCalled();
  });

  it('refreshes the cached course title so My Learning and learner messages show an approved rename', async () => {
    const t = revisionSetup([row('e1')], { e1: 1 });
    await t.closed({ course_title: 'Go for Backend Developers' });
    expect(t.courseCache.update).toHaveBeenCalledWith({ course_id: 'c1' }, { title: 'Go for Backend Developers' });
  });

  it('still resets replaced videos when the title cache write fails', async () => {
    const t = revisionSetup([row('e1')], { e1: 1 });
    t.courseCache.update.mockRejectedValueOnce(new Error('connection reset'));
    await t.closed({ course_title: 'Renamed', replaced_video_lesson_ids: ['l1'] });
    expect(t.videoProgress.update).toHaveBeenCalledTimes(1);
  });

  it('leaves the cached title alone when the event carries none', async () => {
    const t = revisionSetup([row('e1')], { e1: 1 });
    await t.closed({ course_title: '' });
    expect(t.courseCache.update).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'discarded'])('ignores a %s revision (nothing changed for learners)', async (outcome) => {
    const t = revisionSetup([row('e1')], { e1: 2 });
    await t.closed({ outcome, removed_lesson_ids: ['l3'], replaced_video_lesson_ids: ['l1'] });
    expect(t.courseCache.update).not.toHaveBeenCalled();
    expect(t.videoProgress.update).not.toHaveBeenCalled();
    expect(t.enrollments.find).not.toHaveBeenCalled();
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('keeps going when one enrollment fails', async () => {
    const t = revisionSetup([row('e1'), row('e2')], { e1: 2, e2: 2 });
    t.enrollments.update.mockRejectedValueOnce(new Error('deadlock'));
    await t.closed({ removed_lesson_ids: ['l3'] });
    const completed = t.bus.publish.mock.calls.filter(([type]) => type === 'CourseCompleted').map(([, p]) => p.enrollment_id);
    expect(completed).toEqual(['e2']);
  });
});
