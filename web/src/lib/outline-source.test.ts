import { describe, expect, it } from 'vitest';
import type { ExtractBlock, ExtractResult, OutlineEntry } from './extract-text';
import {
  buildDigest,
  DIGEST_BUDGET_CHARS,
  estimateTokens,
  EXCERPTS_HEADER,
  fitsDigestBudget,
  isPageNumber,
  OPENING_LABEL,
  OUTLINE_HEADER,
  trimToSentence,
} from './outline-source';

const para = (text: string, extra: Partial<ExtractBlock> = {}): ExtractBlock => ({ kind: 'para', text, ...extra });
const heading = (text: string, level: number): ExtractBlock => ({ kind: 'heading', text, level });

function doc(blocks: ExtractBlock[], outline: OutlineEntry[] = []): ExtractResult {
  const fullText = blocks.map((b) => b.text).join('\n');
  const pages = blocks.reduce((n, b) => Math.max(n, b.page ?? 0), 0);
  return { blocks, outline, pages, chars: fullText.length, fullText };
}

const sentences = (topic: string, n: number) => Array.from({ length: n }, (_, i) => `${topic} point ${i + 1} is explained here in plain words.`);

/** The outline block's lines (without the header). */
function outlineOf(digest: string): string[] {
  const block = digest.split(`\n\n${EXCERPTS_HEADER}`)[0];
  expect(block.startsWith(`${OUTLINE_HEADER}\n`)).toBe(true);
  return block.split('\n').slice(1);
}

/** Excerpt text keyed by its "## label" line. */
function excerptsOf(digest: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = digest.split(`${EXCERPTS_HEADER}\n`)[1] ?? '';
  for (const chunk of body.split('\n\n')) {
    const [label, ...rest] = chunk.split('\n');
    if (label.startsWith('## ')) out.set(label.slice(3), rest.join('\n'));
  }
  return out;
}

/**
 * A paginated PDF-like document: every page has a running header and a page
 * number footer; `pages[i]` lists that page's heading/body lines.
 */
function pdfDoc(pages: { text: string; size: number }[][], opts: { header?: string; footer?: (p: number) => string } = {}): ExtractResult {
  const blocks: ExtractBlock[] = [];
  pages.forEach((lines, i) => {
    const page = i + 1;
    let y = 800;
    if (opts.header) blocks.push(para(opts.header, { page, size: 9, y }));
    for (const line of lines) {
      y -= line.size * 1.9;
      blocks.push(para(line.text, { page, size: line.size, y }));
    }
    blocks.push(para(opts.footer ? opts.footer(page) : String(page), { page, size: 9, y: 30 }));
  });
  return doc(blocks);
}

const body = (topic: string, n = 6) => sentences(topic, n).map((text) => ({ text, size: 11 }));

