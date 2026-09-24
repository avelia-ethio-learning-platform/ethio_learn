import { FindOperator } from 'typeorm';
import { Course, CourseKnowledge, Lesson, Section } from './entities';
import { applyStagedRows, discardStagedRows, hasStagedRows } from './staging';

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected instanceof FindOperator) {
      if (expected.type === 'in') return (expected.value as unknown[]).includes(row[key]);
      throw new Error(`fake repo: unsupported operator ${expected.type}`);
    }
    return (row[key] ?? null) === (expected ?? null);
  });
}

/** Array-backed repository; every write is logged so tests can check what ran and in which order. */
class FakeRepo {
  rows: Row[] = [];
  constructor(
    private readonly name: string,
    private readonly log: string[],
  ) {}

  find = jest.fn(async (opts: { where?: Row } = {}) => this.rows.filter((r) => !opts.where || matches(r, opts.where)).map((r) => ({ ...r })));
  findOne = jest.fn(async (opts: { where: Row }) => {
    const row = this.rows.find((r) => matches(r, opts.where));
    return row ? { ...row } : null;
  });
  update = jest.fn(async (where: Row, patch: Row) => {
    this.log.push(`update ${this.name}`);
    let affected = 0;
    for (const r of this.rows) {
      if (matches(r, where)) {
        Object.assign(r, patch);
        affected++;
      }
    }
    return { affected };
  });
  delete = jest.fn(async (where: Row) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, where));
    this.log.push(`delete ${this.name} ${before - this.rows.length}`);
    return { affected: before - this.rows.length };
  });
  get(id: string) {
    return this.rows.find((r) => r.id === id);
  }
}

function setup() {
  const log: string[] = [];
  const courses = new FakeRepo('course', log);
  const sections = new FakeRepo('section', log);
  const lessons = new FakeRepo('lesson', log);
  const knowledge = new FakeRepo('knowledge', log);
  const repos = new Map<unknown, FakeRepo>([
    [Course, courses],
    [Section, sections],
    [Lesson, lessons],
    [CourseKnowledge, knowledge],
  ]);
  const manager = { getRepository: jest.fn((entity: unknown) => repos.get(entity)!) } as never;

  courses.rows.push({
    id: 'c1',
    title: 'Live title',
    description: 'Live description',
    category: 'programming',
    thumbnail_url: 'http://x/t.png',
    pricing_type: 'paid',
    price_etb: '500.00',
    status: 'published',
    pending: null,
  });
  sections.rows.push(
    { id: 's1', course_id: 'c1', title: 'Intro', order_index: 0, is_free_preview: false, pending_state: null, pending: null },
    { id: 's-other', course_id: 'c2', title: 'Other course', order_index: 0, is_free_preview: false, pending_state: 'added', pending: null },
  );
  lessons.rows.push(
    { id: 'l1', section_id: 's1', title: 'Welcome', summary: 'old', duration_seconds: 60, video_s3_key: 'videos/e/OLD.mp4', order_index: 0, pending_state: null, pending: null },
    { id: 'l2', section_id: 's1', title: 'Setup', summary: null, duration_seconds: 30, video_s3_key: null, order_index: 1, pending_state: null, pending: null },
  );
  knowledge.rows.push({ id: 'k-live', course_id: 'c1', source: 'notes', title: 'Glossary', chunk_index: 0, text: 'old', state: 'live' });

  /** Every kind of staged row a live course can carry. */
  function stageEverything() {
    courses.get('c1')!.pending = { title: 'New title', price_etb: '600' };
    lessons.get('l1')!.pending = { video_s3_key: 'videos/e/NEW.mp4', summary: 'new' };
    lessons.get('l2')!.pending_state = 'removed';
    sections.rows.push(
      { id: 's2', course_id: 'c1', title: 'Bonus', order_index: 1, is_free_preview: false, pending_state: 'added', pending: null },
      { id: 's3', course_id: 'c1', title: 'Old part', order_index: 2, is_free_preview: false, pending_state: 'removed', pending: null },
      { id: 's4', course_id: 'c1', title: 'Renamed', order_index: 3, is_free_preview: false, pending_state: null, pending: { title: 'Renamed later', is_free_preview: true } },
    );
    lessons.rows.push(
      { id: 'l3', section_id: 's2', title: 'Bonus lesson', summary: null, duration_seconds: 10, video_s3_key: null, order_index: 0, pending_state: 'added', pending: null },
      { id: 'l5', section_id: 's3', title: 'Live lesson of removed section', summary: null, duration_seconds: 10, video_s3_key: null, order_index: 0, pending_state: null, pending: null },
      { id: 'l6', section_id: 's3', title: 'Added into removed section', summary: null, duration_seconds: 10, video_s3_key: null, order_index: 1, pending_state: 'added', pending: null },
    );
    knowledge.rows.push({ id: 'k-new', course_id: 'c1', source: 'notes', title: 'Glossary', chunk_index: 0, text: 'new', state: 'pending' });
  }

  return { log, manager, courses, sections, lessons, knowledge, stageEverything };
}

