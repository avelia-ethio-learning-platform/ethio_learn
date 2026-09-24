import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { ROLES_KEY, UserContext } from '@ethiopialearn/common';
import { MockAiAssessor } from '@ethiopialearn/ai';
import { PricingType, Role } from '@ethiopialearn/contracts';
import { CourseService } from './course.service';
import { CourseController } from './course.controller';
import { CourseInternalController } from './internal.controller';
import { Course, CourseKnowledge, CourseRevision, Lesson, Section } from './entities';

type Row = Record<string, any>;

const OWNER = { id: 'edu1', role: 'educator', email: 'e@x.et' } as UserContext;
const OTHER_EDU = { id: 'edu2', role: 'educator', email: 'o@x.et' } as UserContext;
const LEARNER = { id: 'lrn1', role: 'learner', email: 'l@x.et' } as UserContext;
const QO = { id: 'qo1', role: 'quality_officer', email: 'q@x.et' } as UserContext;
const ADMIN = { id: 'adm1', role: 'platform_admin', email: 'a@x.et' } as UserContext;
const INST_ADMIN = { id: 'ia1', role: 'institution_admin', email: 'i@x.et' } as UserContext;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (want instanceof FindOperator) {
      if (want.type === 'in') return (want.value as unknown[]).includes(row[key]);
      throw new Error(`memRepo: unsupported operator ${want.type}`);
    }
    return (row[key] ?? null) === (want ?? null);
  });
}

/** In-memory stand-in for the TypeORM repository calls CourseService makes. */
function memRepo(rows: Row[], idPrefix: string) {
  let seq = 0;
  const find = (opts: { where?: Row; order?: Row } = {}) => {
    const out = rows.filter((r) => matches(r, opts.where));
    const orderKey = opts.order && Object.keys(opts.order)[0];
    return orderKey ? [...out].sort((a, b) => a[orderKey] - b[orderKey]) : out;
  };
  const persist = (x: Row) => {
    if (!x.id) x.id = `${idPrefix}${++seq}`;
    const i = rows.findIndex((r) => r.id === x.id);
    if (i === -1) rows.push(x);
    else rows[i] = x;
    return x;
  };
  return {
    rows,
    create: jest.fn((x: Row) => ({ ...x })),
    find: jest.fn(async (opts?: { where?: Row; order?: Row }) => find(opts)),
    findOne: jest.fn(async (opts?: { where?: Row }) => find(opts)[0] ?? null),
    count: jest.fn(async (opts?: { where?: Row }) => find(opts).length),
    save: jest.fn(async (x: Row | Row[]) => (Array.isArray(x) ? x.map(persist) : persist(x))),
    remove: jest.fn(async (x: Row) => {
      const i = rows.findIndex((r) => r.id === x.id);
      if (i !== -1) rows.splice(i, 1);
      return x;
    }),
    delete: jest.fn(async (where: Row) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) rows.splice(i, 1);
      return { affected: before - rows.length };
    }),
    update: jest.fn(async (where: Row, patch: Row) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, patch));
      return { affected: hit.length };
    }),
    increment: jest.fn(),
  };
}

const liveSection = (over: Row = {}): Row => ({
  id: 's1', course_id: 'c1', title: 'Live section', order_index: 0, is_free_preview: false, pending_state: null, pending: null, ...over,
});
const liveLesson = (over: Row = {}): Row => ({
  id: 'l1', section_id: 's1', title: 'Live lesson', summary: 'live summary', video_s3_key: 'videos/edu1/live.mp4',
  duration_seconds: 600, order_index: 0, pending_state: null, pending: null, ...over,
});

interface Fixture {
  course?: Row;
  sections?: Row[];
  lessons?: Row[];
  revisions?: Row[];
  knowledge?: Row[];
  entitlement?: string;
  pendingAssessments?: unknown[];
}

function setup(fx: Fixture = {}) {
  const course: Row = {
    id: 'c1', owner_id: 'edu1', owner_type: 'educator', created_by: 'edu1', institution_id: null,
    title: 'Live title', description: 'Approved description the QO saw', category: 'programming', language: 'en',
    thumbnail_url: 'http://x/live.png', pricing_type: 'paid', price_etb: '500.00',
    status: 'published', published_at: new Date('2026-01-01T00:00:00Z'),
    rating_avg: null, rating_count: 0, rating_points: 0, enrolled_count: 0,
    last_review_action: null, last_review_notes: null, last_reviewed_at: null, last_major_update_at: null,
    pending: null,
    ...fx.course,
  };
  const courses = memRepo([course], 'c-new');
  const sections = memRepo(fx.sections ?? [liveSection()], 's-new');
  const lessons = memRepo(fx.lessons ?? [liveLesson()], 'l-new');
  const revisions = memRepo(fx.revisions ?? [], 'rev');
  const knowledge = memRepo(fx.knowledge ?? [], 'k-new');

  // Transactions snapshot every table and restore it on failure, like Postgres would.
  const byEntity = new Map<unknown, ReturnType<typeof memRepo>>([
    [Course, courses],
    [Section, sections],
    [Lesson, lessons],
    [CourseRevision, revisions],
    [CourseKnowledge, knowledge],
  ]);
  const manager = { getRepository: (entity: unknown) => byEntity.get(entity) };
  const dataSource = {
    manager,
    transaction: jest.fn(async (fn: (m: typeof manager) => Promise<unknown>) => {
      const snapshot = [...byEntity.values()].map((repo) => repo.rows.map((r) => ({ ...r })));
      try {
        return await fn(manager);
      } catch (err) {
        [...byEntity.values()].forEach((repo, i) => repo.rows.splice(0, repo.rows.length, ...snapshot[i]));
        throw err;
      }
    }),
  };

  const handlers: Record<string, (payload: any) => Promise<void>> = {};
  const bus = {
    publish: jest.fn(async () => undefined),
    subscribe: jest.fn((type: string, handler: (payload: any) => Promise<void>) => {
      handlers[type] = handler;
    }),
  };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.includes('/entitlements')) return { entitlement_status: fx.entitlement ?? 'none' };
      if (path.includes('/institutions/by-owner/')) return { id: 'inst1' };
      if (path.endsWith('/pending-assessments')) return fx.pendingAssessments ?? [];
      return { name: 'Edu', email: 'e@x.et' };
    }),
  };
  const extras = {
    reindexCourse: jest.fn(async () => ({ chunks: 0 })),
    pendingKnowledge: jest.fn(async () => [] as Array<{ title: string; chars: number; excerpt: string }>),
    addKnowledge: jest.fn(async (_course: unknown, title: string, _text: string, state: string) => ({ title, chunks: 1, state })),
    deleteKnowledge: jest.fn(async () => ({ deleted: 1, state: 'live' })),
  };
  const videoKeys = { assertOwnVideoKey: jest.fn(async () => undefined) };
  const service = new CourseService(
    courses as never,
    sections as never,
    lessons as never,
    bus as never,
    internal as never,
    extras as never,
    revisions as never,
    videoKeys as never,
    dataSource as never,
  );
  service.onModuleInit();

  const revisionService = {
    institutionQueueRows: jest.fn(async () => [{ id: 'c9', kind: 'revision', revision_id: 'rev9' }]),
    hasOpenInstitutionRevision: jest.fn(async () => false),
    institutionDecideRevision: jest.fn(async () => ({ status: 'submitted' })),
  };
  const storage = { getSignedStreamUrl: jest.fn(async (key: string) => ({ url: `https://signed/${key}`, expires_in: 900 })) };
  const controller = new CourseController(service, revisionService as never, extras as never, storage as never, internal as never);

  return { service, controller, course, courses, sections, lessons, revisions, knowledge, bus, handlers, internal, extras, videoKeys, dataSource, revisionService, storage };
}

const published = (h: ReturnType<typeof setup>) => h.bus.publish.mock.calls.map((c: unknown[]) => c[0]);

// ---------------------------------------------------------------------------

