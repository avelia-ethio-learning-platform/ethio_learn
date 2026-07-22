import { BadRequestException, ForbiddenException } from '@nestjs/common';
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
  };
  const courseCache = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn(), create: jest.fn() };
  const bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.includes('/lesson-ids')) return { lesson_ids: opts.lessonIds ?? ['l1', 'l2'] };
      if (path.startsWith('/api/v1/internal/lessons/')) return { course_id: 'c1' };
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
  return { service, enrollments, progress, videoProgress, videoRows, bus };
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