describe('applyStagedRows', () => {
  it('copies the staged values onto the live columns, deletes removed rows and clears every marker', async () => {
    const t = setup();
    t.stageEverything();

    const ids = await applyStagedRows(t.manager, 'c1');

    expect(t.courses.get('c1')).toMatchObject({ title: 'New title', price_etb: '600', description: 'Live description', pending: null });
    expect(t.lessons.get('l1')).toMatchObject({ video_s3_key: 'videos/e/NEW.mp4', summary: 'new', title: 'Welcome', pending: null, pending_state: null });
    expect(t.lessons.get('l3')).toMatchObject({ pending_state: null });
    expect(t.sections.get('s2')).toMatchObject({ pending_state: null });
    expect(t.sections.get('s4')).toMatchObject({ title: 'Renamed later', is_free_preview: true, pending: null, pending_state: null });
    // Removed rows are gone; a removed section takes every lesson with it, including one added there.
    expect(t.lessons.rows.map((l) => l.id).sort()).toEqual(['l1', 'l3']);
    expect(t.sections.rows.map((s) => s.id).sort()).toEqual(['s-other', 's1', 's2', 's4']);
    // Another course's staged rows are never touched.
    expect(t.sections.get('s-other')).toMatchObject({ pending_state: 'added' });
    // The re-uploaded note replaced the live note of the same title.
    expect(t.knowledge.rows.map((k) => [k.id, k.state])).toEqual([['k-new', 'live']]);

    // Ids describe the change set learners notice: an added row inside a removed section never was live.
    expect(ids.addedLessonIds).toEqual(['l3']);
    expect(ids.removedLessonIds.sort()).toEqual(['l2', 'l5']);
    expect(ids.replacedVideoLessonIds).toEqual(['l1']);
  });

  it('deletes lessons before their sections (lessons reference them)', async () => {
    const t = setup();
    t.stageEverything();
    await applyStagedRows(t.manager, 'c1');
    const deletes = t.log.filter((e) => e.startsWith('delete lesson') || e.startsWith('delete section'));
    expect(deletes).toEqual(['delete lesson 3', 'delete section 1']);
  });

  it('turns live only the pending notes it loaded — a note added meanwhile waits for the next revision', async () => {
    const t = setup();
    t.stageEverything();
    const realFind = t.knowledge.find.getMockImplementation()!;
    t.knowledge.find.mockImplementationOnce(async (opts) => {
      const loaded = await realFind(opts);
      // Inserted by a concurrent request after the state was read.
      t.knowledge.rows.push({ id: 'k-late', course_id: 'c1', source: 'notes', title: 'Late note', chunk_index: 0, text: 'late', state: 'pending' });
      return loaded;
    });
    await applyStagedRows(t.manager, 'c1');
    expect(t.knowledge.get('k-new')!.state).toBe('live');
    expect(t.knowledge.get('k-late')!.state).toBe('pending');
  });

  it('is a no-op on a course with nothing staged, and on a missing course', async () => {
    const t = setup();
    await expect(applyStagedRows(t.manager, 'c1')).resolves.toEqual({ addedLessonIds: [], removedLessonIds: [], replacedVideoLessonIds: [] });
    expect(t.log).toEqual([]);
    await expect(applyStagedRows(t.manager, 'missing')).resolves.toEqual({ addedLessonIds: [], removedLessonIds: [], replacedVideoLessonIds: [] });
    expect(t.log).toEqual([]);
  });

  it('never writes course status or published_at', async () => {
    const t = setup();
    t.stageEverything();
    await applyStagedRows(t.manager, 'c1');
    for (const [, patch] of t.courses.update.mock.calls) {
      expect(patch).not.toHaveProperty('status');
      expect(patch).not.toHaveProperty('published_at');
    }
  });
});

