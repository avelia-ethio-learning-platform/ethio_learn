// @vitest-environment node
// Node, not happy-dom: pdf.js runs its worker in-process here, the same code
// path the browser runs in a web worker.
import { describe, expect, it } from 'vitest';
import { extractDocument, extractTextFromFile, htmlToBlocks, linesFromTextItems, qualitySample, textQuality, textToBlocks, unreadableWarning } from './extract-text';
import { buildDigest, OUTLINE_HEADER } from './outline-source';

/** A minimal valid PDF: Helvetica text per page and optional bookmarks. */
function buildPdf(pages: string[], bookmarks: { title: string; page: number }[] = []): BlobPart {
  const objs: string[] = [];
  const add = (body: string) => objs.push(body);
  const catalog = add('');
  const pagesId = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = pages.map((content) => {
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`);
  });
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let outlines = '';
  if (bookmarks.length) {
    const root = add('');
    const items = bookmarks.map(() => add(''));
    items.forEach((id, i) => {
      const prev = i > 0 ? ` /Prev ${items[i - 1]} 0 R` : '';
      const next = i < items.length - 1 ? ` /Next ${items[i + 1]} 0 R` : '';
      objs[id - 1] = `<< /Title (${bookmarks[i].title}) /Parent ${root} 0 R${prev}${next} /Dest [${pageIds[bookmarks[i].page - 1]} 0 R /Fit] >>`;
    });
    objs[root - 1] = `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items[items.length - 1]} 0 R /Count ${items.length} >>`;
    outlines = ` /Outlines ${root} 0 R`;
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${outlines} >>`;
  let out = '%PDF-1.4\n';
  const offsets = objs.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // ASCII only, so one byte per character.
  return new Uint8Array(Array.from(out, (c) => c.charCodeAt(0)));
}

const show = (size: number, y: number, text: string) => `BT /F1 ${size} Tf 72 ${y} Td (${text}) Tj ET`;
const pageOf = (title: string, topic: string) =>
  [show(24, 720, title), ...[1, 2, 3, 4].map((n) => show(11, 690 - n * 16, `${topic} fact ${n} is explained in a full sentence here.`))].join('\n');

const pdfFile = (bytes: BlobPart, name = 'notes.pdf') => new File([bytes], name, { type: 'application/pdf' });

const COURSE_PDF = buildPdf(
  [pageOf('Chapter 1 Soil', 'Soil'), pageOf('Chapter 2 Water', 'Water'), pageOf('Chapter 3 Crops', 'Crops')],
  [
    { title: 'Chapter 1 Soil', page: 1 },
    { title: 'Chapter 2 Water', page: 2 },
    { title: 'Chapter 3 Crops', page: 3 },
  ],
);

describe('extractDocument — PDF (pdf.js)', () => {
  it('reads lines with page, font size and bookmarks, reporting progress per page', async () => {
    const progress: [number, number][] = [];
    const r = await extractDocument(pdfFile(COURSE_PDF), { onProgress: (done, total) => progress.push([done, total]) });
    expect(r.warning).toBeUndefined();
    expect(r.pages).toBe(3);
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(r.blocks).toContainEqual(expect.objectContaining({ kind: 'para', text: 'Chapter 2 Water', page: 2, size: 24 }));
    expect(r.blocks).toContainEqual(expect.objectContaining({ text: 'Crops fact 4 is explained in a full sentence here.', page: 3, size: 11 }));
    expect(r.outline).toEqual([
      { title: 'Chapter 1 Soil', level: 1, page: 1 },
      { title: 'Chapter 2 Water', level: 1, page: 2 },
      { title: 'Chapter 3 Crops', level: 1, page: 3 },
    ]);
    expect(r.fullText).toContain('Water fact 1 is explained');
    expect(r.chars).toBe(r.fullText.length);
  });

  it('feeds buildDigest an outline in document order', async () => {
    const d = buildDigest(await extractDocument(pdfFile(COURSE_PDF)));
    expect(d.digest.startsWith(`${OUTLINE_HEADER}\nChapter 1 Soil\nChapter 2 Water\nChapter 3 Crops\n`)).toBe(true);
    expect(d.headings).toBe(3);
  });

  it('warns instead of returning text when the PDF has no text layer', async () => {
    const r = await extractDocument(pdfFile(buildPdf(['', ''])));
    expect(r).toMatchObject({ pages: 2, chars: 0, fullText: '', blocks: [] });
    expect(r.warning).toMatch(/scanned or unreadable/);
  });

  it('explains a damaged file instead of throwing', async () => {
    const r = await extractDocument(pdfFile('this is not a pdf at all'));
    expect(r.warning).toMatch(/not a readable PDF/);
    expect(r.fullText).toBe('');
  });

  it('stops with an AbortError when cancelled mid-way', async () => {
    const ctl = new AbortController();
    const run = extractDocument(pdfFile(COURSE_PDF), { signal: ctl.signal, onProgress: () => ctl.abort() });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  // The quality check after the last page runs on the main thread: a macrotask break before it
  // lets "Reading page n/n…" paint and a Stop click (a later task) land before it starts.
  it('yields to the event loop after the last page, so a Stop clicked then still cancels', async () => {
    const ctl = new AbortController();
    const run = extractDocument(pdfFile(COURSE_PDF), {
      signal: ctl.signal,
      onProgress: (done, total) => done === total && setTimeout(() => ctl.abort(), 0),
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('extractDocument — text formats', () => {
  it('turns markdown headings into heading blocks', async () => {
    const r = await extractDocument(new File(['# Soil\n\nSoil holds water.\n\n## Texture\nSand, silt and clay.'], 'notes.md'));
    expect(r.blocks).toEqual([
      { kind: 'heading', text: 'Soil', level: 1 },
      { kind: 'para', text: 'Soil holds water.' },
      { kind: 'heading', text: 'Texture', level: 2 },
      { kind: 'para', text: 'Sand, silt and clay.' },
    ]);
    expect(r.pages).toBe(0);
  });

  it('reads plain text as-is, including Amharic', async () => {
    const text = 'ምዕራፍ 1፡ መግቢያ\nግብርና የኢትዮጵያ ኢኮኖሚ መሰረት ነው።';
    const r = await extractDocument(new File([text], 'notes.txt', { type: 'text/plain' }));
    expect(r.fullText).toBe(text);
    expect(r.warning).toBeUndefined();
  });

  it('flattens an HTML page to headings and paragraphs', async () => {
    const r = await extractDocument(new File(['<html><head><title>x</title><style>p{}</style></head><body><h2>Intro</h2><p>Hello &amp; welcome</p><script>evil()</script></body></html>'], 'page.html'));
    expect(r.blocks).toEqual([
      { kind: 'heading', text: 'Intro', level: 2 },
      { kind: 'para', text: 'Hello & welcome' },
    ]);
  });

  // Regression: comma-glued cells and minified JSON are not "words", and were refused as scanned.
  it('reads a spreadsheet CSV and minified JSON as-is (the scanned-PDF gate does not apply)', async () => {
    const csv = ['Week,Topic,Reading,Assessment', 'Week 1,Introduction to Marketing,Chapter 1,Quiz 1', 'Week 2,Market Research,Chapter 2,Quiz 2', 'Week 3,Pricing Strategy,Chapter 3,Assignment 1'].join('\n');
    const r = await extractDocument(new File([csv], 'syllabus.csv', { type: 'text/csv' }));
    expect(r.warning).toBeUndefined();
    expect(r.fullText).toBe(csv);

    const json = JSON.stringify({ weeks: [{ week: 1, topic: 'Introduction to Marketing', reading: 'Chapter 1' }, { week: 2, topic: 'Market Research', reading: 'Chapter 2' }] });
    const j = await extractDocument(new File([json], 'plan.json', { type: 'application/json' }));
    expect(j.warning).toBeUndefined();
    expect(j.fullText).toBe(json);
    // The same text inside a PDF would still be judged by the word test.
    expect(textQuality(json).realWords).toBeLessThan(0.5);
  });

  it('refuses unreadable content, old .doc and unknown types with an actionable warning', async () => {
    const junk = await extractDocument(new File(['\u0001\u0002\u0003\uE000\uE001 \uFFFD\uFFFD \u0007\u0008'], 'junk.txt'));
    expect(junk.warning).toMatch(/does not look like text.*paste the text instead/);
    expect(junk.fullText).toBe('');
    expect((await extractDocument(new File(['x'], 'old.doc'))).warning).toMatch(/save it as \.docx or PDF/);
    expect((await extractDocument(new File(['x'], 'slides.key'))).warning).toMatch(/upload a PDF, DOCX or text file/);
  });

  it('keeps the old extractTextFromFile contract', async () => {
    expect(await extractTextFromFile(new File(['Just some notes.'], 'n.txt'))).toEqual({ text: 'Just some notes.' });
    const bad = await extractTextFromFile(new File(['x'], 'a.bin'));
    expect(bad.text).toBe('');
    expect(bad.warning).toBeTruthy();
  });
});

describe('linesFromTextItems', () => {
  const item = (str: string, size: number, y: number, hasEOL = false) => ({ str, dir: 'ltr', transform: [size, 0, 0, size, 72, y], width: 10, height: size, fontName: 'f', hasEOL });

  it('breaks lines on hasEOL and records the dominant font size and baseline', () => {
    const lines = linesFromTextItems(
      [item('A', 30, 700), item('rather long heading text', 18, 700, true), { type: 'beginMarkedContent' }, item('body', 11, 680), item(' line', 11, 680, true), item('tail', 11, 664)],
      4,
    );
    expect(lines).toEqual([
      { kind: 'para', text: 'Arather long heading text', page: 4, size: 18, y: 700 },
      { kind: 'para', text: 'body line', page: 4, size: 11, y: 680 },
      { kind: 'para', text: 'tail', page: 4, size: 11, y: 664 },
    ]);
  });

  it('reads the size from rotated or skewed text matrices', () => {
    const [line] = linesFromTextItems([{ str: 'x', transform: [0, 12, -12, 0, 0, 0], hasEOL: true }], 1);
    expect(line.size).toBe(12);
  });
});

describe('htmlToBlocks (mammoth output)', () => {
  it('keeps h1..h6 levels and splits block elements', () => {
    const html = '<h1>Unit 1</h1><p>Intro <strong>bold</strong> text</p><ul><li>First</li><li>Second</li></ul><h3>Detail</h3><table><tr><td><p>Cell A</p></td><td><p>Cell B</p></td></tr></table><p>&#4608;&#x1208; &lt;ok&gt;</p>';
    expect(htmlToBlocks(html)).toEqual([
      { kind: 'heading', text: 'Unit 1', level: 1 },
      { kind: 'para', text: 'Intro bold text' },
      { kind: 'para', text: 'First' },
      { kind: 'para', text: 'Second' },
      { kind: 'heading', text: 'Detail', level: 3 },
      { kind: 'para', text: 'Cell A' },
      { kind: 'para', text: 'Cell B' },
      { kind: 'para', text: 'ሀለ <ok>' },
    ]);
  });
});

describe('textToBlocks', () => {
  it('only treats # lines as headings in markdown', () => {
    expect(textToBlocks('# Title\nbody', false)).toEqual([{ kind: 'para', text: '# Title' }, { kind: 'para', text: 'body' }]);
    expect(textToBlocks('  ## Title ##\n#nospace', true)).toEqual([{ kind: 'heading', text: 'Title', level: 2 }, { kind: 'para', text: '#nospace' }]);
  });
});

describe('quality gate', () => {
  it('passes real English, Amharic and number-heavy text', () => {
    expect(unreadableWarning('The water cycle moves water between the land, the sea and the air.', 1, 'pdf')).toBeUndefined();
    expect(unreadableWarning('ግብርና የኢትዮጵያ ኢኮኖሚ መሰረት ነው። ገበሬዎች ጤፍ፣ ስንዴ እና ቡና ያመርታሉ።', 1, 'pdf')).toBeUndefined();
    expect(unreadableWarning('Region 2021 2022 2023\nAmhara 1,204 1,310 1,452\nOromia 2,001 2,145 2,300', 1, 'pdf')).toBeUndefined();
  });

  it('flags glyph soup, control characters and near-empty pages', () => {
    expect(textQuality('\u0000\u0003\u0000U\u0000D \uE012\uE013').printable).toBeLessThan(0.9);
    expect(textQuality('Ã©Ã¨Â« Ã¤Â¶Â© Â¬Ã¸Ã¦ Ã¥Ã§Ã').realWords).toBeLessThan(0.5);
    expect(unreadableWarning('Ã©Ã¨Â« Ã¤Â¶Â© Â¬Ã¸Ã¦ Ã¥Ã§Ã', 1, 'pdf')).toMatch(/looks scanned or unreadable/);
    expect(unreadableWarning('Scanned by an app', 12, 'pdf')).toMatch(/looks scanned or unreadable/);
    expect(unreadableWarning('   ', 3, 'pdf')).toMatch(/no text layer/);
  });

  it('judges only PDFs by the word test; other formats only by printable characters', () => {
    const csvRow = 'Week 1,Introduction to Marketing,Chapter 1,Quiz 1\nWeek 2,Market Research,Chapter 2,Quiz 2';
    expect(unreadableWarning(csvRow, 1, 'pdf')).toMatch(/looks scanned or unreadable/);
    expect(unreadableWarning(csvRow, 0, 'text')).toBeUndefined();
    expect(unreadableWarning(csvRow, 0, 'docx')).toBeUndefined();
    expect(unreadableWarning('\u0000\u0003\u0000U\u0000D ', 0, 'docx')).toMatch(/Word file's text could not be read/);
  });

  it('measures a long book on an evenly spread sample of bounded size', () => {
    const good = 'The water cycle moves water between the land, the sea and the air. '.repeat(20_000);
    const sample = qualitySample(good);
    expect(good.length).toBeGreaterThan(1_000_000);
    expect(sample.length).toBeLessThanOrEqual(100_020);
    expect(unreadableWarning(good, 400, 'pdf')).toBeUndefined();
    // Glyph soup from the middle onwards is still caught.
    const soup = 'Ã©Ã¨Â« Ã¤Â¶Â© Â¬Ã¸Ã¦ Ã¥Ã§Ã '.repeat(60_000);
    expect(unreadableWarning(good.slice(0, 200_000) + soup, 400, 'pdf')).toMatch(/looks scanned or unreadable/);
    // Short texts are measured whole.
    expect(qualitySample('short text')).toBe('short text');
  });

  it('never splits a surrogate pair at a sample edge', () => {
    const text = '𝐀'.repeat(150_000);
    expect(textQuality(qualitySample(text)).printable).toBe(1);
  });
});
