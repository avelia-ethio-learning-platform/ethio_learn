import { chunkText, CourseExtrasService } from './course-extras.service';

describe('chunkText (tutor knowledge base)', () => {
  it('returns nothing for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n ')).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    expect(chunkText('Hello world. This is short.')).toEqual(['Hello world. This is short.']);
  });

  it('splits long text at sentence boundaries under the size limit', () => {
    const sentence = 'Variables store values in memory and can be reassigned later in the program. ';
    const text = sentence.repeat(40); // ~3200 chars
    const chunks = chunkText(text, 800);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(800);
      expect(c.endsWith('.')).toBe(true); // never cut mid-sentence
    }
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(text.trim().replace(/\s+/g, ' '));
  });

  it('handles Amharic sentence terminators (።) and paragraphs', () => {
    const am = 'ተማሪዎች ትምህርታቸውን ይማራሉ። መምህራን ያስተምራሉ።';
    const chunks = chunkText(`${am}\n\n${'Next paragraph. '.repeat(3)}`);
    expect(chunks.join(' ')).toContain('።');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('hard-splits a single oversized sentence rather than dropping it', () => {
    const huge = 'x'.repeat(2000);
    const chunks = chunkText(huge, 800);
    expect(chunks.join('')).toHaveLength(2000);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(800);
  });
});

describe('CourseExtrasService staged knowledge and live-only corpus', () => {
  function setup() {
    const repo = () => ({
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(async (x: unknown) => x),
      create: jest.fn((x: object) => x),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    });
    const courses = repo();
    const sections = repo();
    const lessons = repo();
    const changelog = repo();
    const knowledge = repo();
    const chat = repo();
    const internal = { get: jest.fn() };
    const service = new CourseExtrasService(
      courses as never,
      sections as never,
      lessons as never,
      changelog as never,
      knowledge as never,
      chat as never,
      internal as never,
    );
    return { service, courses, sections, lessons, changelog, knowledge };
  }
  const course = { id: 'c1', created_by: 'edu1', owner_id: 'edu1', status: 'published', title: 'Go', description: 'Learn Go' };

  it('a pending note replaces only an earlier pending upload of the same title', async () => {
    const h = setup();
    const res = await h.service.addKnowledge(course as never, ' Week 1 ', 'Goroutines are cheap threads. Channels connect them.', 'pending');
    expect(res).toEqual({ title: 'Week 1', chunks: 1, state: 'pending' });
    expect(h.knowledge.delete).toHaveBeenCalledWith({ course_id: 'c1', source: 'notes', title: 'Week 1', state: 'pending' });
    expect(h.knowledge.save).toHaveBeenCalledWith([expect.objectContaining({ title: 'Week 1', state: 'pending', chunk_index: 0 })]);
  });

  it('pendingKnowledge groups chunks per document with a short excerpt', async () => {
    const h = setup();
    h.knowledge.find.mockResolvedValueOnce([
      { title: 'A', text: 'a'.repeat(300), chunk_index: 0 },
      { title: 'A', text: 'b'.repeat(300), chunk_index: 1 },
      { title: 'B', text: 'short', chunk_index: 0 },
    ]);
    const docs = await h.service.pendingKnowledge('c1');
    expect(h.knowledge.find).toHaveBeenCalledWith(expect.objectContaining({ where: { course_id: 'c1', state: 'pending' } }));
    expect(docs).toEqual([
      { title: 'A', chars: 600, excerpt: `${'a'.repeat(300)} ${'b'.repeat(99)}` },
      { title: 'B', chars: 5, excerpt: 'short' },
    ]);
  });

  it('reindexCourse indexes the live outline only', async () => {
    const h = setup();
    h.courses.findOne.mockResolvedValueOnce(course);
    h.sections.find.mockResolvedValueOnce([
      { id: 's1', title: 'Basics', pending_state: null },
      { id: 's2', title: 'Staged section', pending_state: 'added' },
    ]);
    h.lessons.find.mockResolvedValueOnce([
      { id: 'l1', title: 'Variables', summary: 'Storing values', pending_state: null, pending: { title: 'Staged rename' } },
      { id: 'l2', title: 'Staged lesson', summary: null, pending_state: 'added' },
      { id: 'l3', title: 'Loops', summary: null, pending_state: 'removed' },
    ]);
    await h.service.reindexCourse('c1');
    const texts = (h.knowledge.save.mock.calls[0][0] as { text: string }[]).map((r) => r.text);
    expect(texts).toEqual(['Go. Learn Go', 'Basics — Variables. Storing values', 'Basics — Loops.']);
    expect(h.lessons.find).toHaveBeenCalledTimes(1);
  });
});

describe('CourseExtrasService.deleteKnowledge', () => {
  type Note = { course_id: string; source: string; title: string; state: 'live' | 'pending'; text: string };
  function setup(notes: Note[]) {
    const rows = [...notes];
    const knowledge = {
      delete: jest.fn(async (where: Partial<Note>) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (Object.entries(where).every(([k, v]) => rows[i][k as keyof Note] === v)) rows.splice(i, 1);
        }
        return { affected: before - rows.length };
      }),
    };
    const none = {};
    const service = new CourseExtrasService(none as never, none as never, none as never, none as never, knowledge as never, none as never, none as never);
    return { service, rows };
  }
  const note = (title: string, state: 'live' | 'pending', course_id = 'c1', source = 'notes'): Note => ({ course_id, source, title, state, text: `${title} ${state}` });

  it('on a live course, removing a title whose re-upload is pending removes only the pending copy', async () => {
    const h = setup([note('Syllabus', 'live'), note('Syllabus', 'pending'), note('Syllabus', 'live', 'c2')]);
    await expect(h.service.deleteKnowledge('c1', 'Syllabus', true)).resolves.toEqual({ deleted: 1, state: 'pending' });
    expect(h.rows.map((r) => r.text)).toEqual(['Syllabus live', 'Syllabus live']);
    // Asked again, the approved note is what is left, and it goes at once (tutor reference, not course content).
    await expect(h.service.deleteKnowledge('c1', 'Syllabus', true)).resolves.toEqual({ deleted: 1, state: 'live' });
    expect(h.rows).toEqual([note('Syllabus', 'live', 'c2')]);
  });

  it('an explicit state removes only that copy, even when the other one exists', async () => {
    const h = setup([note('Syllabus', 'live'), note('Syllabus', 'pending')]);
    await expect(h.service.deleteKnowledge('c1', 'Syllabus', true, 'live')).resolves.toEqual({ deleted: 1, state: 'live' });
    expect(h.rows).toEqual([note('Syllabus', 'pending')]);
    // A stale list asking for a copy that is already gone removes nothing else.
    await expect(h.service.deleteKnowledge('c1', 'Syllabus', true, 'live')).resolves.toEqual({ deleted: 0, state: 'live' });
    expect(h.rows).toHaveLength(1);
  });

  it('never touches the automatic corpus, and reports a title that does not exist', async () => {
    const h = setup([note('Course overview', 'live', 'c1', 'description')]);
    await expect(h.service.deleteKnowledge('c1', 'Course overview', true)).resolves.toEqual({ deleted: 0, state: null });
    expect(h.rows).toHaveLength(1);
  });

  it('on a draft every note is live and the title alone identifies it', async () => {
    const h = setup([note('Syllabus', 'live'), note('Other', 'live')]);
    await expect(h.service.deleteKnowledge('c1', 'Syllabus', false)).resolves.toEqual({ deleted: 1, state: 'live' });
    expect(h.rows.map((r) => r.title)).toEqual(['Other']);
  });
});
