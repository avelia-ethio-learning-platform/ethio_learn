import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { EntitlementStatus, PricingType, Role } from '@ethiopialearn/contracts';
import { EnrollmentService } from './enrollment.service';
import { Enrollment } from './entities';

type Emitted = { type: string; payload: any };

/**
 * outbox.transaction with the spec's fake manager: emitted events "commit" only
 * when fn resolves. `inTransaction()` says whether a call runs inside one, and
 * `failNextCommit` makes the next transaction throw after fn, as a failed outbox
 * insert or commit would. The repository mocks can't roll back, so a rollback
 * spec checks that the write ran inside the transaction that failed.
 */
function fakeOutbox(manager: unknown) {
  const committed: Emitted[] = [];
  let inside = false;
  let failure: Error | null = null;
  const outbox = {
    transaction: jest.fn(async (fn: (m: unknown, emit: (type: string, payload: unknown) => void) => Promise<unknown>) => {
      const queued: Emitted[] = [];
      inside = true;
      try {
        const result = await fn(manager, (type, payload) => queued.push({ type, payload }));
        if (failure) throw failure;
        committed.push(...queued);
        return result;
      } finally {
        inside = false;
        failure = null;
      }
    }),
  };
  const failNextCommit = (err: Error) => {
    failure = err;
  };
  return { outbox, committed, inTransaction: () => inside, failNextCommit };
}

/** Records, per call of `mock`, whether it ran inside the outbox transaction, keeping its behaviour. */
function trackTx(mock: jest.Mock, inTransaction: () => boolean): boolean[] {
  const seen: boolean[] = [];
  const impl = mock.getMockImplementation();
  mock.mockImplementation((...args: unknown[]) => {
    seen.push(inTransaction());
    return impl?.(...args);
  });
  return seen;
}

/** The transaction's manager hands out the same enrollment repository mock the service holds. */
const managerFor = (enrollments: unknown) => ({ getRepository: (entity: unknown) => (entity === Enrollment ? enrollments : null) });

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
  /** `has_video` of the internal lesson; undefined = the field is absent (a course service that predates it). */
  hasVideo?: boolean;
  /** Measured `video_duration_seconds` of the internal lesson (null = not measured). */
  videoDuration?: number | null;
  /** The editor's "minutes" estimate on the lesson; never a completion requirement. */
  lessonDuration?: number;
}

/** A start time `seconds` ago. */
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);

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
      if (path.startsWith('/api/v1/internal/lessons/')) {
        return {
          course_id: 'c1',
          live: opts.lessonLive,
          ...(opts.hasVideo === undefined ? {} : { has_video: opts.hasVideo, video_duration_seconds: opts.videoDuration ?? null }),
          ...(opts.lessonDuration === undefined ? {} : { duration_seconds: opts.lessonDuration }),
        };
      }
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
  const tx = fakeOutbox(managerFor(enrollments));
  const service = new EnrollmentService(
    enrollments as never,
    progress as never,
    courseCache as never,
    videoProgress as never,
    bus as never,
    internal as never,
    tx.outbox as never,
  );
  return { service, enrollments, progress, videoProgress, videoRows, bus, internal, ...tx };
}