describe('estimateTokens', () => {
  it('counts ASCII at ~4 chars per token and other scripts at ~1.5', () => {
    expect(estimateTokens('abcd'.repeat(10))).toBe(10);
    expect(estimateTokens('ሰላም')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('fitsDigestBudget', () => {
  it('matches what the model reads: 24,000 characters (COURSE_SOURCE_LIMIT), not the 30,000 the API accepts', () => {
    expect(DIGEST_BUDGET_CHARS).toBe(24_000);
    expect(fitsDigestBudget('a'.repeat(24_000))).toBe(true);
    expect(fitsDigestBudget('a'.repeat(24_001))).toBe(false);
  });

  it('also holds Ge’ez text to the 6,000-token estimate, far below 24,000 characters', () => {
    expect(fitsDigestBudget('ሰ'.repeat(9_000))).toBe(true);
    expect(fitsDigestBudget('ሰ'.repeat(9_002))).toBe(false);
  });
});

describe('trimToSentence', () => {
  it('cuts at the last sentence end that keeps at least half', () => {
    const text = 'First sentence here. Second one follows. Third is long enough to be cut off somewhere.';
    expect(trimToSentence(text, 45)).toBe('First sentence here. Second one follows.');
    expect(trimToSentence(text, 500)).toBe(text);
  });

  it('falls back to a word boundary with an ellipsis, never exceeding the limit', () => {
    const cut = trimToSentence('no sentence end in this rather long line of words at all', 30);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(30);
  });

  it('treats the Amharic full stop as a sentence end', () => {
    expect(trimToSentence('ይህ የመጀመሪያው ዓረፍተ ነገር ነው። ይህ ሁለተኛው ደግሞ ረጅም ነው።', 30)).toBe('ይህ የመጀመሪያው ዓረፍተ ነገር ነው።');
  });
});

describe('isPageNumber', () => {
  it.each(['12', '- 12 -', 'Page 3 of 10', '3/10', 'xiv', 'ገጽ 4'])('%s is page furniture', (t) => expect(isPageNumber(t)).toBe(true));
  it.each(['Chapter 12', 'mid', 'civil', '2024 budget', 'I am'])('%s is not', (t) => expect(isPageNumber(t)).toBe(false));
});

describe('buildDigest — headings from PDF bookmarks', () => {
  const blocks = [
    para('Contents', { page: 1, size: 11 }),
    para('Chapter 1 Cells 2', { page: 1, size: 11 }),
    para('Part I Basics', { page: 2, size: 20 }),
    para('Chapter 1 Cells', { page: 2, size: 16 }),
    ...sentences('Cells', 5).map((t) => para(t, { page: 2, size: 11 })),
    para('Chapter 2 Tissues', { page: 3, size: 16 }),
    ...sentences('Tissues', 5).map((t) => para(t, { page: 3, size: 11 })),
  ];
  const outline: OutlineEntry[] = [
    { title: 'Contents', level: 1, page: 1 },
    { title: 'Part I Basics', level: 1, page: 2 },
    { title: 'Chapter 1 Cells', level: 2, page: 2 },
    { title: 'A detail four levels down', level: 4, page: 2 },
    { title: 'Chapter 2 Tissues', level: 2, page: 3 },
  ];

  it('uses the bookmark tree (depth ≤ 3, apparatus left out) as the authoritative outline', () => {
    const d = buildDigest(doc(blocks, outline));
    expect(outlineOf(d.digest)).toEqual(['Part I Basics', '  Chapter 1 Cells', '  Chapter 2 Tissues']);
    expect(d.headings).toBe(3);
    expect(d.truncated).toBe(false);
  });

  it('puts each bookmark’s own page text under it, and skips front matter', () => {
    const ex = excerptsOf(buildDigest(doc(blocks, outline)).digest);
    expect(ex.get('Chapter 1 Cells')).toContain('Cells point 1 is explained');
    expect(ex.get('Chapter 1 Cells')).not.toContain('Tissues');
    expect(ex.get('Chapter 2 Tissues')).toContain('Tissues point 5');
    expect(ex.has(OPENING_LABEL)).toBe(false);
    // The heading line itself is not repeated as body text.
    expect(ex.get('Chapter 2 Tissues')!.startsWith('Tissues point 1')).toBe(true);
  });

  it('falls back to page text headings when there are fewer than 3 bookmarks', () => {
    const d = buildDigest(doc(blocks, outline.slice(1, 3)));
    expect(outlineOf(d.digest)).toEqual(['Part I Basics', '  Chapter 1 Cells', '  Chapter 2 Tissues']);
  });

  it('still lists bookmarks it cannot place in the text, with evenly spaced excerpts', () => {
    const long = Array.from({ length: 400 }, (_, i) => para(`Line ${i} talks about unplaced topics in detail.`, { page: 1 + Math.floor(i / 40), size: 11 }));
    const d = buildDigest(doc(long, [{ title: 'Alpha', level: 1 }, { title: 'Beta', level: 1 }, { title: 'Gamma', level: 1 }]), { budgetChars: 6000 });
    expect(outlineOf(d.digest)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(d.digest).toContain('[Beginning]');
    expect(d.digest).toMatch(/\[Excerpt 1\/\d+ ~\d+%\]/);
    expect(d.digest.length).toBeLessThanOrEqual(6000);
  });
});

describe('buildDigest — font-size headings', () => {
  const pages = [
    [{ text: 'Chapter 1: Networks', size: 18 }, ...body('Networks'), { text: '1.1 Addressing', size: 14 }, ...body('Addressing')],
    [...body('More addressing'), { text: '1.2 Routing', size: 14 }, ...body('Routing')],
    [{ text: 'Chapter 2: Security', size: 18 }, ...body('Security')],
    [{ text: '2.1 Threats', size: 14 }, ...body('Threats')],
    [...body('Threat models')],
  ];
  const result = pdfDoc(pages, { header: 'Networking Lecture Notes — Draft', footer: (p) => `Page ${p} of 5` });

  it('detects headings by size and nests them by size rank', () => {
    const d = buildDigest(result);
    expect(outlineOf(d.digest)).toEqual(['Chapter 1: Networks', '  1.1 Addressing', '  1.2 Routing', 'Chapter 2: Security', '  2.1 Threats']);
  });

  it('drops running headers and page-number footers from outline and excerpts', () => {
    const { digest } = buildDigest(result);
    expect(digest).not.toContain('Lecture Notes');
    expect(digest).not.toMatch(/Page \d of 5/);
    // A body that continues on the next page stays attached to its heading.
    expect(excerptsOf(digest).get('1.1 Addressing')).toContain('More addressing point 1');
  });

  it('keeps "Chapter N" headings that differ only by number (not a running header)', () => {
    const chapters = Array.from({ length: 6 }, (_, i) => [{ text: `Chapter ${i + 1} Topic`, size: 18 }, ...body(`Topic ${i + 1}`)]);
    const d = buildDigest(pdfDoc(chapters, { footer: (p) => `Draft ${p}` }));
    expect(outlineOf(d.digest)).toEqual(chapters.map((_, i) => `Chapter ${i + 1} Topic`));
    expect(d.digest).not.toContain('Draft');
  });

  it('joins a heading label with its title line, but not a document title with the first chapter', () => {
    const blocks = [
      para('Practical Networking', { page: 1, size: 22, y: 740 }),
      para('Chapter 1', { page: 1, size: 22, y: 700 }),
      para('Foundations', { page: 1, size: 22, y: 660 }),
      ...sentences('Foundations', 6).map((t, i) => para(t, { page: 1, size: 11, y: 600 - i * 14 })),
      para('Chapter 2', { page: 2, size: 22, y: 740 }),
      para('Protocols and how they', { page: 2, size: 22, y: 700 }),
      para('work together', { page: 2, size: 22, y: 671 }),
      ...sentences('Protocols', 6).map((t, i) => para(t, { page: 2, size: 11, y: 600 - i * 14 })),
    ];
    expect(outlineOf(buildDigest(doc(blocks)).digest)).toEqual(['Practical Networking', 'Chapter 1 Foundations', 'Chapter 2 Protocols and how they work together']);
  });

  it('keeps table rows that repeat from page to page (only header/footer zones are furniture)', () => {
    const rows = Array.from({ length: 6 }, (_, p) =>
      Array.from({ length: 12 }, (_, r) => ({ text: r % 3 === 0 ? 'Research Fellowship' : `Country ${p}-${r} deadline`, size: 9 })),
    );
    const { digest } = buildDigest(pdfDoc(rows));
    expect(digest.match(/Research Fellowship/g)!.length).toBeGreaterThanOrEqual(12);
  });

  it('ignores a cover-page title tier when the document has chapters to outline', () => {
    const pages6 = [
      [{ text: 'The Networking Handbook', size: 32 }, { text: 'An introduction for new engineers', size: 11 }],
      ...Array.from({ length: 5 }, (_, i) => [{ text: `Chapter ${i + 1} Layer ${i + 1}`, size: 18 }, ...body(`Layer ${i + 1}`)]),
    ];
    const lines = outlineOf(buildDigest(pdfDoc(pages6)).digest);
    expect(lines[0]).toBe('Chapter 1 Layer 1');
    expect(lines).not.toContain('The Networking Handbook');
  });

  it('detects Amharic headings set in a larger font', () => {
    const pages = [
      [{ text: 'ምዕራፍ አንድ፡ የኮምፒውተር መሰረታዊ ነገሮች', size: 18 }, ...['ኮምፒውተር መረጃን የሚያስኬድ መሳሪያ ነው።', 'ሃርድዌር እና ሶፍትዌር ይዟል።'].map((text) => ({ text, size: 11 }))],
      [{ text: 'ምዕራፍ ሁለት፡ ኢንተርኔት', size: 18 }, ...['ኢንተርኔት ኮምፒውተሮችን ያገናኛል።', 'መረጃ በፍጥነት ይተላለፋል።'].map((text) => ({ text, size: 11 }))],
    ];
    const d = buildDigest(pdfDoc(pages));
    expect(outlineOf(d.digest)).toEqual(['ምዕራፍ አንድ፡ የኮምፒውተር መሰረታዊ ነገሮች', 'ምዕራፍ ሁለት፡ ኢንተርኔት']);
    expect(excerptsOf(d.digest).get('ምዕራፍ ሁለት፡ ኢንተርኔት')).toContain('ኢንተርኔት ኮምፒውተሮችን ያገናኛል።');
  });
});

describe('buildDigest — DOCX / markdown heading styles', () => {
  it('uses heading blocks and normalises levels so the top style is level 1', () => {
    const blocks = [
      para('Course notes prepared for first-year students of the agriculture program.'),
      heading('Soil', 2),
      ...sentences('Soil', 3).map((t) => para(t)),
      heading('Soil texture', 3),
      ...sentences('Texture', 3).map((t) => para(t)),
      heading('Water', 2),
      ...sentences('Water', 3).map((t) => para(t)),
    ];
    const d = buildDigest(doc(blocks));
    expect(outlineOf(d.digest)).toEqual(['Soil', '  Soil texture', 'Water']);
    const ex = excerptsOf(d.digest);
    expect(ex.get(OPENING_LABEL)).toContain('first-year students');
    expect(ex.get('Soil')).toContain('Soil point 3');
    expect(ex.get('Soil')).not.toContain('Texture point');
  });
});

describe('buildDigest — heading-shaped lines (plain text)', () => {
  it('recognises Chapter/Unit/numbered and Amharic ምዕራፍ/ክፍል headings, not prose', () => {
    const lines = [
      'Chapter 1: Introduction',
      'section 3 of the act applies to every farmer in the region',
      '1.1 Why it matters',
      '2 cups of water are needed for each seedling',
      ...sentences('Intro', 3),
      'ምዕራፍ 2፡ የአፈር ዓይነቶች',
      ...sentences('Soils', 3),
      'ክፍል 2.1 ሸክላ አፈር',
      ...sentences('Clay', 3),
      '3 Results',
      ...sentences('Results', 3),
    ].map((t) => para(t));
    const d = buildDigest(doc(lines));
    // A bare "3 Results" ranks with chapters; "1.1" and ክፍል (section) one level below.
    expect(outlineOf(d.digest)).toEqual(['Chapter 1: Introduction', '  1.1 Why it matters', 'ምዕራፍ 2፡ የአፈር ዓይነቶች', '  ክፍል 2.1 ሸክላ አፈር', '3 Results']);
  });

  it('does not mistake addresses or repeated table cells for headings', () => {
    const lines = Array.from({ length: 30 }, (_, i) => para(i % 3 === 0 ? '9 Lanark Road, Belgravia' : i % 3 === 1 ? '01 BP 1303' : `Row ${i} of the scholarship table.`));
    const d = buildDigest(doc(lines));
    expect(d.headings).toBe(0);
    expect(d.digest).not.toContain(OUTLINE_HEADER);
  });
});

describe('buildDigest — documents without headings', () => {
  it('returns short unstructured text unchanged', () => {
    const text = sentences('Note', 5);
    const d = buildDigest(doc(text.map((t) => para(t))));
    expect(d.digest).toBe(text.join('\n'));
    expect(d).toMatchObject({ headings: 0, truncated: false });
  });

  it('samples long text in evenly spaced windows that reach the end', () => {
    const long = Array.from({ length: 4000 }, (_, i) => para(`Sentence ${i} describes the material in some detail.`));
    const d = buildDigest(doc(long));
    expect(d.digest.startsWith(`${EXCERPTS_HEADER}\n[Beginning]\n`)).toBe(true);
    const labels = d.digest.match(/\[Excerpt (\d+)\/(\d+) ~(\d+)%\]/g)!;
    const n = Number(labels[0].match(/\/(\d+)/)![1]);
    expect(labels).toHaveLength(n);
    expect(n).toBeGreaterThanOrEqual(15);
    expect(Number(labels[labels.length - 1].match(/~(\d+)%/)![1])).toBeGreaterThanOrEqual(90);
    expect(d.digest).toContain('[Beginning]\nSentence 0 describes');
    expect(d.truncated).toBe(true);
    expect(d.digest.length).toBeLessThanOrEqual(24_000);
  });
});

describe('buildDigest — budget', () => {
  const chapters = (n: number, bodyChars: number, title: (i: number) => string, sentence: (i: number) => string) =>
    Array.from({ length: n }, (_, c) => [
      heading(title(c), 1),
      ...Array.from({ length: Math.ceil(bodyChars / sentence(c).length) }, () => para(sentence(c))),
    ]).flat();

  it('stays within 24k chars and 6k estimated tokens for a long English document', () => {
    const blocks = chapters(40, 8000, (i) => `Chapter ${i + 1} topic`, (i) => `Chapter ${i + 1} content is described in this sentence.`);
    const d = buildDigest(doc(blocks));
    expect(d.digest.length).toBeLessThanOrEqual(24_000);
    expect(d.estTokens).toBeLessThanOrEqual(6000);
    expect(d.estTokens).toBe(estimateTokens(d.digest));
    expect(d.headings).toBe(40);
    // Every chapter is represented, including the last one.
    expect(excerptsOf(d.digest).get('Chapter 40 topic')).toContain('Chapter 40 content');
    expect(d.truncated).toBe(true);
  });

  it('gives Ge’ez-script documents fewer characters for the same token budget', () => {
    const blocks = chapters(12, 10_000, (i) => `ምዕራፍ ${i + 1}`, () => 'ይህ ምዕራፍ ስለ ግብርና እና ስለ አፈር ጥበቃ በዝርዝር ያብራራል።');
    const d = buildDigest(doc(blocks));
    expect(d.estTokens).toBeLessThanOrEqual(6000);
    // ~6000 tokens × 1.5 chars for Ge'ez, plus ASCII spaces and markup.
    expect(d.digest.length).toBeLessThanOrEqual(11_000);
    expect(d.headings).toBe(12);
  });

  it('honours a custom character budget', () => {
    const blocks = chapters(10, 3000, (i) => `Unit ${i + 1}`, (i) => `Unit ${i + 1} explains one more idea clearly.`);
    for (const budgetChars of [2000, 5000, 12_000]) {
      expect(buildDigest(doc(blocks), { budgetChars }).digest.length).toBeLessThanOrEqual(budgetChars);
    }
  });

  it('gives every heading an excerpt of at least ~200 chars, cut at a sentence end', () => {
    const blocks = chapters(60, 3000, (i) => `Topic ${i + 1}`, (i) => `Topic ${i + 1} has a detail worth knowing.`);
    const ex = excerptsOf(buildDigest(doc(blocks)).digest);
    expect(ex.size).toBe(60);
    for (const text of Array.from(ex.values())) {
      expect(text.length).toBeGreaterThanOrEqual(180);
      expect(text.endsWith('.')).toBe(true);
    }
  });

  it('samples the start, middle and end of a body far longer than its share', () => {
    const blocks = [
      heading('Only chapter', 1),
      ...Array.from({ length: 3000 }, (_, i) => para(`Fact ${i} of the only chapter.`)),
      heading('Short chapter', 1),
      para('A short closing chapter.'),
    ];
    const text = excerptsOf(buildDigest(doc(blocks)).digest).get('Only chapter')!;
    expect(text).toContain(' … ');
    expect(text).toMatch(/Fact 29\d\d of the only chapter/);
  });

  it('drops the deepest heading level first when the outline would exceed 40% of the budget', () => {
    const blocks = Array.from({ length: 20 }, (_, c) => [
      heading(`Chapter ${c + 1}`, 1),
      para(`Chapter ${c + 1} overview sentence.`),
      ...Array.from({ length: 20 }, (_, s) => [heading(`Section ${c + 1}.${s + 1} with a fairly long descriptive title`, 2), para('Some section text.')]).flat(),
    ]).flat();
    const d = buildDigest(doc(blocks));
    const lines = outlineOf(d.digest);
    expect(lines).toEqual(Array.from({ length: 20 }, (_, c) => `Chapter ${c + 1}`));
    expect(d.truncated).toBe(true);
  });

  it('thins an oversized flat outline evenly, keeping the start and reaching the end', () => {
    const blocks = Array.from({ length: 800 }, (_, i) => [heading(`Lesson ${i + 1} on a specific topic`, 1), para('Text.')]).flat();
    const d = buildDigest(doc(blocks));
    const lines = outlineOf(d.digest);
    expect(lines.join('\n').length).toBeLessThanOrEqual(24_000 * 0.4);
    expect(lines[0]).toBe('Lesson 1 on a specific topic');
    expect(Number(lines[lines.length - 1].match(/\d+/)![0])).toBeGreaterThan(750);
    expect(d.headings).toBe(lines.length);
  });

  it('returns an empty digest for an empty result', () => {
    expect(buildDigest(doc([]))).toEqual({ digest: '', headings: 0, estTokens: 0, truncated: false });
  });
});

describe('digest format', () => {
  it('indents two spaces per level so the offline outline parser can read it', () => {
    const blocks = [heading('A', 1), para('a.'), heading('B', 2), para('b.'), heading('C', 3), para('c.'), heading('D', 1), para('d.')];
    const lines = outlineOf(buildDigest(doc(blocks)).digest);
    // Single-letter titles are fine for explicit heading styles.
    expect(lines).toEqual(['A', '  B', '    C', 'D']);
  });
});
