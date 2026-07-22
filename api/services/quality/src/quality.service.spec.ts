import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { QualityService } from './quality.service';

const ctx = { id: 'u1', role: 'learner', email: 'l@e.et' } as never;

interface Options {
  entitlementStatus?: string;
  progress?: number;
  existingReview?: boolean;
  reviews?: { rating: number }[];
}

function setup(opts: Options = {}) {
  const courseReviews = {
    findOne: jest.fn().mockResolvedValue(opts.existingReview ? { id: 'r0' } : null),
    save: jest.fn(async (r: object) => ({ id: 'r1', ...r })),
    create: jest.fn((r: object) => r),
    find: jest.fn().mockResolvedValue(opts.reviews ?? [{ rating: 5 }]),
    createQueryBuilder: jest.fn(),
  };
  const noopRepo = () => ({
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(async (x: unknown) => x),
    create: jest.fn((x: unknown) => x),
    count: jest.fn().mockResolvedValue(0),
  });
  const bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
  const internal = {
    get: jest.fn().mockResolvedValue({
      entitlement_status: opts.entitlementStatus ?? 'active',
      progress_percent: opts.progress ?? 50,
    }),
  };
  const service = new QualityService(
    noopRepo() as never, // reviewItems
    courseReviews as never,
    noopRepo() as never, // fraudSignals
    noopRepo() as never, // trustTiers
    noopRepo() as never, // courseCache
    noopRepo() as never, // stats
    noopRepo() as never, // refundLog
    bus as never,
    internal as never,
  );
  return { service, bus, courseReviews };
}

describe('QualityService.addReview (spec §10.7)', () => {
  it('requires ≥20% progress on an active entitlement', async () => {
    const tooEarly = setup({ progress: 10 });
    await expect(tooEarly.service.addReview(ctx, 'c1', 5)).rejects.toThrow(ForbiddenException);

    const notEnrolled = setup({ entitlementStatus: 'none' });
    await expect(notEnrolled.service.addReview(ctx, 'c1', 5)).rejects.toThrow(ForbiddenException);
  });

  it('allows exactly one review per learner per course', async () => {
    const { service } = setup({ existingReview: true });
    await expect(service.addReview(ctx, 'c1', 4)).rejects.toThrow(BadRequestException);
  });

  it('saves the review and broadcasts fresh aggregates for catalog ranking', async () => {
    const { service, bus } = setup({ reviews: [{ rating: 5 }, { rating: 4 }] });
    await service.addReview(ctx, 'c1', 4, 'solid course');
    expect(bus.publish).toHaveBeenCalledWith(
      'CourseRated',
      expect.objectContaining({ course_id: 'c1', average_rating: 4.5, rating_count: 2, total_points: 9 }),
    );
  });
});
