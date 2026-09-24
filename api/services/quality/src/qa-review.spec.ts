import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import {
  CourseAppealSubmittedPayload,
  CourseRevisionSubmittedPayload,
  CourseSubmittedPayload,
  OwnerType,
  PricingType,
  QaDecisionAction,
  QaReviewStatus,
  RevisionDiffSummary,
} from '@ethiopialearn/contracts';
import { CLAIM_TTL_MS, isLowRiskRevision, QualityService } from './quality.service';

type Row = Record<string, any>;

const QO = { id: 'qo-1', role: 'quality_officer', email: 'qo1@x.et' } as never;
const QO2 = { id: 'qo-2', role: 'quality_officer', email: 'qo2@x.et' } as never;
const HOUR = 3600 * 1000;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
/** Lets queued promise callbacks (and the fake repos' async steps) run. */
const flush = () => new Promise((r) => setImmediate(r));
async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 50 && !cond(); i++) await flush();
  if (!cond()) throw new Error('waitFor: condition never became true');
}
const openIds = (rows: Row[]) =>
  rows.filter((r) => [QaReviewStatus.PENDING, QaReviewStatus.IN_REVIEW].includes(r.status)).map((r) => r.id);

// ---- In-memory repository honouring the TypeORM find operators the service uses ----

function matchesOp(op: FindOperator<unknown>, value: unknown): boolean {
  switch (op.type) {
    case 'in':
      return (op.value as unknown[]).includes(value);
    case 'isNull':
      return value === null || value === undefined;
    case 'lessThan':
      return value != null && (value as Date) < (op.value as Date);
    case 'not':
      return value !== op.value;
    default:
      throw new Error(`fake repo: unsupported operator ${op.type}`);
  }
}

function matches(row: Row, where: Row | Row[]): boolean {
  return (Array.isArray(where) ? where : [where]).some((clause) =>
    Object.entries(clause).every(([key, cond]) =>
      cond instanceof FindOperator ? matchesOp(cond, row[key]) : row[key] === cond,
    ),
  );
}

function withDefaults(x: Row): Row {
  return {
    course_title: 'Live title',
    owner_id: 'owner-1',
    owner_type: OwnerType.EDUCATOR,
    owner_user_id: 'user-1',
    owner_email: 'edu@x.et',
    owner_name: 'Edu',
    qo_id: null,
    status: QaReviewStatus.PENDING,
    coaching_notes: '',
    plagiarism: {},
    trigger: 'submission',
    kind: 'new_course',
    revision_id: null,
    content_hash: null,
    diff_summary: {},
    changelog_summary: '',
    priority: 0,
    claimed_by: null,
    claimed_at: null,
    created_at: new Date(),
    reviewed_at: null,
    ...x,
  };
}

type FindOpts = { where: Row | Row[]; order?: { created_at?: 'ASC' | 'DESC' }; take?: number };

function itemsRepo(seed: Row[]) {
  const rows: Row[] = seed.map(withDefaults);
  let seq = rows.length;
  const find = async (opts: FindOpts): Promise<Row[]> => {
    let out = rows.filter((r) => matches(r, opts.where));
    const dir = opts.order?.created_at;
    if (dir) out = out.sort((a, b) => (a.created_at - b.created_at) * (dir === 'DESC' ? -1 : 1));
    if (opts.take) out = out.slice(0, opts.take);
    // Copies, like rows read from a database: only update()/save() change stored state.
    return out.map((r) => ({ ...r }));
  };
  return {
    rows,
    create: jest.fn((x: Row) => withDefaults(x)),
    save: jest.fn(async (x: Row) => {
      if (!x.id) x.id = `item-${++seq}`;
      const i = rows.findIndex((r) => r.id === x.id);
      if (i >= 0) rows[i] = { ...x };
      else rows.push({ ...x });
      return x;
    }),
    find: jest.fn(find),
    findOne: jest.fn(async (opts: FindOpts) => (await find({ ...opts, take: 1 }))[0] ?? null),
    update: jest.fn(async (where: Row | Row[], set: Row) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, set));
      return { affected: hit.length };
    }),
  };
}

interface SetupOptions {
  items?: Row[];
  cache?: Row[];
  plagiarism?: Record<string, unknown> | Error;
}

function setup(opts: SetupOptions = {}) {
  const reviewItems = itemsRepo(opts.items ?? []);
  const cacheRows: Row[] = [...(opts.cache ?? [])];
  const courseCache = {
    findOne: jest.fn(async ({ where }: { where: Row }) => cacheRows.find((c) => c.course_id === where.course_id) ?? null),
    save: jest.fn(async (x: Row) => {
      cacheRows.push(x);
      return x;
    }),
    create: jest.fn((x: Row) => x),
    createQueryBuilder: jest.fn(() => {
      const qb = {
        select: () => qb,
        where: () => qb,
        andWhere: () => qb,
        limit: () => qb,
        getRawMany: async () => [{ title: 'Another owner course' }],
      };
      return qb;
    }),
  };
  const repo = () => ({
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(async (x: Row) => ({ id: 'row-1', ...x })),
    create: jest.fn((x: Row) => x),
  });
  const handlers: Record<string, (p: unknown) => Promise<void>> = {};
  const bus = {
    publish: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn((type: string, h: (p: unknown) => Promise<void>) => {
      handlers[type] = h;
    }),
  };
  const service = new QualityService(
    reviewItems as never,
    repo() as never, // courseReviews
    repo() as never, // fraudSignals
    repo() as never, // trustTiers
    courseCache as never,
    repo() as never, // stats
    repo() as never, // refundLog
    bus as never,
    { get: jest.fn() } as never,
  );
  const plagiarismCheck = jest.fn(async () => {
    if (opts.plagiarism instanceof Error) throw opts.plagiarism;
    return opts.plagiarism ?? { similarity_score: 3, flagged: false, reason: 'clear' };
  });
  (service as unknown as { ai: unknown }).ai = { plagiarismCheck };
  service.onModuleInit();
  const published = (type: string) => bus.publish.mock.calls.filter((c) => c[0] === type).map((c) => c[1]);
  return { service, reviewItems, cacheRows, courseCache, bus, handlers, plagiarismCheck, published };
}