describe('CourseService.assertEditable', () => {
  it('edits a draft in place without opening a revision', async () => {
    const h = setup({ course: { status: 'draft' } });
    const res = await h.service.assertEditable(OWNER, 'c1');
    expect(res).toMatchObject({ mode: 'direct', revision: null });
    expect(h.revisions.rows).toHaveLength(0);
  });

  it.each(['submitted', 'under_review', 'institution_review'])('locks a course in review (%s) with 409', async (status) => {
    const h = setup({ course: { status } });
    await expect(h.service.assertEditable(OWNER, 'c1')).rejects.toThrow(new ConflictException('This course is in review. Withdraw it to make changes.'));
  });

  it.each(['published', 'unlisted'])('stages edits on an approved (%s) course under ONE draft revision', async (status) => {
    const h = setup({ course: { status } });
    const first = await h.service.assertEditable(OWNER, 'c1');
    const second = await h.service.assertEditable(OWNER, 'c1');
    expect(first.mode).toBe('staged');
    expect(first.revision).toMatchObject({ course_id: 'c1', status: 'draft', created_by: 'edu1' });
    expect(second.revision!.id).toBe(first.revision!.id);
    expect(h.revisions.rows).toHaveLength(1);
  });

  it.each(['submitted', 'institution_review'])('refuses edits while the open revision is %s', async (status) => {
    const h = setup({ revisions: [{ id: 'rev1', course_id: 'c1', status, created_by: 'edu1' }] });
    await expect(h.service.assertEditable(OWNER, 'c1')).rejects.toThrow(
      new ConflictException('Your changes are in review — withdraw them to keep editing.'),
    );
  });

  it('ignores closed revisions and opens a new draft', async () => {
    const h = setup({ revisions: [{ id: 'old', course_id: 'c1', status: 'applied', created_by: 'edu1' }] });
    const res = await h.service.assertEditable(OWNER, 'c1');
    expect(res.revision!.id).not.toBe('old');
    expect(h.revisions.rows.filter((r) => r.status === 'draft')).toHaveLength(1);
  });

  it.each(['archived', 'flagged'])('rejects edits on a %s course with 400', async (status) => {
    const h = setup({ course: { status } });
    await expect(h.service.assertEditable(OWNER, 'c1')).rejects.toThrow(BadRequestException);
  });

  it('keeps the ownership rule and gives platform admins no staging bypass', async () => {
    const h = setup();
    await expect(h.service.assertEditable(OTHER_EDU, 'c1')).rejects.toThrow(ForbiddenException);
    await expect(h.service.assertEditable(ADMIN, 'c1')).resolves.toMatchObject({ mode: 'staged' });
  });
});

describe('CourseService staged writes on a live course', () => {
  it('update() merges into course.pending, leaves live columns alone, and drops fields set back to live', async () => {
    const h = setup();
    const res = await h.service.update(OWNER, 'c1', { title: 'New title', price_etb: 600 });
    expect(h.course).toMatchObject({ title: 'Live title', price_etb: '500.00', status: 'published' });
    expect(h.course.pending).toEqual({ title: 'New title', price_etb: '600.00' });
    expect(res).toMatchObject({ title: 'New title', price_etb: 600, has_pending_changes: true, revision: { status: 'draft' } });
    expect(res.pending_fields.sort()).toEqual(['price_etb', 'title']);

    await h.service.update(OWNER, 'c1', { title: 'Live title' });
    expect(h.course.pending).toEqual({ price_etb: '600.00' });
    await h.service.update(OWNER, 'c1', { price_etb: 500 });
    expect(h.course.pending).toBeNull();
  });

  it('update() validates the merged pricing: a paid course needs a price', async () => {
    const h = setup({ course: { pricing_type: 'free', price_etb: null } });
    await expect(h.service.update(OWNER, 'c1', { pricing_type: PricingType.PAID })).rejects.toThrow(BadRequestException);
    expect(h.course.pending).toBeNull();

    await h.service.update(OWNER, 'c1', { pricing_type: PricingType.PAID, price_etb: 300 });
    expect(h.course.pending).toEqual({ pricing_type: 'paid', price_etb: '300.00' });
    expect(h.course).toMatchObject({ pricing_type: 'free', price_etb: null });
  });

  it('update() on a draft writes the live columns', async () => {
    const h = setup({ course: { status: 'draft' } });
    await h.service.update(OWNER, 'c1', { title: 'Renamed draft' });
    expect(h.course).toMatchObject({ title: 'Renamed draft', pending: null });
  });

  it('addLesson() stages an added lesson, keeps its summary and validates the video key', async () => {
    const h = setup();
    const lesson = await h.service.addLesson(OWNER, 's1', { title: 'New lesson', summary: 'What you will learn', video_s3_key: 'videos/edu1/new.mp4' });
    expect(lesson).toMatchObject({ pending_state: 'added', summary: 'What you will learn', order_index: 1, section_id: 's1' });
    expect(h.videoKeys.assertOwnVideoKey).toHaveBeenCalledWith(h.course, 'videos/edu1/new.mp4', []);
    // No change-log entry or learner notification at edit time.
    expect(h.bus.publish).not.toHaveBeenCalled();
  });

  it('addLesson() on a draft is live immediately and also keeps the summary', async () => {
    const h = setup({ course: { status: 'draft' } });
    const lesson = await h.service.addLesson(OWNER, 's1', { title: 'Draft lesson', summary: 'One line' });
    expect(lesson).toMatchObject({ pending_state: null, summary: 'One line' });
  });

  it('addLesson() refuses a section staged for removal', async () => {
    const h = setup({ sections: [liveSection({ pending_state: 'removed' })] });
    await expect(h.service.addLesson(OWNER, 's1', { title: 'Orphan' })).rejects.toThrow(BadRequestException);
  });

  it('addLesson() writes nothing when the video key is rejected', async () => {
    const h = setup();
    h.videoKeys.assertOwnVideoKey.mockRejectedValueOnce(new BadRequestException("That video was not uploaded by this course's instructor."));
    await expect(h.service.addLesson(OWNER, 's1', { title: 'Sneaky', video_s3_key: 'certificates/x.pdf' })).rejects.toThrow(BadRequestException);
    expect(h.lessons.rows).toHaveLength(1);
  });

  it('updateLesson() stages a live lesson in lesson.pending and validates against its current keys', async () => {
    const h = setup({ lessons: [liveLesson({ pending: { video_s3_key: 'videos/edu1/staged.mp4' } })] });
    await h.service.updateLesson(OWNER, 'l1', { title: 'Renamed', summary: 'New summary', video_s3_key: 'videos/edu1/newer.mp4' });
    const row = h.lessons.rows[0];
    expect(row).toMatchObject({ title: 'Live lesson', summary: 'live summary', video_s3_key: 'videos/edu1/live.mp4' });
    expect(row.pending).toEqual({ title: 'Renamed', summary: 'New summary', video_s3_key: 'videos/edu1/newer.mp4' });
    expect(h.videoKeys.assertOwnVideoKey).toHaveBeenCalledWith(h.course, 'videos/edu1/newer.mp4', ['videos/edu1/live.mp4', 'videos/edu1/staged.mp4']);

    await h.service.updateLesson(OWNER, 'l1', { title: 'Live lesson', video_s3_key: 'videos/edu1/live.mp4' });
    expect(row.pending).toEqual({ summary: 'New summary' });
  });

  it('updateLesson() edits a lesson added in this revision in place', async () => {
    const h = setup({ lessons: [liveLesson({ id: 'l2', pending_state: 'added' })] });
    await h.service.updateLesson(OWNER, 'l2', { title: 'Still new', summary: 'fresh' });
    expect(h.lessons.rows[0]).toMatchObject({ title: 'Still new', summary: 'fresh', pending: null, pending_state: 'added' });
  });

  it('updateLesson() persists the summary on a draft', async () => {
    const h = setup({ course: { status: 'draft' } });
    await h.service.updateLesson(OWNER, 'l1', { summary: 'edited summary' });
    expect(h.lessons.rows[0]).toMatchObject({ summary: 'edited summary', pending: null });
  });

  it('updateSection() stages a free-preview flip on a live section', async () => {
    const h = setup();
    await h.service.updateSection(OWNER, 's1', { is_free_preview: true });
    expect(h.sections.rows[0]).toMatchObject({ is_free_preview: false, pending: { is_free_preview: true } });
  });

  it('deleteLesson() marks a live lesson removed but hard-deletes an added one', async () => {
    const h = setup({ lessons: [liveLesson(), liveLesson({ id: 'l2', order_index: 1, pending_state: 'added' })] });
    await expect(h.service.deleteLesson(OWNER, 'l1')).resolves.toEqual({ deleted: true, staged: true });
    await expect(h.service.deleteLesson(OWNER, 'l2')).resolves.toEqual({ deleted: true, staged: false });
    expect(h.lessons.rows).toEqual([expect.objectContaining({ id: 'l1', pending_state: 'removed' })]);
  });

  it('deleteSection() on a live section marks it and its live lessons removed and drops lessons added to it', async () => {
    const h = setup({ lessons: [liveLesson(), liveLesson({ id: 'l2', order_index: 1, pending_state: 'added' })] });
    await h.service.deleteSection(OWNER, 's1');
    expect(h.sections.rows[0].pending_state).toBe('removed');
    expect(h.lessons.rows).toEqual([expect.objectContaining({ id: 'l1', pending_state: 'removed' })]);
  });

  it('deleteSection() hard-deletes a section added in this revision, with its lessons', async () => {
    const h = setup({
      sections: [liveSection(), liveSection({ id: 's2', order_index: 1, pending_state: 'added' })],
      lessons: [liveLesson(), liveLesson({ id: 'l2', section_id: 's2', pending_state: 'added' })],
    });
    await h.service.deleteSection(OWNER, 's2');
    expect(h.sections.rows.map((s) => s.id)).toEqual(['s1']);
    expect(h.lessons.rows.map((l) => l.id)).toEqual(['l1']);
  });

  it('deleteSection() on a draft deletes directly', async () => {
    const h = setup({ course: { status: 'draft' } });
    await h.service.deleteSection(OWNER, 's1');
    expect(h.sections.rows).toHaveLength(0);
    expect(h.lessons.rows).toHaveLength(0);
  });
});

