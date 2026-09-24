import { aiFallbackNote, clampCourseStructure, COURSE_SOURCE_LIMIT, CourseStructureInput, GroqAiAssessor, MockAiAssessor, outlineHeadings } from './index';

// Same shape web/src/lib/outline-source.ts builds (see its "digest format" test).
const DIGEST = [
  'DOCUMENT OUTLINE (authoritative order):',
  'Chapter 1: Soil',
  '  1.1 Soil types',
  '  1.2 Soil fertility',
  '    1.2.1 Nitrogen',
  'Chapter 2: Water',
  '  2.1 Irrigation',
  'Chapter 3: Crops',
  '',
  'EXCERPTS:',
  '## Chapter 1: Soil',
  'Soil is the living skin of the earth. It feeds every crop.',
  '',
  '## 1.1 Soil types',
  'Ethiopian highlands have vertisols and nitisols. Each needs different care.',
  '',
  '## Chapter 3: Crops',
  'Teff is the staple grain of Ethiopia and grows in many soils.',
].join('\n');

const input = (source_text: string, extra: Partial<CourseStructureInput> = {}): CourseStructureInput => ({
  title: 'Farming basics',
  source_text,
  section_count: 4,
  lessons_per_section: 3,
  ...extra,
});

describe('clampCourseStructure', () => {
  it('trims titles, drops ones under 2 chars and caps title/summary lengths', () => {
    const [section, ...rest] = clampCourseStructure([
      {
        title: '  Getting   started  ',
        is_free_preview: false,
        lessons: [{ title: 'x' }, { title: ' Basics ', summary: `  ${'s'.repeat(600)}  ` }, { title: 'L'.repeat(200), summary: '   ' }, { title: 42 }],
      },
      { title: 'A', lessons: [{ title: 'Orphan lesson' }] },
    ]);
    expect(rest).toEqual([]);
    expect(section.title).toBe('Getting started');
    expect(section.lessons).toEqual([
      { title: 'Basics', summary: 's'.repeat(500) },
      { title: 'L'.repeat(160) },
    ]);
  });

  it('keeps at most 12 sections of 12 lessons, with only the first as free preview', () => {
    const many = Array.from({ length: 20 }, (_, s) => ({
      title: `Section ${s + 1}`,
      is_free_preview: true,
      lessons: Array.from({ length: 20 }, (_, l) => ({ title: `Lesson ${l + 1}` })),
    }));
    const out = clampCourseStructure(many);
    expect(out).toHaveLength(12);
    expect(out.every((s) => s.lessons.length === 12)).toBe(true);
    expect(out.map((s) => s.is_free_preview)).toEqual([true, ...Array(11).fill(false)]);
  });

  it('marks the first surviving section free even when the model did not', () => {
    expect(clampCourseStructure([{ title: '', lessons: [] }, { title: 'Real one', is_free_preview: false }])).toEqual([
      { title: 'Real one', is_free_preview: true, lessons: [] },
    ]);
  });

  it('tolerates malformed model output', () => {
    expect(clampCourseStructure(null)).toEqual([]);
    expect(clampCourseStructure({ title: 'not an array' })).toEqual([]);
    expect(clampCourseStructure([null, 'x', { title: 'Ok section', lessons: 'nope' }])).toEqual([{ title: 'Ok section', is_free_preview: true, lessons: [] }]);
  });
});