function diffSummary(over: Partial<RevisionDiffSummary> = {}): RevisionDiffSummary {
  return {
    fields_changed: [],
    sections_added: 0,
    sections_removed: 0,
    sections_changed: 0,
    lessons_added: 1,
    lessons_removed: 0,
    lessons_changed: 0,
    videos_replaced: 0,
    price_from: null,
    price_to: null,
    pricing_type_from: null,
    pricing_type_to: null,
    new_free_preview_section: false,
    knowledge_added: 0,
    assessments_added: 0,
    ...over,
  };
}

function revisionPayload(over: Partial<CourseRevisionSubmittedPayload> = {}): CourseRevisionSubmittedPayload {
  return {
    course_id: 'c1',
    revision_id: 'rev-1',
    course_title: 'Live title',
    owner_id: 'owner-1',
    owner_type: OwnerType.EDUCATOR,
    owner_user_id: 'user-1',
    owner_email: 'edu@x.et',
    owner_name: 'Edu',
    diff_summary: diffSummary(),
    changed_text: 'Lesson: Loops in Python — how for-loops work',
    changelog_summary: 'Added a lesson on loops',
    major: false,
    content_hash: 'hash-A',
    assessment_ids: [],
    ...over,
  };
}

// ---- Enqueue paths ----

describe('QualityService enqueue paths set the item kind', () => {
  it('CourseSubmitted → new_course item, closing any stale open submission item of the same course', async () => {
    const t = setup({
      items: [
        { id: 'stale', course_id: 'c1', kind: 'new_course', status: QaReviewStatus.PENDING },
        { id: 'rev-open', course_id: 'c1', kind: 'revision', revision_id: 'rev-1' },
        { id: 'other-course', course_id: 'c2', kind: 'new_course' },
      ],
    });
    const payload: CourseSubmittedPayload = {
      course_id: 'c1',
      title: 'Intro to Python',
      description: 'Learn Python',
      owner_id: 'owner-1',
      owner_type: OwnerType.EDUCATOR,
      owner_user_id: 'user-1',
      owner_email: 'edu@x.et',
      owner_name: 'Edu',
      pricing_type: PricingType.FREE,
    };
    await t.handlers.CourseSubmitted(payload);

    const created = t.reviewItems.rows.find((r) => r.id === 'item-4');
    expect(created).toMatchObject({ kind: 'new_course', status: QaReviewStatus.PENDING, owner_user_id: 'user-1' });
    expect(t.reviewItems.rows.find((r) => r.id === 'stale')!.status).toBe(QaReviewStatus.WITHDRAWN);
    // A revision item and other courses' items are not superseded by a new submission.
    expect(t.reviewItems.rows.find((r) => r.id === 'rev-open')!.status).toBe(QaReviewStatus.PENDING);
    expect(t.reviewItems.rows.find((r) => r.id === 'other-course')!.status).toBe(QaReviewStatus.PENDING);
  });

  it('CourseAppealSubmitted → appeal item', async () => {
    const t = setup({ items: [{ id: 'old', course_id: 'c1', status: QaReviewStatus.FLAGGED }] });
    const payload: CourseAppealSubmittedPayload = {
      course_id: 'c1',
      course_title: 'Live title',
      owner_user_id: 'user-1',
      owner_email: 'edu@x.et',
      appeal_note: 'Fixed the copied section',
    };
    await t.handlers.CourseAppealSubmitted(payload);
    expect(t.reviewItems.rows.at(-1)).toMatchObject({ kind: 'appeal', status: QaReviewStatus.PENDING });
  });

  it('post-publish re-review → post_publish item that keeps the owner user id for the decision notification', async () => {
    const t = setup({
      items: [
        {
          id: 'approved',
          course_id: 'c1',
          status: QaReviewStatus.APPROVED,
          owner_user_id: 'user-9',
          owner_email: 'nine@x.et',
          created_at: minutesAgo(600),
        },
      ],
    });
    await t.service['reopenForReview']('c1', 'avg_rating 2.00 < 2.5');
    expect(t.reviewItems.rows.at(-1)).toMatchObject({
      kind: 'post_publish',
      status: QaReviewStatus.PENDING,
      owner_user_id: 'user-9',
      owner_email: 'nine@x.et',
      trigger: 'post-publish: avg_rating 2.00 < 2.5',
    });
  });

  it('post-publish re-review is not suppressed by an open revision item, but is by an open course item', async () => {
    const withRevision = setup({ items: [{ id: 'rev', course_id: 'c1', kind: 'revision', revision_id: 'rev-1' }] });
    await withRevision.service['reopenForReview']('c1', 'refund rate');
    expect(withRevision.reviewItems.rows.map((r) => r.kind)).toEqual(['revision', 'post_publish']);

    const withOpen = setup({ items: [{ id: 'pp', course_id: 'c1', kind: 'post_publish' }] });
    await withOpen.service['reopenForReview']('c1', 'refund rate');
    expect(withOpen.reviewItems.rows).toHaveLength(1);
  });
});