describe('CourseService.applyStructure', () => {
  const outline = [
    { title: 'Intro', is_free_preview: true, lessons: [{ title: 'Welcome', summary: 'What the course covers' }] },
    { title: 'Basics', is_free_preview: false, lessons: [{ title: 'Variables', summary: 'Storing values' }, { title: 'Loops', summary: 'Repeating work' }] },
  ];

  it('stages the whole outline on a live course with summaries and reports the counts', async () => {
    const h = setup();
    const res = await h.service.applyStructure(OWNER, 'c1', outline);
    expect(res).toEqual({ applied: true, sections_added: 2, lessons_added: 3 });
    expect(h.dataSource.transaction).toHaveBeenCalledTimes(1);
    const added = h.sections.rows.filter((s) => s.pending_state === 'added');
    expect(added.map((s) => [s.title, s.order_index])).toEqual([['Intro', 1], ['Basics', 2]]);
    const newLessons = h.lessons.rows.filter((l) => l.id !== 'l1');
    expect(newLessons.map((l) => [l.title, l.summary, l.pending_state])).toEqual([
      ['Welcome', 'What the course covers', 'added'],
      ['Variables', 'Storing values', 'added'],
      ['Loops', 'Repeating work', 'added'],
    ]);
  });

  it('is all-or-nothing: a failure on a later section leaves no partial outline', async () => {
    const h = setup({ course: { status: 'draft' } });
    let saves = 0;
    const realSave = h.lessons.save.getMockImplementation()!;
    h.lessons.save.mockImplementation(async (x: Row | Row[]) => {
      if (++saves === 2) throw new Error('connection reset');
      return realSave(x);
    });
    await expect(h.service.applyStructure(OWNER, 'c1', outline)).rejects.toThrow('connection reset');
    expect(h.sections.rows.map((s) => s.id)).toEqual(['s1']);
    expect(h.lessons.rows.map((l) => l.id)).toEqual(['l1']);
  });

  it('checks every video key before writing anything', async () => {
    const h = setup();
    h.videoKeys.assertOwnVideoKey.mockRejectedValueOnce(new BadRequestException('Upload the video before attaching it'));
    const withVideo = [{ title: 'Video section', is_free_preview: false, lessons: [{ title: 'Clip', video_s3_key: 'videos/edu1/missing.mp4' }] }];
    await expect(h.service.applyStructure(OWNER, 'c1', withVideo)).rejects.toThrow(BadRequestException);
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects an empty outline', async () => {
    const h = setup({ course: { status: 'draft' } });
    await expect(h.service.applyStructure(OWNER, 'c1', [])).rejects.toThrow(BadRequestException);
  });
});

describe('CourseService learner reads are live-only', () => {
  const tree = {
    course: { pending: { title: 'Staged title' } },
    sections: [liveSection(), liveSection({ id: 's2', order_index: 1, pending_state: 'added', is_free_preview: true })],
    lessons: [
      liveLesson({ pending: { title: 'Staged lesson title' } }),
      liveLesson({ id: 'l2', order_index: 1, pending_state: 'added' }),
      liveLesson({ id: 'l3', order_index: 2, pending_state: 'removed' }),
      liveLesson({ id: 'l4', section_id: 's2', pending_state: 'added' }),
    ],
  };

  it.each([
    ['a learner', LEARNER],
    ['the owner', OWNER],
  ])('publicDetail shows %s the live version only', async (_who, ctx) => {
    const h = setup(tree);
    const detail = await h.service.publicDetail('c1', ctx);
    expect(detail.title).toBe('Live title');
    expect(detail.sections.map((s) => s.id)).toEqual(['s1']);
    expect(detail.sections[0].lessons.map((l) => [l.id, l.title])).toEqual([
      ['l1', 'Live lesson'],
      ['l3', 'Live lesson'],
    ]);
  });

  it('outlineForCourse excludes added rows and keeps rows staged for removal', async () => {
    const h = setup(tree);
    await expect(h.service.outlineForCourse('c1')).resolves.toEqual(['Live section — Live lesson', 'Live section — Live lesson']);
  });

  it('internal lessons/:id reports whether the lesson is live', async () => {
    const h = setup(tree);
    const internal = new CourseInternalController(h.service);
    await expect(internal.lesson('l1')).resolves.toMatchObject({ id: 'l1', course_id: 'c1', live: true });
    await expect(internal.lesson('l2')).resolves.toMatchObject({ live: false });
    await expect(internal.lesson('l4')).resolves.toMatchObject({ live: false });
  });

  it('internal courses/:id exposes institution_id and created_by for authorization', async () => {
    const h = setup({ course: { institution_id: 'inst1' } });
    const internal = new CourseInternalController(h.service);
    await expect(internal.course('c1')).resolves.toMatchObject({ institution_id: 'inst1', created_by: 'edu1', status: 'published' });
  });
});