describe('EnrollmentService.saveVideoProgress', () => {
  it('stores the position and percent for a first heartbeat', async () => {
    const { service } = setup();
    const result = await service.saveVideoProgress(ctx, 'l1', 42, 120);
    expect(result).toEqual({ lesson_id: 'l1', position_seconds: 42, duration_seconds: 120, percent_watched: 35, completed: false });
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

  it('auto-completes the lesson at ≥90% watched once enough time has passed', async () => {
    const { service, progress } = setup({
      existingVideoRow: { enrollment_id: 'e1', lesson_id: 'l1', position_seconds: 100, duration_seconds: 120, percent_watched: 83, started_at: ago(110) },
    });
    const result = await service.saveVideoProgress(ctx, 'l1', 110, 120); // 92%
    expect(progress.save).toHaveBeenCalledWith(expect.objectContaining({ lesson_id: 'l1', enrollment_id: 'e1' }));
    expect(result.completed).toBe(true);
  });

  it('does not complete the lesson below 90%', async () => {
    const { service, progress } = setup({
      existingVideoRow: { enrollment_id: 'e1', lesson_id: 'l1', position_seconds: 0, duration_seconds: 120, percent_watched: 0, started_at: ago(3600) },
    });
    const result = await service.saveVideoProgress(ctx, 'l1', 60, 120); // 50%
    expect(progress.save).not.toHaveBeenCalled();
    expect(result.completed).toBe(false);
  });

  it('emits CourseCompleted when the auto-completed lesson was the last one', async () => {
    const { service, committed } = setup({
      lessonIds: ['l1'],
      completedCount: 1,
      existingVideoRow: { enrollment_id: 'e1', lesson_id: 'l1', position_seconds: 100, duration_seconds: 120, percent_watched: 83, started_at: ago(110) },
    });
    await service.saveVideoProgress(ctx, 'l1', 119, 120);
    expect(committed).toEqual([{ type: 'CourseCompleted', payload: expect.objectContaining({ enrollment_id: 'e1' }) }]);
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

describe('EnrollmentService: the video completion rule', () => {
  const NOW = new Date('2026-10-03T12:00:00.000Z').getTime();
  const FINISH = 'Finish watching this lesson to complete it.';
  /** An in-progress row on a 120 s video. */
  const watching = (patch: Record<string, unknown> = {}) => ({
    enrollment_id: 'e1',
    lesson_id: 'l1',
    position_seconds: 0,
    duration_seconds: 120,
    percent_watched: 0,
    ...patch,
  });
  /** The error a call rejects with; fails the test if it resolves. */
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected a 409');
      },
      (e: unknown) => e,
    );

  afterEach(() => jest.useRealTimers());

  describe('heartbeats', () => {
    it('records an early 100% claim right after the first heartbeat without completing the lesson', async () => {
      const { service, progress, videoRows } = setup({ hasVideo: true });
      const result = await service.saveVideoProgress(ctx, 'l1', 120, 120);
      expect(result).toEqual(expect.objectContaining({ position_seconds: 120, percent_watched: 100, completed: false }));
      expect(progress.save).not.toHaveBeenCalled();
      // The first heartbeat starts the clock.
      expect(videoRows[0].started_at).toBeInstanceOf(Date);
      expect(Date.now() - (videoRows[0].started_at as Date).getTime()).toBeLessThan(1000);
    });

    it('completes at 90% once 45% of the required length has passed since the start', async () => {
      // 120 s required: 54 s must have passed.
      const { service, progress } = setup({ hasVideo: true, existingVideoRow: watching({ started_at: ago(54) }) });
      const result = await service.saveVideoProgress(ctx, 'l1', 108, 120); // 90%
      expect(result.completed).toBe(true);
      expect(progress.save).toHaveBeenCalledWith(expect.objectContaining({ lesson_id: 'l1', enrollment_id: 'e1' }));
    });

    it('does not complete at 90% just before 45% of the length has passed', async () => {
      const { service, progress } = setup({ hasVideo: true, existingVideoRow: watching({ started_at: ago(53) }) });
      const result = await service.saveVideoProgress(ctx, 'l1', 108, 120);
      expect(result.completed).toBe(false);
      expect(progress.save).not.toHaveBeenCalled();
    });

    it('never moves started_at forward once it is set', async () => {
      const started = ago(30);
      const { service, videoRows } = setup({ hasVideo: true, existingVideoRow: watching({ started_at: started }) });
      await service.saveVideoProgress(ctx, 'l1', 40, 120);
      expect(videoRows[0].started_at).toBe(started);
    });

    it('measures percent against the measured duration, not a smaller client duration', async () => {
      // The client reports a 100 s video; the measured length is 300 s.
      const { service, progress } = setup({
        hasVideo: true,
        videoDuration: 300,
        existingVideoRow: watching({ duration_seconds: 0, started_at: ago(3600) }),
      });
      const result = await service.saveVideoProgress(ctx, 'l1', 100, 100);
      expect(result.percent_watched).toBe(33);
      expect(result.completed).toBe(false);
      expect(progress.save).not.toHaveBeenCalled();
    });

    it("never uses the editor's minutes estimate as the requirement", async () => {
      // The editor typed 5 minutes; the measured video is 250 s, so its end is 100%.
      const { service, progress } = setup({
        hasVideo: true,
        lessonDuration: 300,
        videoDuration: 250,
        existingVideoRow: watching({ duration_seconds: 250, started_at: ago(113) }),
      });
      const result = await service.saveVideoProgress(ctx, 'l1', 250, 250);
      expect(result.percent_watched).toBe(100);
      expect(result.completed).toBe(true);
      expect(progress.save).toHaveBeenCalledWith(expect.objectContaining({ lesson_id: 'l1' }));
    });

    it('clamps the position to the required length plus 5 s', async () => {
      const { service, videoRows } = setup({ hasVideo: true, existingVideoRow: watching({ started_at: ago(10) }) });
      const result = await service.saveVideoProgress(ctx, 'l1', 100_000, 120);
      expect(result.position_seconds).toBe(125);
      expect(result.percent_watched).toBe(100);
      expect(videoRows[0].position_seconds).toBe(125);
    });

    it('lets an in-progress row with a backfilled started_at complete on its next 90% heartbeat', async () => {
      // The migration backfills started_at to one lesson length before the last heartbeat.
      const lastHeartbeat = ago(20);
      const backfilled = new Date(lastHeartbeat.getTime() - 120 * 1000);
      const { service, progress } = setup({
        hasVideo: true,
        existingVideoRow: watching({ position_seconds: 96, percent_watched: 80, started_at: backfilled, updated_at: lastHeartbeat }),
      });
      const result = await service.saveVideoProgress(ctx, 'l1', 110, 120);
      expect(result.completed).toBe(true);
      expect(progress.save).toHaveBeenCalledWith(expect.objectContaining({ lesson_id: 'l1' }));
    });

    it('restarts the clock after a replaced video reset started_at, so an early 90% claim does not complete', async () => {
      // The row as onRevisionApplied leaves it.
      const { service, progress, videoRows } = setup({
        hasVideo: true,
        existingVideoRow: watching({ duration_seconds: 0, started_at: null }),
      });
      const result = await service.saveVideoProgress(ctx, 'l1', 110, 120);
      expect(result.completed).toBe(false);
      expect(progress.save).not.toHaveBeenCalled();
      expect(Date.now() - (videoRows[0].started_at as Date).getTime()).toBeLessThan(1000);
    });

    it('applies a first heartbeat that lost the insert race to the row the winner created', async () => {
      // pause, ended and /complete can all find no row and insert at once; the unique constraint keeps one.
      const winner = watching({ id: 'vp1', position_seconds: 60, percent_watched: 50, started_at: ago(70) });
      const { service, videoProgress, videoRows, progress } = setup({ hasVideo: true });
      videoProgress.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      videoProgress.save.mockRejectedValueOnce(
        new QueryFailedError('INSERT INTO video_progress', [], Object.assign(new Error('duplicate key'), { code: '23505' })),
      );
      const result = await service.saveVideoProgress(ctx, 'l1', 110, 120); // 92%, 70 s after the winner's start
      expect(videoProgress.findOne).toHaveBeenCalledTimes(2);
      expect(videoProgress.save).toHaveBeenCalledTimes(2);
      expect(videoRows).toEqual([winner]);
      expect(winner).toEqual(expect.objectContaining({ position_seconds: 110, percent_watched: 92 }));
      expect(result).toEqual(expect.objectContaining({ position_seconds: 110, percent_watched: 92, completed: true }));
      expect(progress.save).toHaveBeenCalledWith(expect.objectContaining({ lesson_id: 'l1', enrollment_id: 'e1' }));
    });

    it('reports completed for a lesson completed earlier, even below 90%', async () => {
      const { service, progress } = setup({ hasVideo: true });
      progress.findOne.mockResolvedValue({ enrollment_id: 'e1', lesson_id: 'l1', completed_at: new Date() });
      const result = await service.saveVideoProgress(ctx, 'l1', 10, 120);
      expect(result.completed).toBe(true);
      expect(progress.save).not.toHaveBeenCalled();
    });
  });

  describe('/complete', () => {
    it('refuses a video lesson without enough watching, then completes it with the final position after enough time', async () => {
      const { service, progress, videoRows } = setup({
        hasVideo: true,
        videoDuration: 120,
        existingVideoRow: watching({ position_seconds: 100, percent_watched: 83, started_at: ago(60) }),
      });
      const err = await refusal(service.completeLesson(ctx, 'l1'));
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual({ statusCode: 409, message: FINISH });
      expect(progress.save).not.toHaveBeenCalled();

      const result = await service.completeLesson(ctx, 'l1', 118);
      expect(videoRows[videoRows.length - 1]).toEqual(expect.objectContaining({ position_seconds: 118, percent_watched: 98 }));
      expect(progress.save).toHaveBeenCalledWith(expect.objectContaining({ lesson_id: 'l1', enrollment_id: 'e1' }));
      expect(result).toEqual(expect.objectContaining({ enrollment_id: 'e1' }));
    });

    it('answers 409 with retry_after_seconds, rounded up, when only the elapsed time is missing', async () => {
      jest.useFakeTimers({ now: NOW });
      // 120 s required: 54 s must pass; 20.7 s have, so 33.3 s are left.
      const { service, progress } = setup({
        hasVideo: true,
        videoDuration: 120,
        existingVideoRow: watching({ started_at: new Date(NOW - 20_700) }),
      });
      const err = await refusal(service.completeLesson(ctx, 'l1', 120));
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual({ statusCode: 409, message: FINISH, retry_after_seconds: 34 });
      expect(progress.save).not.toHaveBeenCalled();
    });

    it('never asks to wait less than one whole second', async () => {
      jest.useFakeTimers({ now: NOW });
      const { service } = setup({
        hasVideo: true,
        videoDuration: 120,
        existingVideoRow: watching({ percent_watched: 95, started_at: new Date(NOW - 53_900) }),
      });
      const err = await refusal(service.completeLesson(ctx, 'l1'));
      expect((err as ConflictException).getResponse()).toEqual({ statusCode: 409, message: FINISH, retry_after_seconds: 1 });
    });

    it('refuses a video lesson with no known length, without retry_after_seconds', async () => {
      // No measured duration and no heartbeat yet: a claimed final position proves nothing.
      const { service, progress } = setup({ hasVideo: true, videoDuration: null });
      const err = await refusal(service.completeLesson(ctx, 'l1', 500));
      expect((err as ConflictException).getResponse()).toEqual({ statusCode: 409, message: FINISH });
      expect(progress.save).not.toHaveBeenCalled();
    });

    it('never meets the time check with a null started_at', async () => {
      const { service, progress } = setup({
        hasVideo: true,
        videoDuration: 120,
        existingVideoRow: watching({ position_seconds: 115, percent_watched: 95, started_at: null }),
      });
      const err = await refusal(service.completeLesson(ctx, 'l1'));
      expect((err as ConflictException).getResponse()).toEqual({ statusCode: 409, message: FINISH });
      expect(progress.save).not.toHaveBeenCalled();
    });

    it('stays idempotent for a video lesson completed earlier', async () => {
      const { service, progress } = setup({ hasVideo: true, videoDuration: 120 });
      progress.findOne.mockResolvedValue({ enrollment_id: 'e1', lesson_id: 'l1', completed_at: new Date() });
      await expect(service.completeLesson(ctx, 'l1')).resolves.toEqual(expect.objectContaining({ enrollment_id: 'e1' }));
      expect(progress.save).not.toHaveBeenCalled();
    });

    it('completes a lesson without video as before, ignoring the position', async () => {
      const { service, progress, videoProgress } = setup({ hasVideo: false });
      await service.completeLesson(ctx, 'l1', 5);
      expect(progress.save).toHaveBeenCalledWith(expect.objectContaining({ lesson_id: 'l1', enrollment_id: 'e1' }));
      expect(videoProgress.save).not.toHaveBeenCalled();
    });

    it('treats a lesson as one without video when the course service sends no has_video', async () => {
      const { service, progress } = setup(); // an older course service: no has_video in the response
      await service.completeLesson(ctx, 'l1');
      expect(progress.save).toHaveBeenCalledWith(expect.objectContaining({ lesson_id: 'l1', enrollment_id: 'e1' }));
    });
  });

  it('logs each refused completion with the lesson, the required length and the elapsed time, never the email', async () => {
    jest.useFakeTimers({ now: NOW });
    const log = jest.spyOn(Logger.prototype, 'log');
    const { service } = setup({ hasVideo: true, videoDuration: 120, existingVideoRow: watching({ started_at: new Date(NOW - 20_000) }) });
    await service.saveVideoProgress(ctx, 'l1', 110, 120); // 92% too early
    await refusal(service.completeLesson(ctx, 'l1'));
    const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('refused'));
    log.mockRestore();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/lesson l1\b/);
      expect(line).toMatch(/required 120s/);
      expect(line).toMatch(/elapsed 20s/);
      expect(line).not.toContain('l@e.et');
    }
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

  it('enrolls a learner on a free published course and emits EnrollmentCreated', async () => {
    const { service, committed } = setup({ entitlement: null });
    const result = (await service.enrollFree(ctx, 'c1')) as { entitlement_status: EntitlementStatus };
    expect(result.entitlement_status).toBe(EntitlementStatus.ACTIVE);
    expect(committed).toEqual([{ type: 'EnrollmentCreated', payload: expect.objectContaining({ course_id: 'c1' }) }]);
  });
});

describe('EnrollmentService: EnrollmentCreated commits with the activation (Phase 9b)', () => {
  const payment = { payment_id: 'p1', learner_id: 'u1', learner_email: 'l@e.et', learner_name: 'Learner', course_id: 'c1', course_title: 'Course' };
  const sponsorship = { sponsorship_id: 's1', source: 'gift', sponsor_id: 'sp1', recipient_user_id: 'u1', recipient_email: 'l@e.et', course_id: 'c1', course_title: 'Course' };
  const handler = (bus: { subscribe: jest.Mock }, type: string) =>
    bus.subscribe.mock.calls.find(([t]) => t === type)![1] as (p: unknown) => Promise<void>;

  it('saves a free enrollment and EnrollmentCreated in one transaction, after the name lookups', async () => {
    const t = setup({ entitlement: null });
    t.enrollments.save.mockImplementation(async (e: unknown) => ({ ...(e as object), id: 'e9' }));
    const saves = trackTx(t.enrollments.save, t.inTransaction);
    const lookups = trackTx(t.internal.get, t.inTransaction);
    await t.service.enrollFree(ctx, 'c1');
    expect(saves).toEqual([true]);
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups).not.toContain(true);
    expect(t.committed).toEqual([
      {
        type: 'EnrollmentCreated',
        payload: {
          enrollment_id: 'e9',
          learner_id: 'u1',
          learner_email: 'l@e.et',
          learner_name: 'Someone',
          course_id: 'c1',
          course_title: 'Course',
          educator_name: '',
          pricing_type: 'free',
        },
      },
    ]);
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('commits neither the free enrollment nor its event when the transaction fails before commit', async () => {
    const t = setup({ entitlement: null });
    const saves = trackTx(t.enrollments.save, t.inTransaction);
    t.failNextCommit(new Error('outbox insert failed'));
    await expect(t.service.enrollFree(ctx, 'c1')).rejects.toThrow('outbox insert failed');
    // The save ran inside the transaction that failed, so it rolled back with it.
    expect(saves).toEqual([true]);
    expect(t.committed).toEqual([]);
  });

  it.each([
    ['PaymentConfirmed', payment, { source: 'payment', sponsor_id: null }],
    ['SponsorshipGranted', sponsorship, { source: 'sponsorship', sponsor_id: 'sp1' }],
  ])('a %s activation and its EnrollmentCreated commit together', async (type, event, fields) => {
    const t = setup({ entitlement: EntitlementStatus.REFUNDED });
    const saves = trackTx(t.enrollments.save, t.inTransaction);
    t.service.onModuleInit();
    await handler(t.bus, type)(event);
    expect(saves).toEqual([true]);
    expect(t.enrollments.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1', entitlement_status: EntitlementStatus.ACTIVE, ...fields }));
    expect(t.committed).toEqual([
      { type: 'EnrollmentCreated', payload: expect.objectContaining({ enrollment_id: 'e1', learner_id: 'u1', learner_email: 'l@e.et', pricing_type: PricingType.PAID }) },
    ]);
  });

  it.each(['PaymentConfirmed', 'SponsorshipGranted'])('a %s for an enrollment already active opens no transaction and emits nothing', async (type) => {
    const t = setup();
    t.service.onModuleInit();
    await handler(t.bus, type)(type === 'PaymentConfirmed' ? payment : sponsorship);
    expect(t.outbox.transaction).not.toHaveBeenCalled();
    expect(t.committed).toEqual([]);
  });

  it('a grant whose transaction fails commits nothing and throws, so the bus retries the event', async () => {
    const t = setup({ entitlement: null });
    const saves = trackTx(t.enrollments.save, t.inTransaction);
    t.failNextCommit(new Error('outbox insert failed'));
    t.service.onModuleInit();
    await expect(handler(t.bus, 'PaymentConfirmed')(payment)).rejects.toThrow('outbox insert failed');
    expect(saves).toEqual([true]);
    expect(t.committed).toEqual([]);
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

describe('EnrollmentService: completion is emitted once', () => {
  it('does not emit CourseCompleted when another path completed the enrollment first', async () => {
    const { service, enrollments, committed } = setup({ lessonIds: ['l1'], completedCount: 1 });
    enrollments.update.mockResolvedValue({ affected: 0 });
    await service.completeLesson(ctx, 'l1');
    expect(enrollments.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1', completed_at: expect.anything() }),
      { completed_at: expect.any(Date) },
    );
    expect(committed).toEqual([]);
  });
});

describe('EnrollmentService: CourseCompleted commits with the completion (Phase 9b)', () => {
  /** setup() whose auth lookups fail, as when auth is asleep. */
  const authDown = (t: ReturnType<typeof setup>) => {
    const get = t.internal.get.getMockImplementation()!;
    t.internal.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/v1/internal/users/')) throw new Error(`Internal request failed: GET ${path} -> 503`);
      return get(path);
    });
  };

  it('commits the conditional completed_at write and CourseCompleted together, after the name lookups', async () => {
    const t = setup({ lessonIds: ['l1'], completedCount: 1 });
    const updates = trackTx(t.enrollments.update, t.inTransaction);
    const lookups = trackTx(t.internal.get, t.inTransaction);
    await t.service.completeLesson(ctx, 'l1');
    expect(updates).toEqual([true]);
    expect(lookups).not.toContain(true);
    const [, patch] = t.enrollments.update.mock.calls[0];
    expect(t.committed).toEqual([
      {
        type: 'CourseCompleted',
        payload: {
          enrollment_id: 'e1',
          learner_id: 'u1',
          learner_email: 'l@e.et',
          learner_name: 'Someone',
          course_id: 'c1',
          course_title: 'Course',
          educator_id: 'edu1',
          educator_name: 'Someone',
          completed_at: patch.completed_at.toISOString(),
        },
      },
    ]);
  });

  it('auth down: completed_at is still set and CourseCompleted commits with blank names', async () => {
    const t = setup({ lessonIds: ['l1'], completedCount: 1 });
    authDown(t);
    await expect(t.service.completeLesson(ctx, 'l1')).resolves.toEqual(expect.objectContaining({ enrollment_id: 'e1' }));
    expect(t.enrollments.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), { completed_at: expect.any(Date) });
    expect(t.committed).toEqual([
      {
        type: 'CourseCompleted',
        payload: expect.objectContaining({ enrollment_id: 'e1', learner_email: 'l@e.et', learner_name: '', course_title: '', educator_id: '', educator_name: '' }),
      },
    ]);
  });

  it('commits neither when the transaction fails before commit, and completing the lesson again re-detects it', async () => {
    const t = setup({ lessonIds: ['l1'], completedCount: 1 });
    const updates = trackTx(t.enrollments.update, t.inTransaction);
    t.failNextCommit(new Error('outbox insert failed'));
    await expect(t.service.completeLesson(ctx, 'l1')).rejects.toThrow('outbox insert failed');
    // The conditional write ran inside the transaction that failed, so it rolled back with it.
    expect(updates).toEqual([true]);
    expect(t.committed).toEqual([]);

    await t.service.completeLesson(ctx, 'l1');
    expect(t.committed).toEqual([{ type: 'CourseCompleted', payload: expect.objectContaining({ enrollment_id: 'e1' }) }]);
  });
});

describe('EnrollmentService: RefundApproved (P1-63)', () => {
  const refund = (extra: Record<string, unknown> = {}) => ({ refund_request_id: 'r1', payment_id: 'p1', learner_id: 'u1', course_id: 'c1', ...extra });
  const handler = (bus: { subscribe: jest.Mock }) =>
    bus.subscribe.mock.calls.find(([type]) => type === 'RefundApproved')![1] as (p: unknown) => Promise<void>;

  it('keeps access when financial says the learner holds the course another way', async () => {
    const { service, bus, enrollments } = setup();
    service.onModuleInit();
    await handler(bus)(refund({ access_kept: true }));
    expect(enrollments.update).not.toHaveBeenCalled();
    expect(enrollments.save).not.toHaveBeenCalled();
  });

  it.each([['absent (an older financial)', {}], ['false', { access_kept: false }]])(
    'revokes with a conditional update on an active row when the flag is %s',
    async (_label, extra) => {
      const { service, bus, enrollments } = setup();
      service.onModuleInit();
      await handler(bus)(refund(extra));
      expect(enrollments.update).toHaveBeenCalledWith(
        { learner_id: 'u1', course_id: 'c1', entitlement_status: EntitlementStatus.ACTIVE },
        { entitlement_status: EntitlementStatus.REFUNDED },
      );
      expect(enrollments.save).not.toHaveBeenCalled();
    },
  );

  it('an already refunded row stays refunded: the update matches nothing', async () => {
    const { service, bus, enrollments } = setup({ entitlement: EntitlementStatus.REFUNDED });
    enrollments.update.mockResolvedValue({ affected: 0 });
    service.onModuleInit();
    await expect(handler(bus)(refund())).resolves.toBeUndefined();
    expect(enrollments.save).not.toHaveBeenCalled();
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
  const tx = fakeOutbox(managerFor(enrollments));
  const service = new EnrollmentService(
    enrollments as never,
    progress as never,
    courseCache as never,
    videoProgress as never,
    bus as never,
    internal as never,
    tx.outbox as never,
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
  return { closed, enrollments, progress, videoProgress, courseCache, bus, internal, findCalls, rows, ...tx };
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

    const completions = t.committed.filter((e) => e.type === 'CourseCompleted');
    expect(completions).toHaveLength(1);
    expect(completions[0].payload).toEqual(
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
    expect(t.committed.filter((e) => e.type === 'CourseCompleted')).toHaveLength(450);
  });

  it('skips enrollments that are already complete or not active', async () => {
    const t = revisionSetup([row('e1', new Date('2026-01-01')), row('e2', null, EntitlementStatus.REFUNDED)], { e1: 2, e2: 2 });
    await t.closed({ removed_lesson_ids: ['l3'] });
    expect(t.committed).toEqual([]);
    expect(t.enrollments.update).not.toHaveBeenCalled();
  });

  it('does not re-check completion when no lesson was removed', async () => {
    const t = revisionSetup([row('e1')], { e1: 2 });
    await t.closed({ added_lesson_ids: ['l9'] });
    expect(t.enrollments.find).not.toHaveBeenCalled();
    expect(t.committed).toEqual([]);
  });

  it('resets watch state for replaced videos but keeps lesson completions', async () => {
    const t = revisionSetup([row('e1')], { e1: 1 });
    await t.closed({ replaced_video_lesson_ids: ['l1', 'l2'] });

    expect(t.videoProgress.update).toHaveBeenCalledTimes(1);
    const [criteria, patch] = t.videoProgress.update.mock.calls[0];
    expect(criteria.lesson_id.value).toEqual(['l1', 'l2']);
    // started_at null restarts the time check for the new video (now() would let a late return complete at once).
    expect(patch).toEqual(expect.objectContaining({ position_seconds: 0, duration_seconds: 0, percent_watched: 0, started_at: null }));
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
    expect(t.committed).toEqual([]);
  });

  it('completes a learner while auth is down: completed_at set, CourseCompleted with a blank email and names', async () => {
    const t = revisionSetup([row('e1')], { e1: 2 });
    const get = t.internal.get.getMockImplementation()!;
    t.internal.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/v1/internal/users/')) throw new Error(`Internal request failed: GET ${path} -> 503`);
      return get(path);
    });
    await t.closed({ removed_lesson_ids: ['l3'] });
    expect(t.rows[0].completed_at).toBeInstanceOf(Date);
    expect(t.committed).toEqual([
      { type: 'CourseCompleted', payload: expect.objectContaining({ enrollment_id: 'e1', learner_email: '', learner_name: '', educator_name: '' }) },
    ]);
  });

  it('keeps going when one enrollment fails', async () => {
    const t = revisionSetup([row('e1'), row('e2')], { e1: 2, e2: 2 });
    t.enrollments.update.mockRejectedValueOnce(new Error('deadlock'));
    await t.closed({ removed_lesson_ids: ['l3'] });
    const completed = t.committed.filter((e) => e.type === 'CourseCompleted').map((e) => e.payload.enrollment_id);
    expect(completed).toEqual(['e2']);
  });
});