describe('CourseRevisionSubmitted → revision item', () => {
  it('creates a revision item carrying the diff, changelog and owner, and never decides it', async () => {
    const t = setup();
    await t.handlers.CourseRevisionSubmitted(revisionPayload());

    expect(t.reviewItems.rows).toHaveLength(1);
    expect(t.reviewItems.rows[0]).toMatchObject({
      kind: 'revision',
      revision_id: 'rev-1',
      content_hash: 'hash-A',
      course_title: 'Live title',
      owner_user_id: 'user-1',
      owner_email: 'edu@x.et',
      diff_summary: diffSummary(),
      changelog_summary: 'Added a lesson on loops',
      trigger: 'revision',
      status: QaReviewStatus.PENDING,
      priority: 1,
    });
    // Low risk only raises priority — no decision event is ever emitted automatically.
    expect(t.published('CourseRevisionReviewed')).toHaveLength(0);
    expect(t.published('CourseReviewed')).toHaveLength(0);
  });

  it('withdraws any other open revision item of the course, leaving other items alone', async () => {
    const t = setup({
      items: [
        { id: 'older-rev', course_id: 'c1', kind: 'revision', revision_id: 'rev-0', status: QaReviewStatus.IN_REVIEW },
        { id: 'decided-rev', course_id: 'c1', kind: 'revision', revision_id: 'rev-x', status: QaReviewStatus.COACHED },
        { id: 'post-publish', course_id: 'c1', kind: 'post_publish' },
        { id: 'other-course-rev', course_id: 'c2', kind: 'revision', revision_id: 'rev-2' },
      ],
    });
    await t.handlers.CourseRevisionSubmitted(revisionPayload());
    const status = (id: string) => t.reviewItems.rows.find((r) => r.id === id)!.status;
    expect(status('older-rev')).toBe(QaReviewStatus.WITHDRAWN);
    expect(status('decided-rev')).toBe(QaReviewStatus.COACHED);
    expect(status('post-publish')).toBe(QaReviewStatus.PENDING);
    expect(status('other-course-rev')).toBe(QaReviewStatus.PENDING);
  });

  it('screens only the changed text (capped at 8000 chars) against other owners’ titles', async () => {
    const t = setup();
    const longText = 'x'.repeat(9000);
    await t.handlers.CourseRevisionSubmitted(revisionPayload({ changed_text: longText }));
    expect(t.plagiarismCheck).toHaveBeenCalledTimes(1);
    expect(t.plagiarismCheck).toHaveBeenCalledWith('Live title', 'x'.repeat(8000), ['Another owner course']);
    expect(t.reviewItems.rows[0].plagiarism).toMatchObject({ flagged: false });
  });

  it('skips the AI screen when there is no new text (video- or price-only change)', async () => {
    const t = setup();
    await t.handlers.CourseRevisionSubmitted(revisionPayload({ changed_text: '   ' }));
    expect(t.plagiarismCheck).not.toHaveBeenCalled();
    expect(t.reviewItems.rows[0].plagiarism).toEqual({ skipped: 'no new text' });
    expect(t.reviewItems.rows[0].priority).toBe(1);
  });

  it('never overwrites the cached (live) course title, but backfills a missing cache row', async () => {
    const cached = setup({
      cache: [{ course_id: 'c1', owner_id: 'owner-1', owner_type: OwnerType.EDUCATOR, title: 'Live title' }],
    });
    await cached.handlers.CourseRevisionSubmitted(revisionPayload({ changed_text: 'Title: SPAM SPAM' }));
    expect(cached.courseCache.save).not.toHaveBeenCalled();
    expect(cached.cacheRows).toEqual([expect.objectContaining({ title: 'Live title' })]);

    const missing = setup();
    await missing.handlers.CourseRevisionSubmitted(revisionPayload());
    expect(missing.cacheRows).toEqual([
      { course_id: 'c1', owner_id: 'owner-1', owner_type: OwnerType.EDUCATOR, title: 'Live title' },
    ]);
  });

  it('a flagged screen keeps priority 0 and raises a plagiarism fraud signal', async () => {
    const t = setup({ plagiarism: { similarity_score: 91, flagged: true, reason: 'copied' } });
    await t.handlers.CourseRevisionSubmitted(revisionPayload());
    expect(t.reviewItems.rows[0].priority).toBe(0);
    expect(t.published('FraudFlagRaised')).toEqual([
      expect.objectContaining({ subject_id: 'c1', signal_type: 'plagiarism_suspected', payee_id: 'owner-1' }),
    ]);
  });

  it('a failed screen is recorded and keeps priority 0', async () => {
    const t = setup({ plagiarism: new Error('AI timeout') });
    await t.handlers.CourseRevisionSubmitted(revisionPayload());
    expect(t.reviewItems.rows[0]).toMatchObject({ plagiarism: { error: 'AI timeout' }, priority: 0 });
  });

  it.each([
    ['a replaced video', diffSummary({ videos_replaced: 1 })],
    ['a price change', diffSummary({ fields_changed: ['price_etb'], price_from: 400, price_to: 500 })],
    ['a pricing type change', diffSummary({ fields_changed: ['pricing_type'], pricing_type_from: 'free', pricing_type_to: 'paid' })],
    ['a new free-preview section', diffSummary({ new_free_preview_section: true })],
  ])('is not low risk with %s', async (_label, diff) => {
    const t = setup();
    await t.handlers.CourseRevisionSubmitted(revisionPayload({ diff_summary: diff }));
    expect(t.reviewItems.rows[0].priority).toBe(0);
  });
});