describe('CourseService.working (educator working copy)', () => {
  it('merges staged values and marks every change', async () => {
    const h = setup({
      course: { pending: { title: 'Staged title' } },
      sections: [liveSection({ pending: { is_free_preview: true } }), liveSection({ id: 's2', order_index: 1, pending_state: 'added' })],
      lessons: [
        liveLesson({ pending: { video_s3_key: 'videos/edu1/new.mp4' } }),
        liveLesson({ id: 'l2', order_index: 1, pending_state: 'removed' }),
        liveLesson({ id: 'l3', section_id: 's2', video_s3_key: null, pending_state: 'added' }),
      ],
      revisions: [{ id: 'rev1', course_id: 'c1', status: 'draft', created_by: 'edu1', changelog_summary: null, changelog_major: false, submitted_at: null, decision_notes: 'Fix the audio' }],
      pendingAssessments: [{ id: 'a1' }, { id: 'a2' }],
    });
    h.extras.pendingKnowledge.mockResolvedValueOnce([{ title: 'Notes', chars: 1200, excerpt: 'x' }]);

    const w = await h.service.working(OWNER, 'c1');
    expect(w).toMatchObject({
      title: 'Staged title',
      status: 'published',
      pending_fields: ['title'],
      has_pending_changes: true,
      pending_assessments_count: 2,
      pending_knowledge_count: 1,
      revision: { id: 'rev1', status: 'draft', major: false, decision_notes: 'Fix the audio' },
    });
    expect(w.sections[0]).toMatchObject({ is_free_preview: true, pending_state: null, changed_fields: ['is_free_preview'] });
    expect(w.sections[0].lessons[0]).toMatchObject({ id: 'l1', has_video: true, video_pending: true, changed_fields: ['video_s3_key'] });
    expect(w.sections[0].lessons[1]).toMatchObject({ id: 'l2', pending_state: 'removed', video_pending: false });
    expect(w.sections[1]).toMatchObject({ id: 's2', pending_state: 'added', lessons: [expect.objectContaining({ id: 'l3', pending_state: 'added', has_video: false })] });
    // The working copy never leaks raw storage keys.
    expect(JSON.stringify(w)).not.toContain('videos/edu1');
  });

  it('a draft has the same shape with nothing pending and no outcomes call', async () => {
    const h = setup({ course: { status: 'draft' } });
    const w = await h.service.working(OWNER, 'c1');
    expect(w).toMatchObject({ pending_fields: [], has_pending_changes: false, revision: null, pending_assessments_count: 0 });
    expect(h.internal.get).not.toHaveBeenCalledWith(expect.stringContaining('pending-assessments'));
  });

  it('is limited to the owner, platform admins and the institution admin', async () => {
    const h = setup({ course: { institution_id: 'inst1' } });
    await expect(h.service.working(LEARNER, 'c1')).rejects.toThrow(ForbiddenException);
    await expect(h.service.working(QO, 'c1')).rejects.toThrow(ForbiddenException);
    await expect(h.service.working(ADMIN, 'c1')).resolves.toMatchObject({ id: 'c1' });
    await expect(h.service.working(INST_ADMIN, 'c1')).resolves.toMatchObject({ id: 'c1' });
  });
});

describe('GET /lessons/:id/stream-url', () => {
  const fixture = (entitlement = 'active'): Fixture => ({
    entitlement,
    sections: [liveSection({ pending: { is_free_preview: true } }), liveSection({ id: 's2', order_index: 1, is_free_preview: true, pending_state: 'added' })],
    lessons: [
      liveLesson({ pending: { video_s3_key: 'videos/edu1/replacement.mp4' } }),
      liveLesson({ id: 'l2', section_id: 's2', video_s3_key: 'videos/edu1/added.mp4', pending_state: 'added' }),
    ],
  });

  it('404s a learner on a lesson added in an unapproved revision, even in a free-preview section', async () => {
    const h = setup(fixture());
    await expect(h.controller.streamUrl(LEARNER, 'l2')).rejects.toThrow(new NotFoundException('Lesson not available'));
  });

  it('gives an entitled learner the LIVE video while a replacement is staged, even with ?version=pending', async () => {
    const h = setup(fixture());
    const res = await h.controller.streamUrl(LEARNER, 'l1', 'pending');
    expect(res).toMatchObject({ url: 'https://signed/videos/edu1/live.mp4', expires_in: 900, watermark: expect.stringContaining('l@x.et') });
  });

  it('gives the owner and a QO the staged replacement with ?version=pending', async () => {
    const h = setup(fixture('none'));
    await expect(h.controller.streamUrl(OWNER, 'l1', 'pending')).resolves.toMatchObject({ url: 'https://signed/videos/edu1/replacement.mp4' });
    await expect(h.controller.streamUrl(QO, 'l1', 'pending')).resolves.toMatchObject({ url: 'https://signed/videos/edu1/replacement.mp4' });
    await expect(h.controller.streamUrl(OWNER, 'l1')).resolves.toMatchObject({ url: 'https://signed/videos/edu1/live.mp4' });
    await expect(h.controller.streamUrl(OWNER, 'l2')).resolves.toMatchObject({ url: 'https://signed/videos/edu1/added.mp4' });
  });

  it('does not open a section whose free-preview flag is only staged', async () => {
    const h = setup(fixture('none'));
    await expect(h.controller.streamUrl(LEARNER, 'l1')).rejects.toThrow(new ForbiddenException('No active entitlement for this course'));
  });

  it('caps learners per minute but exempts platform staff', async () => {
    const h = setup(fixture());
    for (let i = 0; i < 12; i++) await h.controller.streamUrl(QO, 'l1', 'pending');
    for (let i = 0; i < 8; i++) await h.controller.streamUrl(LEARNER, 'l1');
    await expect(h.controller.streamUrl(LEARNER, 'l1')).rejects.toThrow(/Too many video requests/);
  });
});

describe('CourseReviewed subscriber (first-time submissions, appeals, post-publish items)', () => {
  const decision = (action: string, notes: string | null = null) => ({
    course_id: 'c1', action, notes, qo_id: 'qo1', owner_user_id: 'edu1', owner_email: 'e@x.et', course_title: 'x',
  });

  it('ignores a stale approve after the educator withdrew, and withdraw tells quality', async () => {
    const h = setup({ course: { status: 'submitted', published_at: null } });
    await h.service.withdraw(OWNER, 'c1');
    expect(h.bus.publish).toHaveBeenCalledWith('CourseReviewWithdrawn', { course_id: 'c1', revision_id: null });
    await h.handlers['CourseReviewed'](decision('approve'));
    expect(h.course).toMatchObject({ status: 'draft', published_at: null });
    expect(published(h)).not.toContain('CoursePublished');
  });

  it('first approval publishes and announces the course', async () => {
    const h = setup({ course: { status: 'submitted', published_at: null } });
    await h.handlers['CourseReviewed'](decision('approve'));
    expect(h.course.status).toBe('published');
    expect(h.course.published_at).toBeInstanceOf(Date);
    expect(published(h)).toEqual(['CoursePublished']);
    expect(h.extras.reindexCourse).toHaveBeenCalledWith('c1');
  });

  it('approving a post-publish item on a live course only records the feedback', async () => {
    const h = setup({ course: { status: 'published' } });
    const publishedAt = h.course.published_at;
    await h.handlers['CourseReviewed'](decision('approve', 'All good'));
    expect(h.course).toMatchObject({ status: 'published', published_at: publishedAt, last_review_action: 'approve', last_review_notes: 'All good' });
    expect(h.bus.publish).not.toHaveBeenCalled();
  });

  it('an appeal approval keeps the original publish date and does not re-announce', async () => {
    const h = setup({ course: { status: 'submitted' } });
    const publishedAt = h.course.published_at;
    await h.handlers['CourseReviewed'](decision('approve'));
    expect(h.course).toMatchObject({ status: 'published', published_at: publishedAt });
    expect(published(h)).not.toContain('CoursePublished');
  });

  it.each(['published', 'unlisted'])('coaching a %s course records feedback without demoting it', async (status) => {
    const h = setup({ course: { status } });
    await h.handlers['CourseReviewed'](decision('coach', 'Improve the audio'));
    expect(h.course).toMatchObject({ status, last_review_action: 'coach', last_review_notes: 'Improve the audio' });
  });

  it('coaching a submitted course sends it back to draft', async () => {
    const h = setup({ course: { status: 'submitted', published_at: null } });
    await h.handlers['CourseReviewed'](decision('coach', 'Add a thumbnail'));
    expect(h.course.status).toBe('draft');
  });

  it('a flag closes the open revision and withdraws it from the QA queue', async () => {
    const h = setup({ revisions: [{ id: 'rev1', course_id: 'c1', status: 'submitted', created_by: 'edu1' }], course: { pending: { title: 'Staged' } } });
    await h.handlers['CourseReviewed'](decision('flag', 'Policy violation'));
    expect(h.course.status).toBe('flagged');
    expect(h.revisions.rows[0]).toMatchObject({ status: 'withdrawn' });
    expect(h.bus.publish).toHaveBeenCalledWith('CourseReviewWithdrawn', { course_id: 'c1', revision_id: 'rev1' });
    // Staged data is kept for a resubmission after reinstatement.
    expect(h.course.pending).toEqual({ title: 'Staged' });
  });
});