describe('discardStagedRows', () => {
  it("deletes 'added' rows, clears pending values and 'removed' markers, and deletes pending notes", async () => {
    const t = setup();
    t.stageEverything();
    // A note added after the state was read must go too (not covered by the course row lock).
    t.knowledge.rows.push({ id: 'k-late', course_id: 'c1', source: 'notes', title: 'Late', chunk_index: 0, text: 'late', state: 'pending' });

    await discardStagedRows(t.manager, 'c1');

    expect(t.courses.get('c1')).toMatchObject({ title: 'Live title', price_etb: '500.00', pending: null });
    expect(t.sections.rows.map((s) => s.id).sort()).toEqual(['s-other', 's1', 's3', 's4']);
    expect(t.sections.get('s3')).toMatchObject({ pending_state: null, title: 'Old part' });
    expect(t.sections.get('s4')).toMatchObject({ pending: null, title: 'Renamed', is_free_preview: false });
    expect(t.lessons.rows.map((l) => l.id).sort()).toEqual(['l1', 'l2', 'l5']);
    expect(t.lessons.get('l1')).toMatchObject({ pending: null, video_s3_key: 'videos/e/OLD.mp4', summary: 'old' });
    expect(t.lessons.get('l2')).toMatchObject({ pending_state: null });
    expect(t.knowledge.rows.map((k) => k.id)).toEqual(['k-live']);
    expect(t.sections.get('s-other')).toMatchObject({ pending_state: 'added' });
  });

  it('does nothing for a missing course', async () => {
    const t = setup();
    await discardStagedRows(t.manager, 'missing');
    expect(t.log).toEqual([]);
  });
});

describe('hasStagedRows', () => {
  it("is false for a clean course (another course's staged rows do not count) and for a missing one", async () => {
    const t = setup();
    expect(t.sections.get('s-other')).toMatchObject({ course_id: 'c2', pending_state: 'added' });
    await expect(hasStagedRows(t.manager, 'c1')).resolves.toBe(false);
    await expect(hasStagedRows(t.manager, 'missing')).resolves.toBe(false);
  });

  it.each([
    ['a pending course field', (t: ReturnType<typeof setup>) => void (t.courses.get('c1')!.pending = { title: 'x' })],
    ['a section marker', (t: ReturnType<typeof setup>) => void (t.sections.get('s1')!.pending_state = 'removed')],
    ['a section override', (t: ReturnType<typeof setup>) => void (t.sections.get('s1')!.pending = { title: 'x' })],
    ['a lesson marker', (t: ReturnType<typeof setup>) => void (t.lessons.get('l2')!.pending_state = 'added')],
    ['a lesson override', (t: ReturnType<typeof setup>) => void (t.lessons.get('l1')!.pending = { summary: 'x' })],
    [
      'a pending note',
      (t: ReturnType<typeof setup>) =>
        void t.knowledge.rows.push({ id: 'k2', course_id: 'c1', source: 'notes', title: 'N', chunk_index: 0, text: 'n', state: 'pending' }),
    ],
  ])('is true for %s', async (_label, stage) => {
    const t = setup();
    stage(t);
    await expect(hasStagedRows(t.manager, 'c1')).resolves.toBe(true);
  });
});