describe('isLowRiskRevision', () => {
  const clear = { flagged: false };
  it('is true only when no video, price, pricing type or free-preview change and a clear screen', () => {
    expect(isLowRiskRevision(diffSummary({ fields_changed: ['title', 'description'] }), clear)).toBe(true);
    expect(isLowRiskRevision(diffSummary(), { skipped: 'no new text' })).toBe(true);
    expect(isLowRiskRevision(diffSummary({ videos_replaced: 2 }), clear)).toBe(false);
    expect(isLowRiskRevision(diffSummary({ price_from: 400, price_to: 500 }), clear)).toBe(false);
    expect(isLowRiskRevision(diffSummary({ fields_changed: ['price_etb'] }), clear)).toBe(false);
    expect(isLowRiskRevision(diffSummary({ pricing_type_from: 'paid', pricing_type_to: 'freemium' }), clear)).toBe(false);
    expect(isLowRiskRevision(diffSummary({ new_free_preview_section: true }), clear)).toBe(false);
    expect(isLowRiskRevision(diffSummary(), { flagged: true })).toBe(false);
    expect(isLowRiskRevision(diffSummary(), { error: 'down' })).toBe(false);
    expect(isLowRiskRevision(diffSummary(), { pending: true })).toBe(false);
  });
});

describe('CourseReviewWithdrawn', () => {
  const seed = () => [
    { id: 'rev-a', course_id: 'c1', kind: 'revision', revision_id: 'rev-a', status: QaReviewStatus.IN_REVIEW },
    { id: 'rev-b', course_id: 'c1', kind: 'revision', revision_id: 'rev-b' },
    { id: 'new', course_id: 'c1', kind: 'new_course' },
    { id: 'appeal', course_id: 'c1', kind: 'appeal' },
    { id: 'pp', course_id: 'c1', kind: 'post_publish' },
    { id: 'decided', course_id: 'c1', kind: 'new_course', status: QaReviewStatus.APPROVED },
  ];
  const statuses = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.id, r.status]));

  it('with a revision_id withdraws only that revision’s open item', async () => {
    const t = setup({ items: seed() });
    await t.handlers.CourseReviewWithdrawn({ course_id: 'c1', revision_id: 'rev-a' });
    expect(statuses(t.reviewItems.rows)).toEqual({
      'rev-a': QaReviewStatus.WITHDRAWN,
      'rev-b': QaReviewStatus.PENDING,
      new: QaReviewStatus.PENDING,
      appeal: QaReviewStatus.PENDING,
      pp: QaReviewStatus.PENDING,
      decided: QaReviewStatus.APPROVED,
    });
  });

  it('with revision_id null withdraws the course’s own open submission (new course or appeal)', async () => {
    const t = setup({ items: seed() });
    await t.handlers.CourseReviewWithdrawn({ course_id: 'c1', revision_id: null });
    expect(statuses(t.reviewItems.rows)).toEqual({
      'rev-a': QaReviewStatus.IN_REVIEW,
      'rev-b': QaReviewStatus.PENDING,
      new: QaReviewStatus.WITHDRAWN,
      appeal: QaReviewStatus.WITHDRAWN,
      pp: QaReviewStatus.PENDING,
      decided: QaReviewStatus.APPROVED,
    });
  });

  it('a withdrawn item can no longer be decided', async () => {
    const t = setup({ items: seed() });
    await t.handlers.CourseReviewWithdrawn({ course_id: 'c1', revision_id: 'rev-a' });
    await expect(t.service.decideItem(QO, 'rev-a', QaDecisionAction.APPROVE)).rejects.toThrow(ConflictException);
    expect(t.published('CourseRevisionReviewed')).toHaveLength(0);
  });
});