describe('CourseService lifecycle around open revisions', () => {
  const openRevision = () => [{ id: 'rev1', course_id: 'c1', status: 'draft', created_by: 'edu1' }];

  it('archiveOwn closes the open revision', async () => {
    const h = setup({ revisions: openRevision() });
    await h.service.archiveOwn(OWNER, 'c1');
    expect(h.revisions.rows[0].status).toBe('withdrawn');
    expect(h.bus.publish).toHaveBeenCalledWith('CourseReviewWithdrawn', { course_id: 'c1', revision_id: 'rev1' });
  });

  it('admin archive closes the open revision', async () => {
    const h = setup({ revisions: openRevision() });
    await h.service.adminTransition('c1', 'archive');
    expect(h.revisions.rows[0].status).toBe('withdrawn');
    expect(published(h)).toEqual(expect.arrayContaining(['CourseReviewWithdrawn', 'CourseArchived']));
  });

  it('republish and admin restore never apply staged changes', async () => {
    const staged = {
      course: { status: 'unlisted', pending: { title: 'Staged', price_etb: '900.00' } },
      lessons: [liveLesson({ pending: { title: 'Staged lesson' } }), liveLesson({ id: 'l2', order_index: 1, pending_state: 'added' })],
      revisions: openRevision(),
    };
    const a = setup(staged);
    await a.service.republishOwn(OWNER, 'c1');
    const b = setup({ ...staged, course: { ...staged.course, status: 'flagged' } });
    await b.service.adminTransition('c1', 'restore');
    for (const h of [a, b]) {
      expect(h.course).toMatchObject({ status: 'published', title: 'Live title', price_etb: '500.00', pending: { title: 'Staged', price_etb: '900.00' } });
      expect(h.lessons.rows.map((l) => [l.id, l.title, l.pending_state])).toEqual([
        ['l1', 'Live lesson', null],
        ['l2', 'Live lesson', 'added'],
      ]);
      expect(h.revisions.rows[0].status).toBe('draft');
    }
  });

  it('duplicate copies the working copy, strips pending markers and skips removed rows', async () => {
    const h = setup({
      course: { pending: { title: 'Staged title', price_etb: '750.00' } },
      sections: [liveSection({ pending: { title: 'Renamed section' } }), liveSection({ id: 's2', order_index: 1, pending_state: 'removed' })],
      lessons: [
        liveLesson({ pending: { summary: 'staged summary', video_s3_key: 'videos/edu1/new.mp4' } }),
        liveLesson({ id: 'l2', order_index: 1, pending_state: 'added', title: 'Added lesson' }),
        liveLesson({ id: 'l3', order_index: 2, pending_state: 'removed' }),
        liveLesson({ id: 'l4', section_id: 's2' }),
      ],
    });
    const copy = await h.service.duplicate(OWNER, 'c1');
    expect(copy).toMatchObject({ title: 'Staged title (copy)', price_etb: '750.00', status: 'draft' });
    expect(copy.pending ?? null).toBeNull();
    const copiedSections = h.sections.rows.filter((s) => s.course_id === copy.id);
    expect(copiedSections.map((s) => [s.title, s.pending_state ?? null, s.pending ?? null])).toEqual([['Renamed section', null, null]]);
    const copiedLessons = h.lessons.rows.filter((l) => l.section_id === copiedSections[0].id);
    expect(copiedLessons.map((l) => [l.title, l.summary, l.video_s3_key, l.pending_state ?? null, l.pending ?? null])).toEqual([
      ['Live lesson', 'staged summary', 'videos/edu1/new.mp4', null, null],
      ['Added lesson', 'live summary', 'videos/edu1/live.mp4', null, null],
    ]);
  });
});

describe('Tutor notes on a live course', () => {
  it('are staged as pending under the open draft revision', async () => {
    const h = setup();
    await h.service.addKnowledge(OWNER, 'c1', 'Week 1 notes', 'x'.repeat(40));
    expect(h.extras.addKnowledge).toHaveBeenCalledWith(h.course, 'Week 1 notes', 'x'.repeat(40), 'pending');
    expect(h.revisions.rows).toEqual([expect.objectContaining({ status: 'draft' })]);
  });

  it('go live directly on a draft', async () => {
    const h = setup({ course: { status: 'draft' } });
    await h.service.addKnowledge(OWNER, 'c1', 'Notes', 'x'.repeat(40));
    expect(h.extras.addKnowledge).toHaveBeenCalledWith(h.course, 'Notes', 'x'.repeat(40), 'live');
    expect(h.revisions.rows).toHaveLength(0);
  });

  it('are refused while the change set is with a reviewer, and for strangers', async () => {
    const h = setup({ revisions: [{ id: 'rev1', course_id: 'c1', status: 'submitted', created_by: 'edu1' }] });
    await expect(h.service.addKnowledge(OWNER, 'c1', 'Notes', 'x'.repeat(40))).rejects.toThrow(ConflictException);
    await expect(h.service.addKnowledge(LEARNER, 'c1', 'Notes', 'x'.repeat(40))).rejects.toThrow(ForbiddenException);
    expect(h.extras.addKnowledge).not.toHaveBeenCalled();
  });
});

describe('Institution review endpoints', () => {
  it('the queue lists first-time submissions as new_course next to revision rows', async () => {
    const h = setup({ course: { status: 'institution_review', institution_id: 'inst1' } });
    const rows = await h.controller.institutionQueue(INST_ADMIN);
    expect(h.revisionService.institutionQueueRows).toHaveBeenCalledWith('inst1');
    expect(rows).toEqual([
      expect.objectContaining({ id: 'c1', kind: 'new_course', revision_id: null, instructor_name: 'Edu' }),
      expect.objectContaining({ kind: 'revision', revision_id: 'rev9' }),
    ]);
  });

  it('a decision on a first-time submission follows the course flow', async () => {
    const h = setup({ course: { status: 'institution_review', institution_id: 'inst1', published_at: null } });
    await h.controller.institutionDecide(INST_ADMIN, 'c1', { action: 'approve' });
    expect(h.course.status).toBe('submitted');
    expect(h.revisionService.institutionDecideRevision).not.toHaveBeenCalled();
  });

  it('a decision on a live course goes to its open institution revision', async () => {
    const h = setup({ course: { institution_id: 'inst1' } });
    h.revisionService.hasOpenInstitutionRevision.mockResolvedValueOnce(true);
    await h.controller.institutionDecide(INST_ADMIN, 'c1', { action: 'reject', notes: 'Fix typos' });
    expect(h.revisionService.institutionDecideRevision).toHaveBeenCalledWith(INST_ADMIN, 'c1', 'reject', 'Fix typos');
    expect(h.course.status).toBe('published');
  });

  it('404s when nothing is awaiting review, or the course is not the institution\'s', async () => {
    const h = setup({ course: { institution_id: 'inst1' } });
    await expect(h.controller.institutionDecide(INST_ADMIN, 'c1', { action: 'approve' })).rejects.toThrow(NotFoundException);
    const other = setup({ course: { status: 'institution_review', institution_id: 'inst2' } });
    await expect(other.controller.institutionDecide(INST_ADMIN, 'c1', { action: 'approve' })).rejects.toThrow(NotFoundException);
  });
});