describe('outlineHeadings', () => {
  it('reads the digest outline block with levels from indentation', () => {
    expect(outlineHeadings(DIGEST)).toEqual([
      { title: 'Chapter 1: Soil', level: 1 },
      { title: '1.1 Soil types', level: 2 },
      { title: '1.2 Soil fertility', level: 2 },
      { title: '1.2.1 Nitrogen', level: 3 },
      { title: 'Chapter 2: Water', level: 1 },
      { title: '2.1 Irrigation', level: 2 },
      { title: 'Chapter 3: Crops', level: 1 },
    ]);
  });

  it('finds heading-shaped lines in pasted notes, but not prose', () => {
    const notes = ['# Soil', 'Soil feeds crops.', '## Soil types', 'section 3 of the law applies to farmers', '2 cups of water per seedling', 'ምዕራፍ 2፡ ውሃ', '3.1 Irrigation methods'].join('\n');
    expect(outlineHeadings(notes)).toEqual([
      { title: 'Soil', level: 1 },
      { title: 'Soil types', level: 2 },
      { title: 'ምዕራፍ 2፡ ውሃ', level: 2 },
      { title: '3.1 Irrigation methods', level: 3 },
    ]);
  });

  it('parses markdown headings: closing hashes dropped, a trailing # of a name kept', () => {
    const notes = ['## Soil ##', '### Water\t#', '# Intro to C#', '## F# basics', '# #', '####### Seven hashes', '#NoSpace', `# ${'x'.repeat(200)}`, `# ${'y'.repeat(150)}`].join('\n');
    expect(outlineHeadings(notes)).toEqual([
      { title: 'Soil', level: 2 },
      { title: 'Water', level: 3 },
      { title: 'Intro to C#', level: 1 },
      { title: 'F# basics', level: 2 },
      // Over 200 chars is prose, not a heading; 152 chars is still a heading.
      { title: 'y'.repeat(150), level: 1 },
    ]);
  });
});

/**
 * Regression for a ReDoS: `/^(#{1,6})\s+(.+?)\s*#*$/` took about 3.5 s on the
 * first input below, and grouping a digest whose numbering alternates took
 * about 3 s. Both run synchronously in the course service, so that blocked
 * every request it serves. Each input here targets one pattern or loop in
 * the outline path; all are at the 30,000-char size GenerateStructureDto accepts.
 */