describe('withdrawal racing the enqueue (events delivered back-to-back)', () => {
  const submitted: CourseSubmittedPayload = {
    course_id: 'c1',
    title: 'Intro to Python',
    description: 'Learn Python',
    owner_id: 'owner-1',
    owner_type: OwnerType.EDUCATOR,
    owner_user_id: 'user-1',
    owner_email: 'edu@x.et',
    owner_name: 'Edu',
    pricing_type: PricingType.FREE,
  };

  it('revision: a withdraw that arrives during the AI screen closes the item, and the late screen leaves it closed', async () => {
    const t = setup();
    const screen = deferred<Record<string, unknown>>();
    t.plagiarismCheck.mockImplementationOnce(() => screen.promise as never);

    const enqueue = t.handlers.CourseRevisionSubmitted(revisionPayload());
    await waitFor(() => t.plagiarismCheck.mock.calls.length === 1);
    // The item is queued before the screen, marked as still being screened, never low-risk yet.
    expect(t.reviewItems.rows).toHaveLength(1);
    expect(t.reviewItems.rows[0]).toMatchObject({ status: QaReviewStatus.PENDING, plagiarism: { pending: true }, priority: 0 });

    await t.handlers.CourseReviewWithdrawn({ course_id: 'c1', revision_id: 'rev-1' });
    screen.resolve({ similarity_score: 91, flagged: true, reason: 'copied' });
    await enqueue;

    expect(t.reviewItems.rows[0]).toMatchObject({ status: QaReviewStatus.WITHDRAWN, plagiarism: { pending: true } });
    expect(openIds(t.reviewItems.rows)).toEqual([]);
    await expect(t.service.decideItem(QO, t.reviewItems.rows[0].id, QaDecisionAction.APPROVE)).rejects.toThrow(ConflictException);
    // The flagged text was still submitted, so the fraud signal is raised.
    expect(t.published('FraudFlagRaised')).toHaveLength(1);
  });

  it('new course: a withdraw that arrives during the AI screen closes the item', async () => {
    const t = setup();
    const screen = deferred<Record<string, unknown>>();
    t.plagiarismCheck.mockImplementationOnce(() => screen.promise as never);

    const enqueue = t.handlers.CourseSubmitted(submitted);
    await waitFor(() => t.plagiarismCheck.mock.calls.length === 1);
    expect(t.reviewItems.rows[0]).toMatchObject({ kind: 'new_course', plagiarism: { pending: true } });

    await t.handlers.CourseReviewWithdrawn({ course_id: 'c1', revision_id: null });
    screen.resolve({ similarity_score: 3, flagged: false, reason: 'clear' });
    await enqueue;

    expect(t.reviewItems.rows[0].status).toBe(QaReviewStatus.WITHDRAWN);
    expect(openIds(t.reviewItems.rows)).toEqual([]);
  });

  it('the screen result is stored once it returns, while the item is still open', async () => {
    const t = setup();
    const screen = deferred<Record<string, unknown>>();
    t.plagiarismCheck.mockImplementationOnce(() => screen.promise as never);
    const enqueue = t.handlers.CourseRevisionSubmitted(revisionPayload());
    await waitFor(() => t.plagiarismCheck.mock.calls.length === 1);
    screen.resolve({ similarity_score: 3, flagged: false, reason: 'clear' });
    await enqueue;
    expect(t.reviewItems.rows[0]).toMatchObject({
      status: QaReviewStatus.PENDING,
      plagiarism: { similarity_score: 3, flagged: false, reason: 'clear' },
      priority: 1,
    });
  });

  it('a screen that returns after the item was decided does not touch it', async () => {
    const t = setup();
    const screen = deferred<Record<string, unknown>>();
    t.plagiarismCheck.mockImplementationOnce(() => screen.promise as never);
    const enqueue = t.handlers.CourseRevisionSubmitted(revisionPayload());
    await waitFor(() => t.plagiarismCheck.mock.calls.length === 1);
    await t.service.decideItem(QO, t.reviewItems.rows[0].id, QaDecisionAction.APPROVE);
    screen.resolve({ similarity_score: 3, flagged: false, reason: 'clear' });
    await enqueue;
    expect(t.reviewItems.rows[0]).toMatchObject({ status: QaReviewStatus.APPROVED, plagiarism: { pending: true }, priority: 0 });
  });

  it.each([
    ['revision', 'CourseRevisionSubmitted', () => revisionPayload(), 'rev-1'],
    ['new course', 'CourseSubmitted', () => submitted, null],
  ] as const)(
    '%s: submit and withdraw handled concurrently in delivery order leave no open item',
    async (_label, event, payload, revisionId) => {
      const t = setup();
      // A slow first step (the cache round trip) is what lets a one-UPDATE withdraw overtake it.
      const slow = <T>(fn: (...a: never[]) => Promise<T>) =>
        jest.fn(async (...a: never[]) => {
          await new Promise((r) => setTimeout(r, 20));
          return fn(...a);
        });
      t.courseCache.findOne = slow(t.courseCache.findOne as never) as never;
      t.courseCache.save = slow(t.courseCache.save as never) as never;

      // The bus starts each handler as its message arrives, without awaiting the previous one.
      await Promise.all([
        t.handlers[event](payload()),
        t.handlers.CourseReviewWithdrawn({ course_id: 'c1', revision_id: revisionId }),
      ]);

      expect(t.reviewItems.rows).toHaveLength(1);
      expect(t.reviewItems.rows[0].status).toBe(QaReviewStatus.WITHDRAWN);
    },
  );

  it('a withdraw of another course does not wait behind this course’s enqueue', async () => {
    const t = setup({ items: [{ id: 'c2-item', course_id: 'c2', kind: 'new_course' }] });
    const gate = deferred<void>();
    const findOne = t.courseCache.findOne;
    t.courseCache.findOne = jest.fn(async (q: { where: Row }) => {
      await gate.promise;
      return findOne(q);
    }) as never;

    const enqueue = t.handlers.CourseRevisionSubmitted(revisionPayload());
    await t.handlers.CourseReviewWithdrawn({ course_id: 'c2', revision_id: null });
    expect(t.reviewItems.rows.find((r) => r.id === 'c2-item')!.status).toBe(QaReviewStatus.WITHDRAWN);

    gate.resolve();
    await enqueue;
  });

  it('a failed enqueue does not stall the course’s later events, and the order map is released', async () => {
    const t = setup({ items: [{ id: 'appeal', course_id: 'c1', kind: 'appeal' }] });
    t.reviewItems.save.mockRejectedValueOnce(new Error('connection reset'));
    const failed = t.handlers.CourseSubmitted(submitted);
    const withdraw = t.handlers.CourseReviewWithdrawn({ course_id: 'c1', revision_id: null });
    await expect(failed).rejects.toThrow('connection reset');
    await withdraw;
    expect(t.reviewItems.rows.find((r) => r.id === 'appeal')!.status).toBe(QaReviewStatus.WITHDRAWN);
    await flush();
    expect((t.service as unknown as { courseChains: Map<string, unknown> }).courseChains.size).toBe(0);
  });
});

// ---- Queue, item detail, claim ----

describe('QualityService.queue', () => {
  it('lists open items ordered by per-kind SLA deadline, then priority, with claim state', async () => {
    const now = Date.now();
    const t = setup({
      items: [
        { id: 'rev-new', kind: 'revision', created_at: new Date(now - 1 * HOUR) }, // due +23h
        { id: 'nc-new', kind: 'new_course', created_at: new Date(now - 30 * HOUR) }, // due +18h
        { id: 'nc-old', kind: 'new_course', created_at: new Date(now - 44 * HOUR), claimed_by: 'qo-2', claimed_at: minutesAgo(40) }, // due +4h
        { id: 'rev-low', kind: 'revision', priority: 1, created_at: new Date(now - 20 * HOUR), status: QaReviewStatus.IN_REVIEW, claimed_by: 'qo-2', claimed_at: minutesAgo(5) }, // due +4h
        { id: 'decided', kind: 'revision', status: QaReviewStatus.APPROVED, created_at: new Date(now - 23 * HOUR) },
        { id: 'withdrawn', kind: 'new_course', status: QaReviewStatus.WITHDRAWN, created_at: new Date(now - 47 * HOUR) },
      ].map((r) => ({ course_id: 'c1', ...r })),
    });

    const queue = await t.service.queue();
    expect(queue.map((i) => i.id)).toEqual(['rev-low', 'nc-old', 'nc-new', 'rev-new']);

    const byId = Object.fromEntries(queue.map((i) => [i.id, i]));
    expect(byId['rev-new'].sla_deadline.getTime()).toBe(now + 23 * HOUR);
    expect(byId['nc-new'].sla_deadline.getTime()).toBe(now + 18 * HOUR);
    expect(byId['rev-low'].claim_active).toBe(true);
    expect(byId['nc-old'].claim_active).toBe(false); // claim lapsed after 30 min
    expect(byId['rev-low']).toMatchObject({ kind: 'revision', priority: 1, claimed_by: 'qo-2' });
  });
});

