import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OutboxService } from '@ethiopialearn/common';
import { TrustTier } from '@ethiopialearn/contracts';
import { CourseReview, EducatorTrustTier } from './entities';
import { QualityService } from './quality.service';
import { fakeDataSource } from './testing/fake-data-source';

const ctx = { id: 'u1', role: 'learner', email: 'l@e.et' } as never;

interface Options {
  entitlementStatus?: string;
  progress?: number;
  existingReview?: boolean;
  reviews?: { rating: number }[];
  /** For the tier: the owner's published courses (course service) and their average rating. */
  publishedCount?: number;
  avgRating?: string | null;
}

function setup(opts: Options = {}) {
  const reviewRows: object[] = [];
  const courseReviews = {
    rows: reviewRows,
    findOne: jest.fn().mockResolvedValue(opts.existingReview ? { id: 'r0' } : null),
    save: jest.fn(async (r: object) => {
      reviewRows.push(r);
      return { id: 'r1', ...r };
    }),
    create: jest.fn((r: object) => r),
    find: jest.fn().mockResolvedValue(opts.reviews ?? [{ rating: 5 }]),
    createQueryBuilder: jest.fn(() => {
      const qb = { select: () => qb, where: () => qb, getRawOne: async () => ({ avg: opts.avgRating ?? null }) };
      return qb;
    }),
  };
  const tierRows: { educator_id: string; tier: TrustTier }[] = [];
  const trustTiers = {
    rows: tierRows,
    findOne: jest.fn(async ({ where }: { where: { educator_id: string } }) => tierRows.find((r) => r.educator_id === where.educator_id) ?? null),
    save: jest.fn(async (x: { educator_id: string; tier: TrustTier }) => {
      tierRows.push(x);
      return x;
    }),
    create: jest.fn((x: unknown) => x),
  };
  const noopRepo = () => ({
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(async (x: unknown) => x),
    create: jest.fn((x: unknown) => x),
    count: jest.fn().mockResolvedValue(0),
  });
  const courseCache = { ...noopRepo(), find: jest.fn().mockResolvedValue([{ course_id: 'c1', owner_id: 'edu-1' }]) };
  const bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn(), isConnected: jest.fn(() => false), publishConfirmed: jest.fn() };
  const internal = {
    get: jest.fn(async (path: string) =>
      path.endsWith('/published-count')
        ? { published_count: opts.publishedCount ?? 0 }
        : { entitlement_status: opts.entitlementStatus ?? 'active', progress_percent: opts.progress ?? 50 },
    ),
  };
  const db = fakeDataSource(
    new Map<unknown, unknown>([
      [CourseReview, courseReviews],
      [EducatorTrustTier, trustTiers],
    ]),
  );
  const service = new QualityService(
    noopRepo() as never, // reviewItems
    courseReviews as never,
    noopRepo() as never, // fraudSignals
    trustTiers as never,
    courseCache as never,
    noopRepo() as never, // stats
    noopRepo() as never, // refundLog
    bus as never,
    internal as never,
    db.dataSource,
    new OutboxService(db.dataSource, bus as never),
  );
  return { service, bus, courseReviews, trustTiers, db };
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
    const { service, db } = setup({ reviews: [{ rating: 5 }, { rating: 4 }] });
    await service.addReview(ctx, 'c1', 4, 'solid course');
    expect(db.outbox.map((r) => [r.event_type, r.payload])).toEqual([
      ['CourseRated', expect.objectContaining({ course_id: 'c1', average_rating: 4.5, rating_count: 2, total_points: 9 })],
    ]);
  });
});

describe('QualityService: CourseRated and TrustTierChanged commit with their writes (9b outbox)', () => {
  it('a review and its CourseRated commit together; an error before commit leaves neither', async () => {
    const t = setup({ reviews: [{ rating: 4 }] });
    t.db.opts.failNextOutboxInsert = true;
    await expect(t.service.addReview(ctx, 'c1', 4)).rejects.toThrow('outbox insert failed');
    expect(t.courseReviews.rows).toEqual([]);
    expect(t.db.outbox).toEqual([]);

    await t.service.addReview(ctx, 'c1', 4);
    expect(t.courseReviews.rows).toEqual([expect.objectContaining({ course_id: 'c1', learner_id: 'u1', rating: 4 })]);
    expect(t.db.outbox).toEqual([expect.objectContaining({ event_type: 'CourseRated', published_at: null })]);
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('a tier change and its TrustTierChanged commit together; an error before commit leaves neither', async () => {
    // 5 published courses rated 4.5 with no refunds: new -> proven.
    const t = setup({ publishedCount: 5, avgRating: '4.5' });
    const recompute = (payeeId: string) => (t.service as unknown as { recomputeTier(id: string): Promise<void> }).recomputeTier(payeeId);
    t.db.opts.failNextOutboxInsert = true;
    await expect(recompute('edu-1')).rejects.toThrow('outbox insert failed');
    expect(t.trustTiers.rows).toEqual([]);
    expect(t.db.outbox).toEqual([]);

    await recompute('edu-1');
    expect(t.trustTiers.rows).toEqual([expect.objectContaining({ educator_id: 'edu-1', tier: TrustTier.PROVEN })]);
    expect(t.db.outbox.map((r) => [r.event_type, r.payload])).toEqual([
      ['TrustTierChanged', { educator_id: 'edu-1', previous_tier: TrustTier.NEW, new_tier: TrustTier.PROVEN }],
    ]);
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('a first computation that stays at new saves the tier and emits nothing', async () => {
    const t = setup();
    await (t.service as unknown as { recomputeTier(id: string): Promise<void> }).recomputeTier('edu-1');
    expect(t.trustTiers.rows).toEqual([expect.objectContaining({ educator_id: 'edu-1', tier: TrustTier.NEW })]);
    expect(t.db.outbox).toEqual([]);
  });
});