describe('CourseService.generateStructure', () => {
  const HEADINGS = 'DOCUMENT OUTLINE (authoritative order):\n# Setup\n# Syntax\n# Concurrency';
  const UNSTRUCTURED = 'Some unstructured notes about goroutines and channels, with no headings anywhere in the text at all.';
  const withAi = (h: ReturnType<typeof setup>, ai: unknown) => Object.assign(h.service as unknown as { ai: unknown }, { ai });

  it('falls back to an editable starter outline with the actionable reason when a live-key call fails', async () => {
    const h = setup();
    withAi(h, { isLive: true, generateCourseStructure: jest.fn().mockRejectedValue(Object.assign(new Error('401'), { reason: 'auth' })) });
    const res = await h.service.generateStructure(OWNER, { title: 'Intro to Go', source_text: HEADINGS });
    expect(res).toMatchObject({ ai_live: false, origin: 'headings' });
    expect(res.sections.length).toBeGreaterThan(0);
    expect(res.note).toMatch(/GROQ_API_KEY/);
  });

  it('labels the model outline as live with no note', async () => {
    const h = setup();
    const sections = [{ title: 'Basics', is_free_preview: true, lessons: [{ title: 'Hello', summary: 'First program' }] }];
    withAi(h, { isLive: true, generateCourseStructure: jest.fn().mockResolvedValue({ sections, origin: 'model' }) });
    await expect(h.service.generateStructure(OWNER, { title: 'Go', source_text: HEADINGS })).resolves.toEqual({ sections, ai_live: true, origin: 'model' });
  });

  it('an unusable reply on a live key is not presented as the AI outline', async () => {
    const h = setup();
    const fallback = await new MockAiAssessor().generateCourseStructure({ title: 'Go', source_text: HEADINGS, section_count: 4, lessons_per_section: 3 });
    withAi(h, { isLive: true, generateCourseStructure: jest.fn().mockResolvedValue(fallback) });
    const res = await h.service.generateStructure(OWNER, { title: 'Go', source_text: HEADINGS });
    expect(res).toMatchObject({ ai_live: false, origin: 'headings' });
    expect(res.note).toBe("The AI reply could not be used — this is a starter outline built from your document's headings; edit it.");
  });

  it('offline: an outline from the headings says so', async () => {
    const h = setup();
    withAi(h, new MockAiAssessor());
    const res = await h.service.generateStructure(OWNER, { title: 'Go', source_text: HEADINGS });
    expect(res).toMatchObject({ ai_live: false, origin: 'headings' });
    expect(res.note).toBe("AI is offline — this is a starter outline built from your document's headings; edit it.");
  });

  it('offline: the generic placeholder never claims it was built from the document', async () => {
    const h = setup();
    withAi(h, new MockAiAssessor());
    const res = await h.service.generateStructure(OWNER, { title: 'Go', source_text: UNSTRUCTURED });
    expect(res).toMatchObject({ ai_live: false, origin: 'placeholder' });
    expect(res.note).toBe('AI is offline — this is a generic starter outline; edit it or paste your notes with headings.');
    expect(res.note).not.toMatch(/headings;|built from your document/);
  });

  it('an assessor that does not report origin is trusted when live and treated as placeholder when not', async () => {
    const sections = [{ title: 'Basics', is_free_preview: true, lessons: [{ title: 'Hello', summary: null }] }];
    const live = setup();
    withAi(live, { isLive: true, generateCourseStructure: jest.fn().mockResolvedValue({ sections }) });
    await expect(live.service.generateStructure(OWNER, { title: 'Go' })).resolves.toMatchObject({ ai_live: true, origin: 'model' });
    const offline = setup();
    withAi(offline, { isLive: false, generateCourseStructure: jest.fn().mockResolvedValue({ sections }) });
    await expect(offline.service.generateStructure(OWNER, { title: 'Go' })).resolves.toMatchObject({ ai_live: false, origin: 'placeholder' });
  });
});

describe('Tutor notes follow the content-write gate', () => {
  it.each(['submitted', 'under_review', 'institution_review'])('adding or removing a note on a course in review (%s) is a 409', async (status) => {
    const h = setup({ course: { status } });
    const inReview = new ConflictException('This course is in review. Withdraw it to make changes.');
    await expect(h.service.addKnowledge(OWNER, 'c1', 'Notes', 'x'.repeat(40))).rejects.toThrow(inReview);
    await expect(h.service.deleteKnowledge(OWNER, 'c1', 'Notes')).rejects.toThrow(inReview);
    expect(h.extras.addKnowledge).not.toHaveBeenCalled();
    expect(h.extras.deleteKnowledge).not.toHaveBeenCalled();
  });

  it.each(['flagged', 'archived'])('adding or removing a note on a %s course is a 400 (nothing reaches learners unreviewed)', async (status) => {
    const h = setup({ course: { status } });
    await expect(h.service.addKnowledge(OWNER, 'c1', 'Notes', 'x'.repeat(40))).rejects.toThrow(BadRequestException);
    await expect(h.service.deleteKnowledge(OWNER, 'c1', 'Notes')).rejects.toThrow(BadRequestException);
    expect(h.extras.addKnowledge).not.toHaveBeenCalled();
    expect(h.extras.deleteKnowledge).not.toHaveBeenCalled();
  });

  it('removing a note on a live course is staged-aware, opens no revision, and is refused while the change set is with a reviewer', async () => {
    const h = setup();
    await h.service.deleteKnowledge(OWNER, 'c1', 'Syllabus', 'pending');
    expect(h.extras.deleteKnowledge).toHaveBeenCalledWith('c1', 'Syllabus', true, 'pending');
    expect(h.revisions.rows).toHaveLength(0);

    const inReview = setup({ revisions: [{ id: 'rev1', course_id: 'c1', status: 'submitted', created_by: 'edu1' }] });
    await expect(inReview.service.deleteKnowledge(OWNER, 'c1', 'Syllabus', 'pending')).rejects.toThrow(
      new ConflictException('Your changes are in review — withdraw them to keep editing.'),
    );
    expect(inReview.extras.deleteKnowledge).not.toHaveBeenCalled();
  });

  it('on a draft a note is removed directly, and only by authors', async () => {
    const h = setup({ course: { status: 'draft', institution_id: 'inst1' } });
    await h.service.deleteKnowledge(OWNER, 'c1', 'Syllabus');
    expect(h.extras.deleteKnowledge).toHaveBeenCalledWith('c1', 'Syllabus', false, undefined);
    await h.service.deleteKnowledge(INST_ADMIN, 'c1', 'Syllabus');
    await expect(h.service.deleteKnowledge(OTHER_EDU, 'c1', 'Syllabus')).rejects.toThrow(ForbiddenException);
    expect(h.extras.deleteKnowledge).toHaveBeenCalledTimes(2);
  });

  it('DELETE knowledge/:title validates ?state and keeps a title with a literal %', async () => {
    const h = setup();
    expect(() => h.controller.deleteKnowledge(OWNER, 'c1', 'Syllabus', 'both')).toThrow(BadRequestException);
    await h.controller.deleteKnowledge(OWNER, 'c1', '100% notes', 'live');
    expect(h.extras.deleteKnowledge).toHaveBeenLastCalledWith('c1', '100% notes', true, 'live');
    await h.controller.deleteKnowledge(OWNER, 'c1', 'Week%201');
    expect(h.extras.deleteKnowledge).toHaveBeenLastCalledWith('c1', 'Week 1', true, undefined);
  });
});

/** Staged work of every kind, as a live course accumulates it. */
function leftovers(status: string, over: Row = {}): Fixture {
  return {
    course: { status, pending: { title: 'Staged title', price_etb: '750.00' }, ...over },
    sections: [
      liveSection({ pending: { title: 'Renamed section' } }),
      liveSection({ id: 's2', order_index: 1, title: 'Added section', pending_state: 'added' }),
      liveSection({ id: 's3', order_index: 2, title: 'Dropped section', pending_state: 'removed' }),
    ],
    lessons: [
      liveLesson({ pending: { title: 'Staged lesson title', video_s3_key: 'videos/edu1/new.mp4' } }),
      liveLesson({ id: 'l2', order_index: 1, pending_state: 'removed' }),
      liveLesson({ id: 'l3', section_id: 's2', title: 'Added lesson', pending_state: 'added' }),
      liveLesson({ id: 'l4', section_id: 's3', title: 'Lesson of dropped section', pending_state: 'removed' }),
    ],
    knowledge: [
      { id: 'k1', course_id: 'c1', source: 'notes', title: 'Syllabus', chunk_index: 0, text: 'approved', state: 'live' },
      { id: 'k2', course_id: 'c1', source: 'notes', title: 'Syllabus', chunk_index: 0, text: 'revised', state: 'pending' },
    ],
  };
}

/** The staged work of `leftovers` is now simply the course's content, with no markers left. */
function expectFolded(h: ReturnType<typeof setup>) {
  expect(h.course).toMatchObject({ title: 'Staged title', price_etb: '750.00', pending: null });
  expect(h.sections.rows.map((s) => [s.id, s.title, s.pending_state, s.pending])).toEqual([
    ['s1', 'Renamed section', null, null],
    ['s2', 'Added section', null, null],
  ]);
  expect(h.lessons.rows.map((l) => [l.id, l.title, l.video_s3_key, l.pending_state, l.pending])).toEqual([
    ['l1', 'Staged lesson title', 'videos/edu1/new.mp4', null, null],
    ['l3', 'Added lesson', 'videos/edu1/live.mp4', null, null],
  ]);
  expect(h.knowledge.rows.map((k) => [k.text, k.state])).toEqual([['revised', 'live']]);
}