describe('QualityService.getItem', () => {
  it('returns the item with its SLA and claim state, or 404', async () => {
    const t = setup({ items: [{ id: 'i1', course_id: 'c1', kind: 'revision', revision_id: 'rev-1', status: QaReviewStatus.APPROVED }] });
    const item = await t.service.getItem('i1');
    expect(item).toMatchObject({ id: 'i1', kind: 'revision', revision_id: 'rev-1', claim_active: false });
    expect(item.sla_deadline).toBeInstanceOf(Date);
    await expect(t.service.getItem('missing')).rejects.toThrow(NotFoundException);
  });
});

describe('QualityService.claim', () => {
  it('moves the item to in_review and records the claimant', async () => {
    const t = setup({ items: [{ id: 'i1', course_id: 'c1' }] });
    const res = await t.service.claim(QO, 'i1');
    expect(res).toMatchObject({ status: QaReviewStatus.IN_REVIEW, claimed_by: 'qo-1', claim_active: true });
    expect(t.reviewItems.rows[0]).toMatchObject({ status: QaReviewStatus.IN_REVIEW, claimed_by: 'qo-1' });
  });

  it('409s while another officer holds a fresh claim', async () => {
    const t = setup({ items: [{ id: 'i1', course_id: 'c1', status: QaReviewStatus.IN_REVIEW, claimed_by: 'qo-2', claimed_at: minutesAgo(10) }] });
    await expect(t.service.claim(QO, 'i1')).rejects.toThrow('Already being reviewed by another officer');
    expect(t.reviewItems.rows[0].claimed_by).toBe('qo-2');
  });

  it('lets another officer take over once the claim is older than 30 minutes', async () => {
    const lapsed = new Date(Date.now() - CLAIM_TTL_MS - 60_000);
    const t = setup({ items: [{ id: 'i1', course_id: 'c1', status: QaReviewStatus.IN_REVIEW, claimed_by: 'qo-2', claimed_at: lapsed }] });
    await t.service.claim(QO, 'i1');
    expect(t.reviewItems.rows[0].claimed_by).toBe('qo-1');
  });

  it('a re-claim by the same officer refreshes the claim time', async () => {
    const earlier = minutesAgo(25);
    const t = setup({ items: [{ id: 'i1', course_id: 'c1', status: QaReviewStatus.IN_REVIEW, claimed_by: 'qo-1', claimed_at: earlier }] });
    await t.service.claim(QO, 'i1');
    expect(t.reviewItems.rows[0].claimed_at.getTime()).toBeGreaterThan(earlier.getTime());
  });

  it('409s on a closed item and 404s on an unknown one', async () => {
    const t = setup({ items: [{ id: 'i1', course_id: 'c1', status: QaReviewStatus.WITHDRAWN }] });
    await expect(t.service.claim(QO, 'i1')).rejects.toThrow(ConflictException);
    await expect(t.service.claim(QO, 'nope')).rejects.toThrow(NotFoundException);
  });

  it('409s when another officer claims between the read and the write', async () => {
    const t = setup({ items: [{ id: 'i1', course_id: 'c1' }] });
    t.reviewItems.update.mockImplementationOnce(async () => {
      Object.assign(t.reviewItems.rows[0], { status: QaReviewStatus.IN_REVIEW, claimed_by: 'qo-2', claimed_at: new Date() });
      return { affected: 0 };
    });
    await expect(t.service.claim(QO, 'i1')).rejects.toThrow('Already being reviewed by another officer');
  });
});

// ---- Decisions ----

