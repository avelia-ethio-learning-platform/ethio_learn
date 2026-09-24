import { BadRequestException, ForbiddenException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { Course, CourseChangeLog, CourseKnowledge, CourseRevision, Lesson, Section } from './entities';
import { APPLY_FAILED_NOTE, HASH_MISMATCH_NOTE, RevisionService } from './revision.service';

// RevisionService only reaches these through DI (hand-built mocks below);
// stubbing the modules keeps this suite from compiling the AI/storage stack.
jest.mock('./course.service', () => ({ CourseService: class CourseService {} }));
jest.mock('./course-extras.service', () => ({ CourseExtrasService: class CourseExtrasService {} }));

type Row = Record<string, any>;

// Rows are copied in and out like a real DB round trip, so tests cannot pass by
// mutating shared references. (structuredClone yields Dates from another realm
// under jest, which breaks toBeInstanceOf(Date).)
function clone<T>(v: T): T {
  if (v instanceof Date) return new Date(v.getTime()) as T;
  if (Array.isArray(v)) return v.map(clone) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  return v;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected instanceof FindOperator) {
      if (expected.type === 'in') return (expected.value as unknown[]).includes(row[key]);
      throw new Error(`fake repo: unsupported operator ${expected.type}`);
    }
    return (row[key] ?? null) === (expected ?? null);
  });
}

/** Just enough of a TypeORM repository, backed by an array, to exercise the real queries' semantics. */
class FakeRepo {
  rows: Row[] = [];
  private seq = 0;
  constructor(private readonly prefix: string, private readonly onSave?: (row: Row, rows: Row[]) => void) {}

  create = (x: Row) => ({ ...x });
  find = jest.fn(async (opts: { where?: Row } = {}) => this.rows.filter((r) => !opts.where || matches(r, opts.where)).map((r) => clone(r)));
  findOne = jest.fn(async (opts: { where: Row }) => {
    const row = this.rows.find((r) => matches(r, opts.where));
    return row ? clone(row) : null;
  });
  count = jest.fn(async (opts: { where?: Row } = {}) => (await this.find(opts)).length);
  save = jest.fn(async (input: Row) => {
    const row = clone(input);
    if (!row.id) row.id = `${this.prefix}${++this.seq}`;
    this.onSave?.(row, this.rows);
    const i = this.rows.findIndex((r) => r.id === row.id);
    if (i >= 0) this.rows[i] = { ...this.rows[i], ...row };
    else this.rows.push({ created_at: new Date(), ...row });
    return clone(row);
  });
  update = jest.fn(async (where: Row, patch: Row) => {
    let affected = 0;
    for (const r of this.rows) {
      if (matches(r, where)) {
        Object.assign(r, clone(patch));
        affected++;
      }
    }
    return { affected };
  });
  delete = jest.fn(async (where: Row) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, where));
    return { affected: before - this.rows.length };
  });
  get(id: string) {
    return this.rows.find((r) => r.id === id);
  }
}

const OWNER = { id: 'edu1', role: 'educator', email: 'e@x.et' } as never;
const OTHER_EDU = { id: 'edu2', role: 'educator', email: 'o@x.et' } as never;
const QO = { id: 'qo1', role: 'quality_officer', email: 'q@x.et' } as never;
const PUBLISHED_AT = new Date('2026-01-01T00:00:00Z');