async function expectCleanWorkingView(h: ReturnType<typeof setup>) {
  const w = await h.service.working(OWNER, 'c1');
  expect(w).toMatchObject({ status: 'draft', title: 'Staged title', pending_fields: [], has_pending_changes: false });
  for (const s of w.sections) {
    expect(s).toMatchObject({ pending_state: null, changed_fields: [] });
    for (const l of s.lessons) expect(l).toMatchObject({ pending_state: null, changed_fields: [], video_pending: false });
  }
}

describe('Staged work left on a course that is no longer live becomes the draft', () => {
  it('restore folds it in the same transaction as the status change, and a later draft edit shows', async () => {
    const h = setup(leftovers('archived'));
    await h.service.restoreOwn(OWNER, 'c1');
    expect(h.course.status).toBe('draft');
    expectFolded(h);
    await expectCleanWorkingView(h);

    // The edit the finding saw "not save": it now writes the value the editor shows.
    const res = await h.service.update(OWNER, 'c1', { title: 'Final title' });
    expect(res).toMatchObject({ title: 'Final title', pending_fields: [], has_pending_changes: false });
  });

  it('a failed fold leaves the course archived with its staged work intact', async () => {
    const h = setup(leftovers('archived'));
    h.lessons.delete.mockRejectedValueOnce(new Error('connection reset'));
    await expect(h.service.restoreOwn(OWNER, 'c1')).rejects.toThrow('connection reset');
    // The rollback restores row snapshots, so read the stored row rather than the fixture object.
    expect(h.courses.rows[0]).toMatchObject({ status: 'archived', title: 'Live title', pending: { title: 'Staged title', price_etb: '750.00' } });
    expect(h.sections.rows).toHaveLength(3);
    expect(h.knowledge.rows).toHaveLength(2);
  });

  it('withdrawing an appeal folds it', async () => {
    const h = setup(leftovers('submitted'));
    await h.service.withdraw(OWNER, 'c1');
    expect(h.course.status).toBe('draft');
    expectFolded(h);
    expect(h.bus.publish).toHaveBeenCalledWith('CourseReviewWithdrawn', { course_id: 'c1', revision_id: null });
  });

  it('a QO coaching an appeal back to draft folds it', async () => {
    const h = setup(leftovers('under_review'));
    await h.handlers['CourseReviewed']({ course_id: 'c1', action: 'coach', notes: 'Fix the audio', qo_id: 'qo1', owner_user_id: 'edu1', owner_email: 'e@x.et', course_title: 'x' });
    expect(h.course).toMatchObject({ status: 'draft', last_review_action: 'coach', last_review_notes: 'Fix the audio' });
    expectFolded(h);
  });

  it('an institution send-back folds it', async () => {
    const h = setup(leftovers('institution_review', { institution_id: 'inst1' }));
    await h.service.institutionDecide(INST_ADMIN, 'c1', 'reject', 'Add captions');
    expect(h.course).toMatchObject({ status: 'draft', last_review_action: 'institution_reject' });
    expectFolded(h);
  });

  it('a draft that still carries staged rows is folded before a direct edit, so the edit is what the editor shows', async () => {
    const h = setup(leftovers('draft'));
    const res = await h.service.update(OWNER, 'c1', { description: 'Edited in draft' });
    expectFolded(h);
    expect(res).toMatchObject({ title: 'Staged title', description: 'Edited in draft', pending_fields: [], has_pending_changes: false });
  });

  it('a lesson edit on such a draft writes the folded row, and a lesson the fold removed is a clear 404', async () => {
    const h = setup(leftovers('draft'));
    await h.service.updateLesson(OWNER, 'l1', { summary: 'Draft summary' });
    expect(h.lessons.rows.find((l) => l.id === 'l1')).toMatchObject({ title: 'Staged lesson title', summary: 'Draft summary', pending: null });

    const again = setup(leftovers('draft'));
    await expect(again.service.updateLesson(OWNER, 'l2', { title: 'Too late' })).rejects.toThrow(
      new NotFoundException('Lesson not found — it was removed in your earlier changes. Reload the page.'),
    );
    await expect(setup(leftovers('draft')).service.assertLessonEditable(OWNER, 'l4')).rejects.toThrow(NotFoundException);
  });

  it('a section edit on such a draft does not write the stale section back', async () => {
    const h = setup(leftovers('draft'));
    await h.service.updateSection(OWNER, 's1', { is_free_preview: true });
    expect(h.sections.rows.find((s) => s.id === 's1')).toMatchObject({ title: 'Renamed section', is_free_preview: true, pending: null });
    await expect(setup(leftovers('draft')).service.addLesson(OWNER, 's3', { title: 'Into the void' })).rejects.toThrow(NotFoundException);
  });

  it('tutor notes on such a draft go live after the fold', async () => {
    const h = setup(leftovers('draft'));
    await h.service.addKnowledge(OWNER, 'c1', 'Week 2', 'x'.repeat(40));
    expect(h.extras.addKnowledge).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', title: 'Staged title', pending: null }), 'Week 2', 'x'.repeat(40), 'live');
    expectFolded(h);
  });

  it('the working view of such a draft shows no staged markers', async () => {
    const h = setup(leftovers('draft'));
    await expectCleanWorkingView(h);
    expectFolded(h);
  });

  it('first-time submit folds first: the reviewer and learners get exactly what the editor showed', async () => {
    const h = setup(leftovers('draft', { published_at: null }));
    await h.service.submit(OWNER, 'c1');
    expect(h.course.status).toBe('submitted');
    expectFolded(h);
    const detail = await h.service.publicDetail('c1', OWNER);
    expect(detail).toMatchObject({ title: 'Staged title', price_etb: 750 });
    expect(detail.sections.map((s) => s.title)).toEqual(['Renamed section', 'Added section']);
    await expect(h.service.outlineForCourse('c1')).resolves.toEqual(['Renamed section — Staged lesson title', 'Added section — Added lesson']);
    expect(h.bus.publish).toHaveBeenCalledWith('CourseSubmitted', expect.objectContaining({ title: 'Staged title' }));
  });

  it('submit counts the folded content: a draft whose only lesson was staged for removal cannot be submitted', async () => {
    const h = setup({ course: { status: 'draft' }, lessons: [liveLesson({ pending_state: 'removed' })] });
    await expect(h.service.submit(OWNER, 'c1')).rejects.toThrow(new BadRequestException('Add at least one lesson before submitting'));
    // The course is not live, so the fold stands; only the status change is refused.
    expect(h.course.status).toBe('draft');
    expect(h.lessons.rows).toHaveLength(0);
  });

  it('a flagged course keeps its staged work for the appeal (nothing is folded while it is not a draft)', async () => {
    const h = setup(leftovers('flagged'));
    await h.service.working(OWNER, 'c1');
    expect(h.course.pending).toEqual({ title: 'Staged title', price_etb: '750.00' });
    expect(h.sections.rows).toHaveLength(3);
  });
});

/**
 * The next course read returns a snapshot, then `concurrent` lands on the
 * stored row — as if another transaction (a revision apply, a rating update)
 * committed right after the load.
 */
function staleNextLoad(h: ReturnType<typeof setup>, concurrent: Row) {
  h.courses.findOne.mockImplementationOnce(async (opts?: { where?: Row }) => {
    const row = h.courses.rows.find((r) => matches(r, opts?.where));
    if (!row) throw new Error('staleNextLoad: no such course in the fixture');
    const snapshot = { ...row };
    Object.assign(row, concurrent);
    return snapshot;
  });
}