describe('outline generation on hostile input', () => {
  const mock = new MockAiAssessor();
  const N = 29_990;
  const timed = async (source_text: string) => {
    const t0 = performance.now();
    const result = await mock.generateCourseStructure(input(source_text));
    return { ms: performance.now() - t0, result };
  };
  const repeatLines = (line: string, budget = N) => Array.from({ length: Math.floor(budget / (line.length + 1)) }, () => line).join('\n');

  it.each([
    ['markdown: word, space run, word', `# a${' '.repeat(N)}b`],
    ['markdown: word, tab run, word', `# a${'\t'.repeat(N)}x`],
    ['markdown: alternating " #"', `# a${' #'.repeat(N / 2)}b`],
    ['markdown: many 200-char lines', repeatLines(`# a${' '.repeat(195)}b`)],
    ['numbered heading: one long line', `1.1 A${' '.repeat(N)},`],
    // Comma mid-line makes `[^,]*$` fail and backtrack; a lowercase title makes `\s+` backtrack.
    ['numbered heading: many 100-char lines', repeatLines(`1.1 A${' '.repeat(46)},${' '.repeat(46)}x\n1.1${' '.repeat(95)}a`)],
    ['keyword heading: one long line', `Chapter${' '.repeat(N)}.`],
    ['keyword heading: many 100-char lines', repeatLines(`Chapter 1${' '.repeat(90)}x`)],
    ['excerpt sentence: no sentence end', `DOCUMENT OUTLINE\nA\nB\n\nEXCERPTS:\n## A\n${'a'.repeat(N)}`],
    ['excerpt sentence: dots without spaces', `DOCUMENT OUTLINE\nA\nB\n\nEXCERPTS:\n## A\n${'.a'.repeat(N / 2)}`],
    ['digest outline: indented markdown line', `DOCUMENT OUTLINE\nA\n#${' '.repeat(N)}x\nB`],
    // Two sub-sections sharing a 5,900-word ending: the implied chapter's name scan.
    ['implied chapter name: long shared suffix', `DOCUMENT OUTLINE\n1.1 a ${'w '.repeat(5900)}\n1.2 b ${'w '.repeat(5900)}\n2.1 c`],
  ])('%s finishes in under 50 ms', async (_name, source) => {
    const { ms, result } = await timed(source);
    expect(result.sections.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(50);
  });

  it.each([
    ['digest with alternating chapter numbers', `DOCUMENT OUTLINE\n${repeatLines('1.1 A\n2.1 A', 24_000)}`],
    ['digest with thousands of flat headings', `DOCUMENT OUTLINE\n${repeatLines('xy', 24_000)}`],
    ['notes with alternating numbered headings', repeatLines('1.1 Abc\n2.1 Abc', 24_000)],
  ])('%s is linear (well under the seconds it used to take)', async (_name, source) => {
    // Looser bound than above: these build thousands of headings and the first
    // run includes JIT warm-up, but the old quadratic code took 1.5-3 s.
    const { ms, result } = await timed(source);
    expect(result.sections).toHaveLength(12);
    expect(ms).toBeLessThan(250);
  });

  it('reads no further than COURSE_SOURCE_LIMIT, like the model', async () => {
    const source = `# One\n# Two\n${`${'filler '.repeat(20)}\n`.repeat(Math.ceil(COURSE_SOURCE_LIMIT / 141))}# Three`;
    expect(source.indexOf('# Three')).toBeGreaterThan(COURSE_SOURCE_LIMIT);
    const { sections } = await mock.generateCourseStructure(input(source));
    expect(sections.map((s) => s.title)).toEqual(['One', 'Two']);
  });
});

describe('MockAiAssessor.generateCourseStructure', () => {
  const mock = new MockAiAssessor();

  it('builds sections and lessons from the DOCUMENT OUTLINE headings', async () => {
    const { sections } = await mock.generateCourseStructure(input(DIGEST));
    expect(sections.map((s) => [s.title, s.lessons.map((l) => l.title)])).toEqual([
      ['Chapter 1: Soil', ['1.1 Soil types', '1.2 Soil fertility']],
      ['Chapter 2: Water', ['2.1 Irrigation']],
      ['Chapter 3: Crops', ['Chapter 3: Crops']],
    ]);
    expect(sections.map((s) => s.is_free_preview)).toEqual([true, false, false]);
  });

  it('uses the first sentence of a heading’s excerpt as the lesson summary', async () => {
    const { sections } = await mock.generateCourseStructure(input(DIGEST));
    expect(sections[0].lessons[0]).toEqual({ title: '1.1 Soil types', summary: 'Ethiopian highlands have vertisols and nitisols.' });
    expect(sections[2].lessons[0].summary).toBe('Teff is the staple grain of Ethiopia and grows in many soils.');
    expect(sections[1].lessons[0].summary).toBeUndefined();
  });

  it('groups consecutive chapters when there are more than the requested sections', async () => {
    const outline = ['DOCUMENT OUTLINE (authoritative order):', ...Array.from({ length: 10 }, (_, i) => `Chapter ${i + 1}`)].join('\n');
    const { sections } = await mock.generateCourseStructure(input(outline, { section_count: 4 }));
    expect(sections).toHaveLength(4);
    expect(sections[0].title).toBe('Chapter 1 & Chapter 2');
    expect(sections.flatMap((s) => s.lessons.map((l) => l.title))).toEqual(Array.from({ length: 10 }, (_, i) => `Chapter ${i + 1}`));
  });

  it('names merged sections without numbering and keeps their topics as lessons', async () => {
    const outline = ['DOCUMENT OUTLINE (authoritative order):', '1 Soil', '  1.1 Soil types', '2 Water', '  2.1 Irrigation', '3 Crops', '4 Markets'].join('\n');
    const { sections } = await mock.generateCourseStructure(input(outline, { section_count: 2 }));
    expect(sections.map((s) => [s.title, s.lessons.map((l) => l.title)])).toEqual([
      ['Soil & Water', ['1.1 Soil types', '2.1 Irrigation']],
      ['Crops & Markets', ['3 Crops', '4 Markets']],
    ]);
  });

  it('infers chapters from a flat list of numbered sub-section bookmarks', async () => {
    const flat = ['DOCUMENT OUTLINE (authoritative order):'];
    for (const [n, name] of [[1, 'Digital Marketing'], [2, 'Your Customer'], [3, 'Social Media'], [4, 'Email Marketing']] as const) {
      for (let t = 1; t <= 3; t++) flat.push(`${n}.${t} Topic ${t} of ${name}`);
    }
    const { sections } = await mock.generateCourseStructure(input(flat.join('\n'), { section_count: 2 }));
    expect(sections.map((s) => s.title)).toEqual(['Digital Marketing & Your Customer', 'Social Media & Email Marketing']);
    expect(sections[0].lessons.map((l) => l.title)).toEqual([
      '1.1 Topic 1 of Digital Marketing', '1.2 Topic 2 of Digital Marketing', '1.3 Topic 3 of Digital Marketing',
      '2.1 Topic 1 of Your Customer', '2.2 Topic 2 of Your Customer', '2.3 Topic 3 of Your Customer',
    ]);
    const perChapter = await mock.generateCourseStructure(input(flat.join('\n'), { section_count: 4 }));
    expect(perChapter.sections.map((s) => s.title)).toEqual(['Digital Marketing', 'Your Customer', 'Social Media', 'Email Marketing']);
  });

  it('outlines under a lone document-title heading and skips a heading equal to the course title', async () => {
    const outline = ['DOCUMENT OUTLINE (authoritative order):', 'Farming Handbook', '  Chapter 1 Soil', '    Soil types', '  Chapter 2 Water'].join('\n');
    const { sections } = await mock.generateCourseStructure(input(outline));
    expect(sections.map((s) => s.title)).toEqual(['Chapter 1 Soil', 'Chapter 2 Water']);
    const titled = ['DOCUMENT OUTLINE (authoritative order):', 'Farming basics', 'Chapter 1 Soil', 'Chapter 2 Water'].join('\n');
    expect((await mock.generateCourseStructure(input(titled))).sections.map((s) => s.title)).toEqual(['Chapter 1 Soil', 'Chapter 2 Water']);
  });

  it('uses heading lines of pasted notes, including Amharic chapter headings', async () => {
    const notes = ['ምዕራፍ 1፡ አፈር', 'አፈር ሰብልን ይመግባል።', 'ምዕራፍ 2፡ ውሃ', 'ውሃ ለሰብል አስፈላጊ ነው።'].join('\n');
    const { sections } = await mock.generateCourseStructure(input(notes));
    expect(sections.map((s) => s.title)).toEqual(['ምዕራፍ 1፡ አፈር', 'ምዕራፍ 2፡ ውሃ']);
  });

  it('keeps the numbered placeholder outline when the text has no headings', async () => {
    const { sections } = await mock.generateCourseStructure(input('Just a paragraph of notes without any structure at all.', { section_count: 2, lessons_per_section: 2 }));
    expect(sections.map((s) => s.title)).toEqual(['Section 1: Farming basics — part 1', 'Section 2: Farming basics — part 2']);
    expect(sections[0].lessons.map((l) => l.title)).toEqual(['Lesson 1.1', 'Lesson 1.2']);
  });

  it('says whether the draft came from the headings or is a placeholder', async () => {
    expect((await mock.generateCourseStructure(input(DIGEST))).origin).toBe('headings');
    expect((await mock.generateCourseStructure(input('Unstructured notes only.'))).origin).toBe('placeholder');
    expect((await mock.generateCourseStructure(input(''))).origin).toBe('placeholder');
  });

  describe('never drops chapters silently', () => {
    const chapters = (n: number) => Array.from({ length: n }, (_, i) => `Topic ${i + 1} overview`);
    const digestOf = (lines: string[]) => ['DOCUMENT OUTLINE (authoritative order):', ...lines].join('\n');
    const allLessons = (sections: { lessons: { title: string }[] }[]) => sections.flatMap((s) => s.lessons.map((l) => l.title));

    it('adds sections past the requested count so every chapter fits (40 chapters, 3 sections)', async () => {
      const { sections } = await mock.generateCourseStructure(input(digestOf(chapters(40)), { section_count: 3 }));
      expect(sections).toHaveLength(4);
      expect(sections.every((s) => s.lessons.length <= 12)).toBe(true);
      expect(allLessons(sections)).toEqual(chapters(40));
      expect(sections[0].title).toBe('Topic 1 overview – Topic 10 overview');
    });

    it('keeps all 60 chapters of a 4-section request', async () => {
      const { sections } = await mock.generateCourseStructure(input(digestOf(chapters(60)), { section_count: 4 }));
      expect(sections).toHaveLength(5);
      expect(allLessons(sections)).toEqual(chapters(60));
    });

    it('keeps a chapter without sub-headings that shares a section with ones that have them', async () => {
      const outline = digestOf(['1 Soil', '  1.1 Soil types', '2 Water', '3 Crops', '  3.1 Teff', '4 Markets']);
      const { sections } = await mock.generateCourseStructure(input(outline, { section_count: 2 }));
      expect(sections.map((s) => [s.title, s.lessons.map((l) => l.title)])).toEqual([
        ['Soil & Water', ['1.1 Soil types', '2 Water']],
        ['Crops & Markets', ['3.1 Teff', '4 Markets']],
      ]);
    });

    it('continues a chapter with more than 12 topics in "(part n)" sections', async () => {
      const subs = Array.from({ length: 20 }, (_, i) => `Sub ${i + 1}`);
      const outline = digestOf(['Chapter A', ...subs.map((s) => `  ${s}`), 'Chapter B', '  Sub B1']);
      const { sections } = await mock.generateCourseStructure(input(outline));
      expect(sections.map((s) => [s.title, s.lessons.length])).toEqual([
        ['Chapter A (part 1)', 10],
        ['Chapter A (part 2)', 10],
        ['Chapter B', 1],
      ]);
      expect(allLessons(sections)).toEqual([...subs, 'Sub B1']);
      expect(sections.map((s) => s.is_free_preview)).toEqual([true, false, false]);
    });

    it('past 144 chapters, names each section only after the chapters it kept', async () => {
      const { sections } = await mock.generateCourseStructure(input(digestOf(chapters(150))));
      expect(sections).toHaveLength(12);
      for (const s of sections) {
        expect(s.lessons.length).toBeLessThanOrEqual(12);
        expect(s.title).toBe(`${s.lessons[0].title} – ${s.lessons[s.lessons.length - 1].title}`);
      }
    });
  });
});

describe('aiFallbackNote', () => {
  const auth = { reason: 'auth' };
  const limited = { reason: 'rate_limit' };
  const timeout = { reason: 'timeout' };

  it('keeps the placeholder-questions wording by default', () => {
    expect(aiFallbackNote(auth)).toBe('The AI service rejected the API key (expired or invalid) — an admin needs to rotate GROQ_API_KEY. Showing placeholder questions you can edit.');
    expect(aiFallbackNote(limited)).toBe('The AI service is rate-limited right now — showing placeholder questions. Try again in a minute.');
    expect(aiFallbackNote(new Error('boom'))).toBe('AI generation was unavailable — showing placeholder questions. Edit them or try again.');
    expect(aiFallbackNote(undefined, 'questions')).toBe(aiFallbackNote(undefined));
  });

  it('talks about a starter outline for outlines', () => {
    for (const err of [auth, limited, timeout, new Error('boom')]) {
      const note = aiFallbackNote(err, 'outline');
      expect(note).toMatch(/showing a starter outline you can edit/i);
      expect(note).not.toMatch(/questions/);
    }
    expect(aiFallbackNote(auth, 'outline')).toMatch(/rotate GROQ_API_KEY/);
  });

  it('explains a timeout', () => {
    expect(aiFallbackNote(timeout, 'outline')).toBe('The AI service took too long to answer — showing a starter outline you can edit. Try again, or send a shorter source text.');
  });
});

describe('GroqAiAssessor', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const reply = (content: unknown) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }), text: async () => '' });
  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body) as { messages: { role: string; content: string }[] };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it('bounds every request with an abort signal', async () => {
    fetchMock.mockResolvedValue(reply({ questions: [{ prompt: 'Q?', options: ['a', 'b'], correct_index: 1 }] }));
    await new GroqAiAssessor().generateQuiz('Soil', 1);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('classifies a timed-out request as reason "timeout"', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const err = await new GroqAiAssessor().generateQuiz('Soil', 1).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'timeout', message: 'Groq request timed out after 25s' });
  });

  it('still classifies an expired key as "auth"', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'Invalid API Key', json: async () => ({}) });
    await expect(new GroqAiAssessor().generateQuiz('Soil', 1)).rejects.toMatchObject({ reason: 'auth', status: 401 });
  });

  it('sends up to 24,000 chars of source with the outline-first instructions, and clamps the reply', async () => {
    fetchMock.mockResolvedValue(
      reply({
        sections: [
          { title: ' Soil ', is_free_preview: false, lessons: [{ title: 'Types', summary: 'x'.repeat(900) }, { title: '' }] },
          { title: 'Water', is_free_preview: true, lessons: [{ title: 'Irrigation', summary: 'How to water.' }] },
        ],
      }),
    );
    const source = `${DIGEST}\n${'more text '.repeat(3000)}`;
    const { sections, origin } = await new GroqAiAssessor().generateCourseStructure(input(source));
    expect(origin).toBe('model');
    const [system, user] = sentBody().messages;
    expect(system.content).toContain('The DOCUMENT OUTLINE is authoritative for order and scope; group chapters into about 4 sections; do not invent topics absent from the material; lesson summaries one sentence.');
    expect(user.content).toContain(source.slice(0, COURSE_SOURCE_LIMIT));
    expect(user.content).not.toContain(source.slice(0, COURSE_SOURCE_LIMIT + 1));
    expect(sections).toEqual([
      { title: 'Soil', is_free_preview: true, lessons: [{ title: 'Types', summary: 'x'.repeat(500) }] },
      { title: 'Water', is_free_preview: false, lessons: [{ title: 'Irrigation', summary: 'How to water.' }] },
    ]);
  });

  it('falls back to the heading-based outline when the model returns nothing usable, and says so', async () => {
    fetchMock.mockResolvedValue(reply({ sections: [{ title: '' }] }));
    const { sections, origin } = await new GroqAiAssessor().generateCourseStructure(input(DIGEST));
    expect(sections.map((s) => s.title)).toEqual(['Chapter 1: Soil', 'Chapter 2: Water', 'Chapter 3: Crops']);
    // Not 'model': the caller must not present this as the AI's reading of the document.
    expect(origin).toBe('headings');
  });

  it('labels the placeholder fallback when the reply has the wrong shape and the text has no headings', async () => {
    fetchMock.mockResolvedValue(reply({ outline: [{ title: 'Soil', lessons: [{ title: 'Types' }] }] }));
    const { sections, origin } = await new GroqAiAssessor().generateCourseStructure(input('Unstructured notes about soil and water.', { section_count: 2 }));
    expect(origin).toBe('placeholder');
    expect(sections.map((s) => s.title)).toEqual(['Section 1: Farming basics — part 1', 'Section 2: Farming basics — part 2']);
  });
});