function setup(opts: { institution?: boolean; status?: string; pendingAssessments?: unknown[] | Error } = {}) {
  const courses = new FakeRepo('c');
  const sections = new FakeRepo('s');
  const lessons = new FakeRepo('l');
  const knowledge = new FakeRepo('k');
  const changelog = new FakeRepo('log');
  // Mirrors the partial unique index: one open revision per course.
  const revisions = new FakeRepo('rev', (row, rows) => {
    const open = ['draft', 'institution_review', 'submitted'];
    if (open.includes(row.status) && rows.some((r) => r.id !== row.id && r.course_id === row.course_id && open.includes(r.status))) {
      throw new Error('duplicate key value violates unique constraint "uq_course_revisions_open"');
    }
  });
  const repos = new Map<unknown, FakeRepo>([
    [Course, courses],
    [Section, sections],
    [Lesson, lessons],
    [CourseKnowledge, knowledge],
    [CourseChangeLog, changelog],
    [CourseRevision, revisions],
  ]);
  const manager = { getRepository: (entity: unknown) => repos.get(entity)! };
  const dataSource = {
    manager,
    getRepository: manager.getRepository,
    transaction: jest.fn(async (cb: (m: typeof manager) => unknown) => cb(manager)),
  };

  courses.rows.push({
    id: 'c1',
    owner_id: 'edu1',
    owner_type: 'educator',
    created_by: 'edu1',
    institution_id: opts.institution ? 'inst1' : null,
    title: 'Approved title',
    description: 'Approved description that the QO saw',
    category: 'programming',
    thumbnail_url: 'http://x/thumb.png',
    pricing_type: 'paid',
    price_etb: '500.00',
    status: opts.status ?? 'published',
    published_at: PUBLISHED_AT,
    last_major_update_at: null,
    pending: null,
  });
  sections.rows.push({ id: 's1', course_id: 'c1', title: 'Intro', order_index: 0, is_free_preview: true, pending_state: null, pending: null });
  lessons.rows.push(
    { id: 'l1', section_id: 's1', title: 'Welcome', summary: 'old', duration_seconds: 600, video_s3_key: 'videos/edu1/OLD.mp4', order_index: 0, pending_state: null, pending: null },
    { id: 'l2', section_id: 's1', title: 'Setup', summary: null, duration_seconds: 300, video_s3_key: 'videos/edu1/L2.mp4', order_index: 1, pending_state: null, pending: null },
  );
  knowledge.rows.push({ id: 'k-live', course_id: 'c1', source: 'notes', title: 'Glossary', chunk_index: 0, text: 'old glossary', state: 'live' });

  const handlers: Record<string, (p: any) => Promise<void>> = {};
  const bus = {
    publish: jest.fn(async (_type: string, _payload?: unknown): Promise<void> => undefined),
    subscribe: jest.fn((type: string, handler: any) => {
      handlers[type] = handler;
    }),
  };
  // What outcomes currently reports as pending; tests change it mid-flow (e.g. a quiz added after submit).
  let pendingAssessments = opts.pendingAssessments;
  const setAssessments = (v: unknown[] | Error | undefined) => {
    pendingAssessments = v;
  };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.endsWith('/pending-assessments')) {
        if (pendingAssessments instanceof Error) throw pendingAssessments;
        return pendingAssessments ?? [];
      }
      if (path.endsWith('/institution')) return { institution_id: 'inst1', institution_admin_user_id: 'inst-admin-1' };
      return { name: 'Edu', email: 'e@x.et' };
    }),
  };
  const courseService = {
    courseOrThrow: jest.fn(async (id: string) => {
      const c = await courses.findOne({ where: { id } });
      if (!c) throw new NotFoundException('Course not found');
      return c;
    }),
    ownedCourse: jest.fn(async (ctx: any, id: string) => {
      const c = await courses.findOne({ where: { id } });
      if (!c) throw new NotFoundException('Course not found');
      if (c.created_by !== ctx.id && ctx.role !== 'platform_admin') throw new ForbiddenException('Not your course');
      return c;
    }),
    isStaffFor: jest.fn(async (ctx: any, c: any) => c.created_by === ctx.id || ['quality_officer', 'platform_admin'].includes(ctx.role)),
    clearSearchCache: jest.fn(),
    ownerContact: jest.fn(async () => ({ email: 'e@x.et', name: 'Edu' })),
    myInstitutionId: jest.fn(async () => 'inst1'),
    publicSummary: jest.fn((c: any) => ({ id: c.id, title: c.title })),
  };
  const extras = { reindexCourse: jest.fn(async () => ({ chunks: 0 })) };

  const svc = new RevisionService(revisions as never, dataSource as never, courseService as never, extras as never, bus as never, internal as never);
  svc.retryDelaysMs = [0, 0];
  svc.onModuleInit();

  /** What CourseService's staged write paths leave behind for a live course. */
  function stageChanges() {
    const course = courses.get('c1')!;
    course.pending = { title: 'New title', price_etb: '600.00' };
    lessons.get('l1')!.pending = { video_s3_key: 'videos/edu1/NEW.mp4', summary: 'new' };
    lessons.get('l2')!.pending_state = 'removed';
    sections.rows.push({ id: 's2', course_id: 'c1', title: 'Bonus', order_index: 1, is_free_preview: false, pending_state: 'added', pending: null });
    lessons.rows.push({ id: 'l3', section_id: 's2', title: 'Bonus lesson', summary: 'extra', duration_seconds: 120, video_s3_key: 'videos/edu1/L3.mp4', order_index: 0, pending_state: 'added', pending: null });
    lessons.rows.push({ id: 'l4', section_id: 's1', title: 'Added in live section', summary: null, duration_seconds: 0, video_s3_key: null, order_index: 2, pending_state: 'added', pending: null });
    knowledge.rows.push({ id: 'k-new', course_id: 'c1', source: 'notes', title: 'Glossary', chunk_index: 0, text: 'new glossary', state: 'pending' });
    revisions.rows.push({ id: 'rev1', course_id: 'c1', status: 'draft', created_by: 'edu1', changelog_summary: null, changelog_major: false, diff: null, content_hash: null, submitted_at: null, decided_at: null, decided_by: null, decision_notes: null });
  }

  const published = (type: string) => bus.publish.mock.calls.filter((c: any[]) => c[0] === type).map((c: any[]) => c[1]);
  /** A QO decision as quality publishes it: by default on the submission currently frozen on the revision. */
  const decision = (action: 'approve' | 'coach' | 'reject', notes: string | null = null, extra: Row = {}) => ({
    course_id: 'c1',
    revision_id: 'rev1',
    review_item_id: 'qi1',
    action,
    notes,
    qo_id: 'qo1',
    owner_user_id: 'edu1',
    owner_email: 'e@x.et',
    course_title: 'Approved title',
    content_hash: revisions.get('rev1')?.content_hash ?? null,
    ...extra,
  });
  const deliver = (payload: Row) => handlers['CourseRevisionReviewed'](payload);
  const review = (action: 'approve' | 'coach' | 'reject', notes: string | null = null, extra: Row = {}) => deliver(decision(action, notes, extra));

  return {
    svc,
    courses,
    sections,
    lessons,
    knowledge,
    changelog,
    revisions,
    bus,
    internal,
    courseService,
    extras,
    dataSource,
    stageChanges,
    published,
    decision,
    deliver,
    review,
    setAssessments,
  };
}