describe('Lifecycle transitions write only the columns they change', () => {
  const decision = (action: string) => ({ course_id: 'c1', action, notes: 'n', qo_id: 'qo1', owner_user_id: 'edu1', owner_email: 'e@x.et', course_title: 'x' });
  // A revision apply that commits while the transition holds a stale entity.
  const APPLIED = { title: 'Applied title', price_etb: '600.00', pending: null, enrolled_count: 7 };

  it.each<[string, Row, (h: ReturnType<typeof setup>) => Promise<unknown>, string]>([
    ['unpublishOwn', { status: 'published' }, (h) => h.service.unpublishOwn(OWNER, 'c1'), 'unlisted'],
    ['republishOwn', { status: 'unlisted' }, (h) => h.service.republishOwn(OWNER, 'c1'), 'published'],
    ['archiveOwn', { status: 'published' }, (h) => h.service.archiveOwn(OWNER, 'c1'), 'archived'],
    ['restoreOwn', { status: 'archived' }, (h) => h.service.restoreOwn(OWNER, 'c1'), 'draft'],
    ['appeal', { status: 'flagged' }, (h) => h.service.appeal(OWNER, 'c1', 'Please look again'), 'submitted'],
    ['withdraw', { status: 'submitted' }, (h) => h.service.withdraw(OWNER, 'c1'), 'draft'],
    ['submit', { status: 'draft' }, (h) => h.service.submit(OWNER, 'c1'), 'submitted'],
    ['admin unlist', { status: 'published' }, (h) => h.service.adminTransition('c1', 'unlist'), 'unlisted'],
    ['admin restore', { status: 'flagged' }, (h) => h.service.adminTransition('c1', 'restore'), 'published'],
    ['admin archive', { status: 'published' }, (h) => h.service.adminTransition('c1', 'archive'), 'archived'],
    ['institution unlist', { status: 'published', institution_id: 'inst1' }, (h) => h.service.institutionTransition(INST_ADMIN, 'c1', 'unlist'), 'unlisted'],
    ['institution approve', { status: 'institution_review', institution_id: 'inst1' }, (h) => h.service.institutionDecide(INST_ADMIN, 'c1', 'approve'), 'submitted'],
    ['institution reject', { status: 'institution_review', institution_id: 'inst1' }, (h) => h.service.institutionDecide(INST_ADMIN, 'c1', 'reject'), 'draft'],
    ['QO approve (post-publish)', { status: 'published' }, (h) => h.handlers['CourseReviewed'](decision('approve')), 'published'],
    ['QO approve (appeal)', { status: 'submitted' }, (h) => h.handlers['CourseReviewed'](decision('approve')), 'published'],
    ['QO coach (live)', { status: 'unlisted' }, (h) => h.handlers['CourseReviewed'](decision('coach')), 'unlisted'],
    ['QO coach (in review)', { status: 'under_review' }, (h) => h.handlers['CourseReviewed'](decision('coach')), 'draft'],
    ['QO flag', { status: 'published' }, (h) => h.handlers['CourseReviewed'](decision('flag')), 'flagged'],
  ])('%s never writes a stale entity back over a concurrent change', async (_name, course, run, status) => {
    const h = setup({ course: { ...course, pending: { title: 'Applied title', price_etb: '600.00' } } });
    staleNextLoad(h, APPLIED);
    await run(h);
    expect(h.course).toMatchObject({ ...APPLIED, status });
    expect(h.courses.save).not.toHaveBeenCalled();
  });

  it('a transition that loses a race with another status change is a 409, not an overwrite', async () => {
    const h = setup({ course: { status: 'published' } });
    staleNextLoad(h, { status: 'flagged' });
    await expect(h.service.unpublishOwn(OWNER, 'c1')).rejects.toThrow(ConflictException);
    expect(h.course.status).toBe('flagged');
  });

  it('closing a revision never overwrites one that was applied in the meantime', async () => {
    const h = setup({ revisions: [{ id: 'rev1', course_id: 'c1', status: 'submitted', created_by: 'edu1' }] });
    h.revisions.findOne.mockImplementationOnce(async () => {
      const snapshot = { ...h.revisions.rows[0] };
      h.revisions.rows[0].status = 'applied';
      return snapshot;
    });
    await h.service.archiveOwn(OWNER, 'c1');
    expect(h.revisions.rows[0].status).toBe('applied');
    expect(published(h)).not.toContain('CourseReviewWithdrawn');
  });
});

describe('Archiving a course that is in first-time review', () => {
  const archivers: Array<[string, (h: ReturnType<typeof setup>) => Promise<unknown>]> = [
    ['educator archive', (h) => h.service.archiveOwn(OWNER, 'c1')],
    ['admin archive', (h) => h.service.adminTransition('c1', 'archive')],
  ];

  it.each(['submitted', 'under_review', 'institution_review'])('withdraws the QA item (%s)', async (status) => {
    for (const [, archive] of archivers) {
      const h = setup({ course: { status, published_at: null } });
      await archive(h);
      expect(h.course.status).toBe('archived');
      expect(h.bus.publish).toHaveBeenCalledWith('CourseReviewWithdrawn', { course_id: 'c1', revision_id: null });
    }
  });

  it.each(['published', 'draft'])('publishes no first-time withdrawal for a %s course', async (status) => {
    for (const [, archive] of archivers) {
      const h = setup({ course: { status } });
      await archive(h);
      expect(h.bus.publish).not.toHaveBeenCalledWith('CourseReviewWithdrawn', { course_id: 'c1', revision_id: null });
    }
  });
});

describe('A QO flag only applies to a course in the QO queue or live', () => {
  const flag = { course_id: 'c1', action: 'flag', notes: 'Policy', qo_id: 'qo1', owner_user_id: 'edu1', owner_email: 'e@x.et', course_title: 'x' };

  it.each(['submitted', 'under_review', 'published', 'unlisted'])('flags a %s course', async (status) => {
    const h = setup({ course: { status } });
    await h.handlers['CourseReviewed'](flag);
    expect(h.course).toMatchObject({ status: 'flagged', last_review_action: 'flag', last_review_notes: 'Policy' });
  });

  it.each(['draft', 'archived', 'flagged', 'institution_review'])('ignores (and logs) a stale flag on a %s course', async (status) => {
    const h = setup({ course: { status }, revisions: [{ id: 'rev1', course_id: 'c1', status: 'draft', created_by: 'edu1' }] });
    const warn = jest.spyOn((h.service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);
    await h.handlers['CourseReviewed'](flag);
    expect(h.course).toMatchObject({ status, last_review_action: null });
    expect(h.revisions.rows[0].status).toBe('draft');
    expect(h.bus.publish).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`ignoring stale QO flag for course c1 (status ${status})`));
  });

  it('a flag racing a withdraw does not lock the draft', async () => {
    const h = setup({ course: { status: 'submitted' } });
    staleNextLoad(h, { status: 'draft' });
    await h.handlers['CourseReviewed'](flag);
    expect(h.course.status).toBe('draft');
  });
});

describe('Platform admins can use the authoring endpoints the teach page calls', () => {
  it.each(['update', 'updateLesson', 'deleteLesson', 'updateSection', 'deleteSection', 'addSection', 'addLesson', 'working'] as const)(
    '%s allows PLATFORM_ADMIN',
    (method) => {
      const roles = Reflect.getMetadata(ROLES_KEY, CourseController.prototype[method]) as string[];
      expect(roles).toEqual(expect.arrayContaining([Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN]));
    },
  );

  it('and the service lets them edit a draft they do not own', async () => {
    const h = setup({ course: { status: 'draft' } });
    await h.service.update(ADMIN, 'c1', { title: 'Admin fix' });
    const section = await h.service.addSection(ADMIN, 'c1', { title: 'Admin section', is_free_preview: false });
    await h.service.updateSection(ADMIN, section.id, { title: 'Admin section 2' });
    const lesson = await h.service.addLesson(ADMIN, section.id, { title: 'Admin lesson' });
    await h.service.updateLesson(ADMIN, lesson.id, { title: 'Admin lesson 2' });
    await h.service.deleteLesson(ADMIN, lesson.id);
    await h.service.deleteSection(ADMIN, section.id);
    expect(h.course.title).toBe('Admin fix');
    await expect(h.service.update(OTHER_EDU, 'c1', { title: 'Hijack' })).rejects.toThrow(ForbiddenException);
  });
});