describe('QualityService.decideItem — revision items', () => {
  const revisionItem = (over: Row = {}) => ({
    id: 'i1',
    course_id: 'c1',
    kind: 'revision',
    revision_id: 'rev-1',
    content_hash: 'hash-A',
    course_title: 'Live title',
    owner_user_id: 'user-1',
    owner_email: 'edu@x.et',
    ...over,
  });

  it('approve → APPROVED and publishes CourseRevisionReviewed (not CourseReviewed)', async () => {
    const t = setup({ items: [revisionItem()] });
    await t.service.decideItem(QO, 'i1', QaDecisionAction.APPROVE);
    expect(t.reviewItems.rows[0]).toMatchObject({ status: QaReviewStatus.APPROVED, qo_id: 'qo-1' });
    expect(t.published('CourseRevisionReviewed')).toEqual([
      {
        course_id: 'c1',
        revision_id: 'rev-1',
        review_item_id: 'i1',
        action: 'approve',
        notes: null,
        qo_id: 'qo-1',
        owner_user_id: 'user-1',
        owner_email: 'edu@x.et',
        course_title: 'Live title',
        content_hash: 'hash-A',
      },
    ]);
    expect(t.published('CourseReviewed')).toHaveLength(0);
  });

  it('coach → COACHED and reject → REJECTED, both carrying the notes', async () => {
    const coach = setup({ items: [revisionItem()] });
    await coach.service.decideItem(QO, 'i1', QaDecisionAction.COACH, '  Fix the lesson 3 audio  ');
    expect(coach.reviewItems.rows[0]).toMatchObject({ status: QaReviewStatus.COACHED, coaching_notes: 'Fix the lesson 3 audio' });
    expect(coach.published('CourseRevisionReviewed')[0]).toMatchObject({ action: 'coach', notes: 'Fix the lesson 3 audio' });

    const reject = setup({ items: [revisionItem()] });
    await reject.service.decideItem(QO, 'i1', QaDecisionAction.REJECT, 'Misleading price claim');
    expect(reject.reviewItems.rows[0].status).toBe(QaReviewStatus.REJECTED);
    expect(reject.published('CourseRevisionReviewed')[0]).toMatchObject({ action: 'reject', notes: 'Misleading price claim' });
  });

  it('coach and reject require notes', async () => {
    const t = setup({ items: [revisionItem()] });
    await expect(t.service.decideItem(QO, 'i1', QaDecisionAction.COACH, '  ')).rejects.toThrow(BadRequestException);
    await expect(t.service.decideItem(QO, 'i1', QaDecisionAction.REJECT)).rejects.toThrow(BadRequestException);
    expect(t.reviewItems.rows[0].status).toBe(QaReviewStatus.PENDING);
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('a resubmission of the same revision id supersedes the old item; each decision carries its own content hash', async () => {
    // I1 was queued for the first submission (content A). The educator withdrew, changed the
    // content and resubmitted the SAME revision id (content B) before the withdraw was consumed.
    const t = setup({ items: [revisionItem({ id: 'I1', content_hash: 'hash-A', claimed_by: 'qo-1', claimed_at: minutesAgo(2), status: QaReviewStatus.IN_REVIEW })] });
    await t.handlers.CourseRevisionSubmitted(revisionPayload({ content_hash: 'hash-B' }));

    const i2 = t.reviewItems.rows.find((r) => r.id !== 'I1')!;
    expect(i2).toMatchObject({ revision_id: 'rev-1', content_hash: 'hash-B', status: QaReviewStatus.PENDING });
    // The officer still looking at I1 can no longer approve content B through it.
    await expect(t.service.decideItem(QO, 'I1', QaDecisionAction.APPROVE)).rejects.toThrow(ConflictException);
    await t.service.decideItem(QO, i2.id, QaDecisionAction.APPROVE);
    expect(t.published('CourseRevisionReviewed')).toEqual([
      expect.objectContaining({ review_item_id: i2.id, revision_id: 'rev-1', content_hash: 'hash-B' }),
    ]);
  });

  it('a still-open stale item decides with its own (old) hash, so the course service can ignore it', async () => {
    const t = setup({ items: [revisionItem({ id: 'I1', content_hash: 'hash-A' })] });
    await t.service.decideItem(QO, 'I1', QaDecisionAction.APPROVE);
    expect(t.published('CourseRevisionReviewed')[0]).toMatchObject({ content_hash: 'hash-A' });
  });

  it('a revision item without a content hash cannot be decided (409), and nothing is published', async () => {
    const t = setup({ items: [revisionItem({ content_hash: null })] });
    await expect(t.service.decideItem(QO, 'i1', QaDecisionAction.APPROVE)).rejects.toThrow(
      'queued without a content fingerprint',
    );
    await expect(t.service.decideItem(QO, 'i1', QaDecisionAction.REJECT, 'nope')).rejects.toThrow(ConflictException);
    expect(t.reviewItems.rows[0].status).toBe(QaReviewStatus.PENDING);
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('an empty content hash on the event is stored as none (not as a matchable empty string)', async () => {
    const t = setup();
    await t.handlers.CourseRevisionSubmitted(revisionPayload({ content_hash: '' }));
    expect(t.reviewItems.rows[0].content_hash).toBeNull();
  });

  it('flag → 400 pointing at the admin tools', async () => {
    const t = setup({ items: [revisionItem()] });
    await expect(t.service.decideItem(QO, 'i1', QaDecisionAction.FLAG, 'bad')).rejects.toThrow(
      'Revisions are approved, returned (coach) or rejected. Use the admin tools to unlist a live course.',
    );
    expect(t.reviewItems.rows[0].status).toBe(QaReviewStatus.PENDING);
  });
});

describe('QualityService.decideItem — course items (new course, appeal, post-publish)', () => {
  it.each(['new_course', 'appeal', 'post_publish'])('%s: flag → FLAGGED and publishes CourseReviewed as before', async (kind) => {
    const t = setup({ items: [{ id: 'i1', course_id: 'c1', kind }] });
    await t.service.decideItem(QO, 'i1', QaDecisionAction.FLAG);
    expect(t.reviewItems.rows[0].status).toBe(QaReviewStatus.FLAGGED);
    expect(t.published('CourseReviewed')).toEqual([
      {
        course_id: 'c1',
        action: 'flag',
        notes: null,
        qo_id: 'qo-1',
        owner_user_id: 'user-1',
        owner_email: 'edu@x.et',
        course_title: 'Live title',
        kind,
      },
    ]);
    expect(t.published('CourseRevisionReviewed')).toHaveLength(0);
  });

  it.each(['new_course', 'appeal', 'post_publish'])(
    '%s: approve and coach announce the item kind, so a re-check is not announced as a first publish',
    async (kind) => {
      const approve = setup({ items: [{ id: 'i1', course_id: 'c1', kind }] });
      await approve.service.decideItem(QO, 'i1', QaDecisionAction.APPROVE);
      expect(approve.published('CourseReviewed')).toEqual([expect.objectContaining({ action: 'approve', kind })]);

      const coach = setup({ items: [{ id: 'i1', course_id: 'c1', kind }] });
      await coach.service.decide(QO, 'c1', QaDecisionAction.COACH, 'Tighten lesson 2');
      expect(coach.published('CourseReviewed')).toEqual([expect.objectContaining({ action: 'coach', kind })]);
    },
  );

  it('reject → 400; coach needs notes; approve → APPROVED', async () => {
    const t = setup({ items: [{ id: 'i1', course_id: 'c1', kind: 'new_course' }] });
    await expect(t.service.decideItem(QO, 'i1', QaDecisionAction.REJECT, 'no')).rejects.toThrow(BadRequestException);
    await expect(t.service.decideItem(QO, 'i1', QaDecisionAction.COACH)).rejects.toThrow(BadRequestException);
    await t.service.decideItem(QO, 'i1', QaDecisionAction.APPROVE);
    expect(t.reviewItems.rows[0].status).toBe(QaReviewStatus.APPROVED);
    expect(t.published('CourseReviewed')[0]).toMatchObject({ action: 'approve' });
  });
});

describe('QualityService.decideItem — locking and state', () => {
  it('409s while another officer holds a fresh claim; allowed once it lapses', async () => {
    const fresh = setup({ items: [{ id: 'i1', course_id: 'c1', status: QaReviewStatus.IN_REVIEW, claimed_by: 'qo-2', claimed_at: minutesAgo(3) }] });
    await expect(fresh.service.decideItem(QO, 'i1', QaDecisionAction.APPROVE)).rejects.toThrow(ConflictException);
    expect(fresh.bus.publish).not.toHaveBeenCalled();

    const lapsed = setup({ items: [{ id: 'i1', course_id: 'c1', status: QaReviewStatus.IN_REVIEW, claimed_by: 'qo-2', claimed_at: minutesAgo(31) }] });
    await lapsed.service.decideItem(QO, 'i1', QaDecisionAction.APPROVE);
    expect(lapsed.reviewItems.rows[0].status).toBe(QaReviewStatus.APPROVED);
  });

  it('the claimant can decide their claimed item', async () => {
    const t = setup({ items: [{ id: 'i1', course_id: 'c1', status: QaReviewStatus.IN_REVIEW, claimed_by: 'qo-1', claimed_at: minutesAgo(3) }] });
    await t.service.decideItem(QO, 'i1', QaDecisionAction.APPROVE);
    expect(t.reviewItems.rows[0].status).toBe(QaReviewStatus.APPROVED);
  });

  it('decides an item once: a second decision (or a concurrent one) gets 409 and publishes nothing', async () => {
    const t = setup({ items: [{ id: 'i1', course_id: 'c1' }] });
    await t.service.decideItem(QO, 'i1', QaDecisionAction.APPROVE);
    await expect(t.service.decideItem(QO2, 'i1', QaDecisionAction.FLAG)).rejects.toThrow(ConflictException);
    expect(t.bus.publish).toHaveBeenCalledTimes(1);

    // Race: the other officer's decision lands between our read and our write.
    const race = setup({ items: [{ id: 'i1', course_id: 'c1' }] });
    race.reviewItems.update.mockImplementationOnce(async () => {
      race.reviewItems.rows[0].status = QaReviewStatus.FLAGGED;
      return { affected: 0 };
    });
    await expect(race.service.decideItem(QO, 'i1', QaDecisionAction.APPROVE)).rejects.toThrow(ConflictException);
    expect(race.bus.publish).not.toHaveBeenCalled();
  });

  it('reopens the item when the decision event cannot be published', async () => {
    const t = setup({ items: [{ id: 'i1', course_id: 'c1', kind: 'revision', revision_id: 'rev-1', content_hash: 'hash-A' }] });
    t.bus.publish.mockRejectedValueOnce(new Error('Channel closed'));
    await expect(t.service.decideItem(QO, 'i1', QaDecisionAction.APPROVE)).rejects.toThrow(ServiceUnavailableException);
    expect(t.reviewItems.rows[0]).toMatchObject({ status: QaReviewStatus.PENDING, qo_id: null, reviewed_at: null });
  });
});

describe('QualityService.decide (back-compat, by course)', () => {
  it('404s when nothing is open', async () => {
    const t = setup({ items: [{ id: 'i1', course_id: 'c1', status: QaReviewStatus.APPROVED }] });
    await expect(t.service.decide(QO, 'c1', QaDecisionAction.APPROVE)).rejects.toThrow(NotFoundException);
  });

  it('409s when more than one item is open for the course', async () => {
    const t = setup({
      items: [
        { id: 'pp', course_id: 'c1', kind: 'post_publish' },
        { id: 'rev', course_id: 'c1', kind: 'revision', revision_id: 'rev-1' },
      ],
    });
    await expect(t.service.decide(QO, 'c1', QaDecisionAction.APPROVE)).rejects.toThrow('Multiple reviews open — decide by item');
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('delegates to the item decision when exactly one is open, with the per-kind rules', async () => {
    const t = setup({
      items: [
        { id: 'rev', course_id: 'c1', kind: 'revision', revision_id: 'rev-1', content_hash: 'hash-A' },
        { id: 'old', course_id: 'c1', status: QaReviewStatus.APPROVED },
      ],
    });
    await expect(t.service.decide(QO, 'c1', QaDecisionAction.FLAG)).rejects.toThrow(BadRequestException);
    await t.service.decide(QO, 'c1', QaDecisionAction.APPROVE);
    expect(t.reviewItems.rows[0].status).toBe(QaReviewStatus.APPROVED);
    expect(t.published('CourseRevisionReviewed')[0]).toMatchObject({ review_item_id: 'rev', revision_id: 'rev-1' });
  });
});