describe('RevisionService.submit', () => {
  it('rejects an empty change set with 400', async () => {
    const t = setup();
    await expect(t.svc.submit(OWNER, 'c1', {})).rejects.toThrow(new BadRequestException('There are no changes to submit.'));
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('asks to retry instead of claiming "no changes" when pending assessments cannot be checked', async () => {
    const t = setup({ pendingAssessments: new Error('outcomes asleep') });
    await expect(t.svc.submit(OWNER, 'c1', {})).rejects.toThrow(/try again/);
  });

  it('fails closed with 503 when pending assessments cannot be checked, even with other staged changes', async () => {
    // Freezing an empty assessment list would hide new quizzes from the reviewer
    // and the approval would still make them live.
    const t = setup({ pendingAssessments: new Error('outcomes asleep') });
    t.stageChanges();
    await expect(t.svc.submit(OWNER, 'c1', {})).rejects.toThrow(ServiceUnavailableException);
    expect(t.revisions.get('rev1')).toMatchObject({ status: 'draft', content_hash: null, diff: null });
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('freezes the pending assessment ids, binds them into the hash and publishes them', async () => {
    const t = setup({ pendingAssessments: [{ id: 'a1', type: 'quiz' }] });
    t.stageChanges();
    const hashWithout = await (async () => {
      const u = setup();
      u.stageChanges();
      await u.svc.submit(OWNER, 'c1', {});
      return u.revisions.get('rev1')!.content_hash;
    })();
    await t.svc.submit(OWNER, 'c1', {});
    const rev = t.revisions.get('rev1')!;
    expect(rev.diff.pending_assessments).toEqual([{ id: 'a1', type: 'quiz' }]);
    expect(rev.content_hash).not.toBe(hashWithout);
    const [payload] = t.published('CourseRevisionSubmitted');
    expect(payload).toMatchObject({ assessment_ids: ['a1'], content_hash: rev.content_hash });
    expect(payload.diff_summary.assessments_added).toBe(1);
  });

  it('explains how to clear staged values that equal the live course', async () => {
    const t = setup();
    t.courses.get('c1')!.pending = { title: 'Approved title' };
    await expect(t.svc.submit(OWNER, 'c1', {})).rejects.toThrow(/match the live course.*Discard changes/);
    // ...and Discard does clear them.
    await expect(t.svc.discard(OWNER, 'c1')).resolves.toEqual({ discarded: true });
    expect(t.courses.get('c1')!.pending).toBeNull();
  });

  it('submits staged rows left behind by a revision a flag closed (no open revision)', async () => {
    const t = setup();
    t.stageChanges();
    // closeOpenRevision on FLAG: revision withdrawn, staged rows kept; then the course was reinstated.
    Object.assign(t.revisions.get('rev1')!, { id: 'rev-flagged', status: 'withdrawn' });
    await expect(t.svc.submit(OWNER, 'c1', {})).resolves.toEqual({ revision_id: 'rev1', status: 'submitted' });
    expect(t.revisions.get('rev-flagged')!.status).toBe('withdrawn');
    expect(t.revisions.get('rev1')).toMatchObject({ status: 'submitted', content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(t.published('CourseRevisionSubmitted')).toEqual([expect.objectContaining({ revision_id: 'rev1', assessment_ids: [] })]);
  });

  it('validates the merged course with the first-submission rules', async () => {
    const t = setup();
    t.stageChanges();
    t.courses.get('c1')!.pending = { thumbnail_url: null };
    await expect(t.svc.submit(OWNER, 'c1', {})).rejects.toThrow(/thumbnail is required/i);
    t.courses.get('c1')!.pending = { price_etb: null };
    await expect(t.svc.submit(OWNER, 'c1', {})).rejects.toThrow(/Paid courses need a price/);
    expect(t.revisions.get('rev1')!.status).toBe('draft');
  });

  it('is owner-only and only for live courses', async () => {
    const t = setup();
    t.stageChanges();
    await expect(t.svc.submit(OTHER_EDU, 'c1', {})).rejects.toThrow(ForbiddenException);
    t.courses.get('c1')!.status = 'draft';
    await expect(t.svc.submit(OWNER, 'c1', {})).rejects.toThrow(/Only a live course/);
  });

  it('freezes diff + hash and publishes CourseRevisionSubmitted for a solo educator', async () => {
    const t = setup();
    t.stageChanges();
    const res = await t.svc.submit(OWNER, 'c1', { summary: '  Added a bonus section  ', major: true });
    expect(res).toEqual({ revision_id: 'rev1', status: 'submitted' });

    const rev = t.revisions.get('rev1')!;
    expect(rev).toMatchObject({ status: 'submitted', changelog_summary: 'Added a bonus section', changelog_major: true });
    expect(rev.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rev.submitted_at).toBeInstanceOf(Date);
    expect(rev.diff.diff_summary).toMatchObject({ lessons_added: 2, lessons_removed: 1, videos_replaced: 1, price_from: 500, price_to: 600 });

    const [payload] = t.published('CourseRevisionSubmitted');
    expect(payload).toMatchObject({
      course_id: 'c1',
      revision_id: 'rev1',
      course_title: 'Approved title', // live title — the new one is in changed_text
      owner_user_id: 'edu1',
      owner_email: 'e@x.et',
      major: true,
      changelog_summary: 'Added a bonus section',
      // Quality echoes the hash on its decision; only this submission can be applied.
      content_hash: rev.content_hash,
      assessment_ids: [],
    });
    expect(payload.changed_text).toContain('New title');
    expect(payload.changed_text).toContain('Bonus lesson');
    // Live content must stay untouched by a submit.
    expect(t.courses.get('c1')!.title).toBe('Approved title');
    expect(t.published('CourseSubmittedToInstitution')).toHaveLength(0);
  });

  it('sends an institution course to institution review first', async () => {
    const t = setup({ institution: true });
    t.stageChanges();
    const res = await t.svc.submit(OWNER, 'c1', {});
    expect(res.status).toBe('institution_review');
    expect(t.published('CourseSubmittedToInstitution')).toEqual([
      { course_id: 'c1', course_title: 'Approved title', institution_admin_user_id: 'inst-admin-1', instructor_name: 'Edu', revision_id: 'rev1' },
    ]);
    expect(t.published('CourseRevisionSubmitted')).toHaveLength(0);
  });

  it('creates a revision when the only change is a pending assessment', async () => {
    const t = setup({ pendingAssessments: [{ id: 'a1', type: 'quiz' }] });
    const res = await t.svc.submit(OWNER, 'c1', {});
    expect(res.status).toBe('submitted');
    expect(t.revisions.rows).toHaveLength(1);
    expect(t.published('CourseRevisionSubmitted')[0]).toMatchObject({ assessment_ids: ['a1'], diff_summary: { assessments_added: 1 } });
  });

  it('refuses to resubmit while already in review', async () => {
    const t = setup();
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', {});
    await expect(t.svc.submit(OWNER, 'c1', {})).rejects.toThrow(/already in review/);
  });
});

describe('RevisionService apply (CourseRevisionReviewed approve)', () => {
  async function submitted(opts: Parameters<typeof setup>[0] = {}, dto: { summary?: string; major?: boolean } = {}) {
    const t = setup(opts);
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', dto);
    t.bus.publish.mockClear();
    return t;
  }

  it('copies pending onto live, deletes removed rows and never touches status/published_at', async () => {
    const t = await submitted();
    await t.review('approve', 'looks good');

    const course = t.courses.get('c1')!;
    expect(course).toMatchObject({ title: 'New title', price_etb: '600.00', pending: null, status: 'published', published_at: PUBLISHED_AT });
    expect(course.last_review_action).toBe('approve');
    expect(t.lessons.get('l1')).toMatchObject({ video_s3_key: 'videos/edu1/NEW.mp4', summary: 'new', pending: null, pending_state: null });
    expect(t.lessons.get('l2')).toBeUndefined();
    expect(t.lessons.get('l3')).toMatchObject({ pending_state: null });
    expect(t.lessons.get('l4')).toMatchObject({ pending_state: null });
    expect(t.sections.get('s2')).toMatchObject({ pending_state: null });
    // The re-uploaded note replaced the live note of the same title.
    expect(t.knowledge.rows.map((k) => [k.id, k.state])).toEqual([['k-new', 'live']]);

    expect(t.revisions.get('rev1')).toMatchObject({ status: 'applied', decided_by: 'qo1', decision_notes: 'looks good' });
    expect(t.courseService.clearSearchCache).toHaveBeenCalled();
    expect(t.extras.reindexCourse).toHaveBeenCalledWith('c1');

    expect(t.changelog.rows).toHaveLength(1);
    expect(t.changelog.rows[0]).toMatchObject({ kind: 'minor', created_by: 'edu1' });
    expect(t.changelog.rows[0].summary).toMatch(/^Course updated: /);

    const [closed] = t.published('CourseRevisionClosed');
    expect(closed).toMatchObject({
      outcome: 'applied',
      course_id: 'c1',
      revision_id: 'rev1',
      course_title: 'New title',
      removed_lesson_ids: ['l2'],
      replaced_video_lesson_ids: ['l1'],
      notes: 'looks good',
      owner_user_id: 'edu1',
      assessment_ids: [],
      closed_at: t.revisions.get('rev1')!.decided_at.toISOString(),
    });
    expect(closed.added_lesson_ids.sort()).toEqual(['l3', 'l4']);
    expect(closed.submitted_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    const types = t.bus.publish.mock.calls.map((c: any[]) => c[0]);
    expect(types).not.toContain('CoursePublished');
    expect(types).not.toContain('CourseUpdated'); // minor
  });

  it('keeps an UNLISTED course unlisted', async () => {
    const t = await submitted({ status: 'unlisted' });
    await t.review('approve');
    expect(t.courses.get('c1')).toMatchObject({ status: 'unlisted', title: 'New title', published_at: PUBLISHED_AT });
  });

  it('a major revision uses the educator summary, stamps last_major_update_at and notifies learners', async () => {
    const t = await submitted({}, { summary: 'New bonus section', major: true });
    await t.review('approve');
    expect(t.changelog.rows).toEqual([expect.objectContaining({ kind: 'major', summary: 'New bonus section' })]);
    expect(t.courses.get('c1')!.last_major_update_at).toBeInstanceOf(Date);
    expect(t.published('CourseUpdated')).toEqual([
      { course_id: 'c1', course_title: 'New title', owner_user_id: 'edu1', summary: 'New bonus section', changelog_id: t.changelog.rows[0].id },
    ]);
  });

  it('is a no-op on duplicate delivery (conditional status update)', async () => {
    const t = await submitted();
    await t.review('approve');
    await t.review('approve');
    expect(t.changelog.rows).toHaveLength(1);
    expect(t.published('CourseRevisionClosed')).toHaveLength(1);
  });

  it('ignores a stale approve after the educator withdrew', async () => {
    const t = await submitted();
    await t.svc.withdraw(OWNER, 'c1');
    await t.review('approve');
    expect(t.courses.get('c1')!.title).toBe('Approved title');
    expect(t.revisions.get('rev1')!.status).toBe('draft');
    expect(t.published('CourseRevisionClosed')).toHaveLength(0);
  });

  it('returns the revision to draft, applies nothing and tells the educator when the staged content changed after submit', async () => {
    const t = await submitted();
    const approval = t.decision('approve');
    t.lessons.get('l1')!.pending = { video_s3_key: 'videos/edu1/SNEAKY.mp4' };
    await t.deliver(approval);

    expect(t.revisions.get('rev1')).toMatchObject({ status: 'draft', decision_notes: HASH_MISMATCH_NOTE, submitted_at: null });
    expect(t.courses.get('c1')!.title).toBe('Approved title');
    expect(t.lessons.get('l1')!.video_s3_key).toBe('videos/edu1/OLD.mp4');
    expect(t.lessons.get('l2')).toBeDefined();
    expect(t.changelog.rows).toHaveLength(0);
    // Never "applied": the educator hears the update was sent back, not that it is live.
    expect(t.published('CourseRevisionClosed')).toHaveLength(0);
    expect(t.bus.publish).toHaveBeenCalledTimes(1);
    expect(t.published('CourseRevisionReviewed')).toEqual([
      { ...approval, action: 'coach', notes: HASH_MISMATCH_NOTE, review_item_id: 'qi1', qo_id: 'qo1', content_hash: approval.content_hash },
    ]);
  });

  it('ignores its own "returned to educator" coach event (the revision is already draft)', async () => {
    const t = await submitted();
    const approval = t.decision('approve');
    t.lessons.get('l1')!.pending = { video_s3_key: 'videos/edu1/SNEAKY.mp4' };
    await t.deliver(approval);
    const before = { revision: { ...t.revisions.get('rev1')! }, course: { ...t.courses.get('c1')! } };
    const [returned] = t.published('CourseRevisionReviewed');
    t.bus.publish.mockClear();

    await t.deliver(returned);

    expect(t.revisions.get('rev1')).toEqual(before.revision);
    expect(t.courses.get('c1')).toEqual(before.course);
    expect(t.courses.get('c1')!.last_review_action).toBeUndefined();
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('ignores an approval of an earlier submission of the same revision id', async () => {
    const t = await submitted();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const staleApproval = t.decision('approve');
    // Withdraw, swap in a different video, resubmit: same revision id, new content.
    await t.svc.withdraw(OWNER, 'c1');
    t.lessons.get('l1')!.pending = { video_s3_key: 'videos/edu1/UNREVIEWED.mp4', summary: 'new' };
    await t.svc.submit(OWNER, 'c1', {});
    const resubmitted = t.revisions.get('rev1')!;
    expect(resubmitted.content_hash).not.toBe(staleApproval.content_hash);
    t.bus.publish.mockClear();

    await t.deliver(staleApproval);

    expect(t.revisions.get('rev1')).toMatchObject({ status: 'submitted', content_hash: resubmitted.content_hash, decided_by: null });
    expect(t.lessons.get('l1')!.video_s3_key).toBe('videos/edu1/OLD.mp4');
    expect(t.courses.get('c1')!.title).toBe('Approved title');
    expect(t.changelog.rows).toHaveLength(0);
    expect(t.bus.publish).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/approve ignored — the decision is for an earlier submission/));
    warn.mockRestore();

    // The officer's decision on the current submission applies it.
    await t.review('approve');
    expect(t.lessons.get('l1')!.video_s3_key).toBe('videos/edu1/UNREVIEWED.mp4');
  });

  it('ignores a decision that carries no content hash', async () => {
    const t = await submitted();
    await t.review('approve', null, { content_hash: undefined });
    await t.review('reject', null, { content_hash: '' });
    expect(t.revisions.get('rev1')!.status).toBe('submitted');
    expect(t.courses.get('c1')!.title).toBe('Approved title');
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('closes with exactly the assessments frozen at submit — one created later is not part of the approval', async () => {
    const t = await submitted({ pendingAssessments: [{ id: 'a1', type: 'quiz' }] });
    t.setAssessments([{ id: 'a1', type: 'quiz' }, { id: 'a2', type: 'quiz' }]);
    await t.review('approve');
    expect(t.revisions.get('rev1')!.status).toBe('applied');
    expect(t.published('CourseRevisionClosed')).toEqual([expect.objectContaining({ outcome: 'applied', assessment_ids: ['a1'] })]);
    expect(t.changelog.rows[0].summary).toMatch(/1 new assessment/);
  });

  it('still publishes CourseRevisionClosed when the learner announcement cannot be published', async () => {
    const t = await submitted({}, { summary: 'Big update', major: true });
    t.bus.publish.mockImplementation(async (type: string) => {
      if (type === 'CourseUpdated') throw new Error('broker down');
    });
    await t.review('approve');
    expect(t.published('CourseRevisionClosed')).toEqual([expect.objectContaining({ outcome: 'applied' })]);
  });

  it('retries a transient failure locally (the bus acks even when a handler throws)', async () => {
    const t = await submitted();
    const real = t.dataSource.transaction.getMockImplementation()!;
    t.dataSource.transaction.mockImplementationOnce(async () => {
      throw new Error('connection reset');
    });
    t.dataSource.transaction.mockImplementation(real);
    await t.review('approve');
    expect(t.dataSource.transaction).toHaveBeenCalledTimes(2);
    expect(t.revisions.get('rev1')!.status).toBe('applied');
  });

  it('after 3 failed attempts returns the revision to draft and tells the educator to resubmit', async () => {
    const t = await submitted();
    const approval = t.decision('approve', 'ok');
    t.dataSource.transaction.mockImplementation(async () => {
      throw new Error('db down');
    });
    await t.deliver(approval);
    expect(t.dataSource.transaction).toHaveBeenCalledTimes(3);

    // Not left 'submitted' with no open QA item (the editor would stay locked "In review").
    expect(t.revisions.get('rev1')).toMatchObject({ status: 'draft', submitted_at: null, decision_notes: APPLY_FAILED_NOTE, decided_by: 'qo1' });
    expect(t.courses.get('c1')!.title).toBe('Approved title');
    expect(t.published('CourseRevisionClosed')).toHaveLength(0);
    expect(t.published('CourseRevisionReviewed')).toEqual([{ ...approval, action: 'coach', notes: APPLY_FAILED_NOTE }]);

    // Its own coach handler sees a draft and does nothing.
    t.dataSource.transaction.mockImplementation(async (cb: any) => cb({ getRepository: t.dataSource.getRepository }));
    t.bus.publish.mockClear();
    await t.deliver(t.decision('coach', APPLY_FAILED_NOTE, { content_hash: approval.content_hash }));
    expect(t.courses.get('c1')!.last_review_action).toBeUndefined();
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('tells the educator even when the database is still down, and its own coach handler returns the revision later', async () => {
    const t = await submitted();
    const approval = t.decision('approve');
    const real = t.dataSource.transaction.getMockImplementation()!;
    t.dataSource.transaction.mockImplementation(async () => {
      throw new Error('db down');
    });
    t.revisions.update.mockImplementationOnce(async () => {
      throw new Error('db down');
    });
    await t.deliver(approval);
    expect(t.revisions.get('rev1')!.status).toBe('submitted');
    const [returned] = t.published('CourseRevisionReviewed');
    expect(returned).toMatchObject({ action: 'coach', notes: APPLY_FAILED_NOTE, content_hash: approval.content_hash });
    expect(t.published('CourseRevisionClosed')).toHaveLength(0);

    // The database is back when the event comes round.
    t.dataSource.transaction.mockImplementation(real);
    await t.deliver(returned);
    expect(t.revisions.get('rev1')).toMatchObject({ status: 'draft', decision_notes: APPLY_FAILED_NOTE });
    expect(t.courses.get('c1')!.title).toBe('Approved title');
  });

  it('does not return a revision that is no longer awaiting that decision', async () => {
    const t = await submitted();
    const approval = t.decision('approve');
    t.dataSource.transaction.mockImplementation(async () => {
      throw new Error('db down');
    });
    t.revisions.get('rev1')!.status = 'draft'; // withdrawn meanwhile
    await t.deliver(approval);
    expect(t.revisions.get('rev1')!.decision_notes).toBeNull();
    expect(t.bus.publish).not.toHaveBeenCalled();
  });
});

describe('RevisionService coach / reject', () => {
  it('coach returns the revision to draft with notes and keeps the staged data', async () => {
    const t = setup();
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', {});
    t.bus.publish.mockClear();
    await t.review('coach', 'Fix the audio in lesson 1');

    expect(t.revisions.get('rev1')).toMatchObject({ status: 'draft', decision_notes: 'Fix the audio in lesson 1', decided_by: 'qo1', submitted_at: null });
    expect(t.courses.get('c1')).toMatchObject({ pending: { title: 'New title', price_etb: '600.00' }, title: 'Approved title', last_review_action: 'coach', last_review_notes: 'Fix the audio in lesson 1' });
    expect(t.lessons.get('l3')).toMatchObject({ pending_state: 'added' });
    expect(t.lessons.get('l2')).toMatchObject({ pending_state: 'removed' });
    expect(t.bus.publish).not.toHaveBeenCalled();
    // The educator can fix and resubmit.
    await expect(t.svc.submit(OWNER, 'c1', {})).resolves.toMatchObject({ status: 'submitted' });
    expect(t.revisions.get('rev1')!.decision_notes).toBeNull();
  });

  it('reject discards the staged data and publishes CourseRevisionClosed(rejected)', async () => {
    const t = setup();
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', {});
    t.bus.publish.mockClear();
    await t.review('reject', 'Misleading new title');

    expect(t.revisions.get('rev1')).toMatchObject({ status: 'rejected', decision_notes: 'Misleading new title' });
    expect(t.courses.get('c1')).toMatchObject({ title: 'Approved title', pending: null, last_review_action: 'reject' });
    expect(t.sections.get('s2')).toBeUndefined();
    expect(t.lessons.get('l3')).toBeUndefined();
    expect(t.lessons.get('l4')).toBeUndefined();
    expect(t.lessons.get('l1')).toMatchObject({ pending: null, video_s3_key: 'videos/edu1/OLD.mp4' });
    expect(t.lessons.get('l2')).toMatchObject({ pending_state: null });
    expect(t.knowledge.rows.map((k) => k.id)).toEqual(['k-live']);
    expect(t.published('CourseRevisionClosed')).toEqual([
      expect.objectContaining({
        outcome: 'rejected',
        revision_id: 'rev1',
        notes: 'Misleading new title',
        added_lesson_ids: [],
        removed_lesson_ids: [],
        assessment_ids: [],
        closed_at: t.revisions.get('rev1')!.decided_at.toISOString(),
      }),
    ]);
  });

  it('reject closes exactly the assessments frozen at submit', async () => {
    const t = setup({ pendingAssessments: [{ id: 'a1' }] });
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', {});
    t.setAssessments([{ id: 'a1' }, { id: 'a-later' }]);
    await t.review('reject', 'No');
    expect(t.published('CourseRevisionClosed')).toEqual([expect.objectContaining({ outcome: 'rejected', assessment_ids: ['a1'] })]);
  });

  it.each(['coach', 'reject'] as const)('a %s on an earlier submission of the same revision id is ignored', async (action) => {
    const t = setup();
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', {});
    const stale = t.decision(action, 'old notes');
    await t.svc.withdraw(OWNER, 'c1');
    t.courses.get('c1')!.pending = { title: 'Another title' };
    await t.svc.submit(OWNER, 'c1', {});
    t.bus.publish.mockClear();

    await t.deliver(stale);

    expect(t.revisions.get('rev1')).toMatchObject({ status: 'submitted', decision_notes: null });
    // The educator's new staged work is not discarded or sent back.
    expect(t.courses.get('c1')).toMatchObject({ pending: { title: 'Another title' } });
    expect(t.courses.get('c1')!.last_review_action).toBeUndefined();
    expect(t.sections.get('s2')).toBeDefined();
    expect(t.bus.publish).not.toHaveBeenCalled();
  });
});

describe('RevisionService withdraw / discard', () => {
  it('withdraw moves a submitted revision back to draft and publishes CourseReviewWithdrawn', async () => {
    const t = setup();
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', {});
    await expect(t.svc.withdraw(OWNER, 'c1')).resolves.toEqual({ status: 'draft' });
    expect(t.revisions.get('rev1')).toMatchObject({ status: 'draft', submitted_at: null });
    expect(t.published('CourseReviewWithdrawn')).toEqual([{ course_id: 'c1', revision_id: 'rev1' }]);
  });

  it('withdraw without a submitted revision is a 400', async () => {
    const t = setup();
    t.stageChanges();
    await expect(t.svc.withdraw(OWNER, 'c1')).rejects.toThrow(/no submitted update/);
  });

  it('discard deletes added rows, clears every pending marker and closes the revision', async () => {
    const t = setup();
    t.stageChanges();
    await expect(t.svc.discard(OWNER, 'c1')).resolves.toEqual({ discarded: true });

    expect(t.revisions.get('rev1')!.status).toBe('discarded');
    expect(t.sections.rows.map((s) => s.id)).toEqual(['s1']);
    expect(t.lessons.rows.map((l) => l.id)).toEqual(['l1', 'l2']);
    expect(t.lessons.rows.every((l) => l.pending === null && l.pending_state === null)).toBe(true);
    expect(t.courses.get('c1')!.pending).toBeNull();
    expect(t.knowledge.rows.map((k) => k.id)).toEqual(['k-live']);
    expect(t.published('CourseRevisionClosed')).toEqual([
      expect.objectContaining({
        outcome: 'discarded',
        submitted_at: null,
        added_lesson_ids: [],
        removed_lesson_ids: [],
        replaced_video_lesson_ids: [],
        // Outcomes deletes the pending assessments created up to closed_at.
        assessment_ids: [],
        closed_at: t.revisions.get('rev1')!.decided_at.toISOString(),
      }),
    ]);
  });

  it('discards staged rows left behind by a revision a flag closed (no open revision)', async () => {
    const t = setup();
    t.stageChanges();
    Object.assign(t.revisions.get('rev1')!, { id: 'rev-flagged', status: 'withdrawn' });

    await expect(t.svc.discard(OWNER, 'c1')).resolves.toEqual({ discarded: true });

    expect(t.revisions.get('rev-flagged')!.status).toBe('withdrawn');
    expect(t.revisions.get('rev1')!.status).toBe('discarded');
    expect(t.courses.get('c1')!.pending).toBeNull();
    expect(t.sections.rows.map((s) => s.id)).toEqual(['s1']);
    expect(t.lessons.rows.every((l) => l.pending === null && l.pending_state === null)).toBe(true);
    expect(t.knowledge.rows.map((k) => k.id)).toEqual(['k-live']);
    expect(t.published('CourseRevisionClosed')).toEqual([expect.objectContaining({ outcome: 'discarded', revision_id: 'rev1', assessment_ids: [] })]);
    // Staged rows were enough; outcomes was not needed.
    expect(t.internal.get).not.toHaveBeenCalledWith(expect.stringContaining('pending-assessments'));
  });

  it('discards pending assessments when nothing else is staged', async () => {
    const t = setup({ pendingAssessments: [{ id: 'a1' }] });
    await expect(t.svc.discard(OWNER, 'c1')).resolves.toEqual({ discarded: true });
    expect(t.published('CourseRevisionClosed')).toEqual([expect.objectContaining({ outcome: 'discarded', assessment_ids: [] })]);
  });

  it('404s when nothing is staged anywhere, and asks to retry when outcomes cannot be asked', async () => {
    await expect(setup().svc.discard(OWNER, 'c1')).rejects.toThrow(new NotFoundException('There are no staged changes to discard.'));
    await expect(setup({ pendingAssessments: new Error('asleep') }).svc.discard(OWNER, 'c1')).rejects.toThrow(ServiceUnavailableException);
  });

  it('never throws away leftover staged rows of a draft course (they are folded into the draft)', async () => {
    const t = setup({ status: 'draft' });
    t.stageChanges();
    t.revisions.rows = [];
    await expect(t.svc.discard(OWNER, 'c1')).rejects.toThrow(/Only a live course/);
    expect(t.sections.get('s2')).toBeDefined();
    expect(t.courses.get('c1')!.pending).toEqual({ title: 'New title', price_etb: '600.00' });
    expect(t.revisions.rows).toHaveLength(0);
  });

  it('discard is refused while the changes are in review', async () => {
    const t = setup();
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', {});
    await expect(t.svc.discard(OWNER, 'c1')).rejects.toThrow(/Withdraw them before discarding/);
  });
});

describe('RevisionService.currentDiff', () => {
  it('shows the owner the open revision against live', async () => {
    const t = setup();
    t.stageChanges();
    const diff = await t.svc.currentDiff(OWNER, 'c1');
    expect(diff.revision).toMatchObject({ id: 'rev1', status: 'draft', major: false });
    expect(diff.course).toEqual({ id: 'c1', title: 'Approved title', status: 'published', thumbnail_url: 'http://x/thumb.png' });
    expect(diff.metadata).toEqual([
      { field: 'title', before: 'Approved title', after: 'New title' },
      { field: 'price_etb', before: 500, after: 600 },
    ]);
    expect(diff.empty).toBe(false);
  });

  it('a QO only sees a submitted revision; outsiders are refused', async () => {
    const t = setup();
    t.stageChanges();
    await expect(t.svc.currentDiff(QO, 'c1')).rejects.toThrow(NotFoundException);
    await t.svc.submit(OWNER, 'c1', {});
    await expect(t.svc.currentDiff(QO, 'c1')).resolves.toMatchObject({ revision: { status: 'submitted' } });
    await expect(t.svc.currentDiff(OTHER_EDU, 'c1')).rejects.toThrow(ForbiddenException);
  });

  it('404s when there is no open revision', async () => {
    const t = setup();
    await expect(t.svc.currentDiff(OWNER, 'c1')).rejects.toThrow(NotFoundException);
  });

  it('fails closed with 503 when the new assessments cannot be loaded', async () => {
    const t = setup({ pendingAssessments: new Error('outcomes asleep') });
    t.stageChanges();
    await expect(t.svc.currentDiff(OWNER, 'c1')).rejects.toThrow(
      new ServiceUnavailableException('Could not load the new assessments — try again in a minute.'),
    );
  });

  it('a reviewer sees only the assessments frozen at submit (approve/reject act on exactly those)', async () => {
    const t = setup({ pendingAssessments: [{ id: 'a1', type: 'quiz' }] });
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', {});
    t.setAssessments([{ id: 'a1', type: 'quiz' }, { id: 'a-later', type: 'quiz' }]);
    const diff = await t.svc.currentDiff(QO, 'c1');
    expect(diff.pending_assessments).toEqual([{ id: 'a1', type: 'quiz' }]);
    expect(diff.diff_summary.assessments_added).toBe(1);
    // While still a draft the educator sees everything pending.
    await t.svc.withdraw(OWNER, 'c1');
    expect((await t.svc.currentDiff(OWNER, 'c1')).pending_assessments).toHaveLength(2);
  });

  it('a submitted revision with frozen assessments fails closed when outcomes is down', async () => {
    const t = setup({ pendingAssessments: [{ id: 'a1' }] });
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', {});
    t.setAssessments(new Error('outcomes asleep'));
    await expect(t.svc.currentDiff(QO, 'c1')).rejects.toThrow(ServiceUnavailableException);
  });

  it('a submitted revision without assessments does not need outcomes', async () => {
    const t = setup();
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', {});
    t.setAssessments(new Error('outcomes asleep'));
    t.internal.get.mockClear();
    await expect(t.svc.currentDiff(QO, 'c1')).resolves.toMatchObject({ pending_assessments: [], revision: { status: 'submitted' } });
    expect(t.internal.get).not.toHaveBeenCalled();
  });
});

describe('RevisionService institution review', () => {
  const ADMIN = { id: 'inst-admin-1', role: 'institution_admin', email: 'a@x.et' } as never;

  it('approve forwards the frozen diff to the QO queue', async () => {
    const t = setup({ institution: true });
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', { summary: 'Bonus' });
    expect(await t.svc.hasOpenInstitutionRevision('c1')).toBe(true);
    t.bus.publish.mockClear();

    await expect(t.svc.institutionDecideRevision(ADMIN, 'c1', 'approve')).resolves.toEqual({ revision_id: 'rev1', status: 'submitted' });
    expect(t.published('CourseRevisionSubmitted')[0]).toMatchObject({
      revision_id: 'rev1',
      changelog_summary: 'Bonus',
      diff_summary: { lessons_added: 2 },
      content_hash: t.revisions.get('rev1')!.content_hash,
      assessment_ids: [],
    });
    expect(t.published('CourseInstitutionReviewed')).toEqual([
      { course_id: 'c1', course_title: 'Approved title', owner_user_id: 'edu1', action: 'approve', notes: null, revision_id: 'rev1' },
    ]);
    expect(await t.svc.hasOpenInstitutionRevision('c1')).toBe(false);
  });

  it('reject sends it back to the instructor as a draft with notes', async () => {
    const t = setup({ institution: true });
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', {});
    await t.svc.institutionDecideRevision(ADMIN, 'c1', 'reject', 'Use the new logo');
    expect(t.revisions.get('rev1')).toMatchObject({ status: 'draft', decision_notes: 'Use the new logo', decided_by: 'inst-admin-1' });
    expect(t.courses.get('c1')).toMatchObject({ last_review_action: 'institution_reject', title: 'Approved title' });
    expect(t.published('CourseInstitutionReviewed')[0]).toMatchObject({ action: 'reject', revision_id: 'rev1' });
  });

  it('another institution cannot decide it', async () => {
    const t = setup({ institution: true });
    t.stageChanges();
    await t.svc.submit(OWNER, 'c1', {});
    t.courseService.myInstitutionId.mockResolvedValueOnce('inst-other');
    await expect(t.svc.institutionDecideRevision(ADMIN, 'c1', 'approve')).rejects.toThrow(NotFoundException);
  });
});
