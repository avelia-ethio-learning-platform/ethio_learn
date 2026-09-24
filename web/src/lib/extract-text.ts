/**
 * Client-side document reading for the AI course-outline generator.
 *
 * - PDF: pdf.js (pdfjs-dist) reads the text layer, applying the fonts'
 *   ToUnicode maps and CMaps that real producers (Word, Google Docs, Chrome,
 *   LibreOffice) rely on. Parsing runs in pdf.js's web worker, so large books
 *   do not freeze the page.
 * - DOCX: mammoth, which keeps Word heading styles as h1..h6.
 * - Text formats are read as-is.
 *
 * Only a PDF goes through the "looks scanned or unreadable" gate: glyph soup
 * from a font without a ToUnicode map is a PDF problem, while CSV cells or
 * minified JSON are legitimately not "words". Word and text files are only
 * refused when they are not text at all (binary, wrong encoding).
 *
 * Both libraries are npm dependencies served from our own origin (no CDN) and
 * are imported lazily, so they only download when an educator picks a file.
 * The result is structured (lines with page and font size, headings,
 * bookmarks) so outline-source.ts can condense the WHOLE document into a
 * digest the model can see within its budget.
 */

import type { TextItem } from 'pdfjs-dist/types/src/display/api';

export interface ExtractBlock {
  kind: 'heading' | 'para';
  text: string;
  /** Heading depth, 1 = top level (heading blocks only). */
  level?: number;
  /** 1-based page number (PDF only). */
  page?: number;
  /** Dominant font size of the line (PDF only), used to spot headings. */
  size?: number;
  /** Baseline height of the line on its page, larger = higher (PDF only). */
  y?: number;
}

export interface OutlineEntry {
  title: string;
  /** 1 = top level. */
  level: number;
  /** 1-based page the entry points to, when it could be resolved. */
  page?: number;
}

export interface ExtractResult {
  /** Reading-order lines (PDF) or paragraphs/headings (DOCX, text). */
  blocks: ExtractBlock[];
  /** PDF bookmarks, flattened in reading order. Empty for other formats. */
  outline: OutlineEntry[];
  /** Pages read; 0 for formats without pages (DOCX, text). */
  pages: number;
  chars: number;
  warning?: string;
  fullText: string;
}

export interface ExtractOptions {
  /** Called after each PDF page is read: (pages done, pages to read). */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_PDF_PAGES = 1000;
const MAX_OUTLINE_ENTRIES = 2000;
/** Copied from pdfjs-dist into public/ by scripts/copy-pdf-worker.mjs. */
const PDF_WORKER_SRC = '/pdf.worker.min.mjs';

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|html?|json|rtf)$/;
const MARKDOWN_EXT = /\.(md|markdown)$/;
const HTML_EXT = /\.html?$/;

function empty(pages: number, warning: string): ExtractResult {
  return { blocks: [], outline: [], pages, chars: 0, warning, fullText: '' };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Reading the file was cancelled.', 'AbortError');
}

/** A macrotask break, so the page can paint the last progress label and handle a "Stop" click. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

// Built on first use: \p{...} escapes need the regex `u` flag, which the web
// tsconfig's default target rejects in literals (and which very old browsers
// lack, where this should fail only the upload, not the whole page).
let qualityPatterns: { unprintable: RegExp; wordSplit: RegExp; edgePunct: RegExp; letter: RegExp; realWord: RegExp } | undefined;

function patterns() {
  return (qualityPatterns ??= {
    // Control, private-use, lone-surrogate and unassigned code points, plus
    // U+FFFD: what a PDF without usable ToUnicode data (or a mis-decoded file)
    // yields.
    unprintable: new RegExp('[\\p{Cc}\\p{Co}\\p{Cs}\\p{Cn}\\uFFFD]', 'gu'),
    // Ethiopic word space, full stop and other separators split words like
    // whitespace does.
    wordSplit: new RegExp('[\\s\\u1361-\\u1368]+', 'u'),
    edgePunct: new RegExp('^[\\p{P}\\p{S}]+|[\\p{P}\\p{S}]+$', 'gu'),
    letter: new RegExp('\\p{L}', 'u'),
    realWord: new RegExp("^[\\p{L}\\p{M}\\p{N}]+(?:[-'\\u2019._/][\\p{L}\\p{M}\\p{N}]+)*$", 'u'),
  });
}

/**
 * printable: share of non-whitespace characters that are real, assigned
 * characters. realWords: share of letter-bearing tokens that look like words
 * (letters/digits with internal hyphens or apostrophes) rather than glyph
 * soup. Number-only tokens are neutral so tables of figures do not fail.
 */
export function textQuality(text: string): { printable: number; realWords: number } {
  const p = patterns();
  const visible = text.replace(/\s+/g, '');
  const bad = visible.match(p.unprintable)?.length ?? 0;
  let words = 0;
  let real = 0;
  for (const raw of text.split(p.wordSplit)) {
    const token = raw.replace(p.edgePunct, '');
    if (!token || !p.letter.test(token)) continue;
    words++;
    if (p.realWord.test(token)) real++;
  }
  return {
    printable: visible.length ? 1 - bad / visible.length : 0,
    realWords: words ? real / words : 0,
  };
}

const QUALITY_WINDOWS = 20;
const QUALITY_WINDOW_CHARS = 5_000;

/**
 * The text the quality ratios are measured on: all of it when short, else
 * evenly spaced windows (about 100k characters). Both ratios are shares, so a
 * sample spread over the whole book estimates them well, while scanning a
 * 1.4M-character book in full blocked the main thread for about 250 ms.
 */
export function qualitySample(text: string): string {
  if (text.length <= QUALITY_WINDOWS * QUALITY_WINDOW_CHARS) return text;
  const step = (text.length - QUALITY_WINDOW_CHARS) / (QUALITY_WINDOWS - 1);
  // Never split a surrogate pair: half of one counts as an unprintable character.
  const isLowSurrogate = (i: number) => {
    const c = text.charCodeAt(i);
    return c >= 0xdc00 && c <= 0xdfff;
  };
  const parts: string[] = [];
  for (let i = 0; i < QUALITY_WINDOWS; i++) {
    let start = Math.round(i * step);
    let end = Math.min(text.length, start + QUALITY_WINDOW_CHARS);
    if (isLowSurrogate(start)) start++;
    if (end < text.length && isLowSurrogate(end)) end--;
    parts.push(text.slice(start, end));
  }
  return parts.join('\n');
}

/**
 * The warning to show instead of filling the source box with junk, or
 * undefined when the text is usable. `pages` is 0 for formats without pages.
 */
export function unreadableWarning(text: string, pages: number, kind: 'pdf' | 'docx' | 'text'): string | undefined {
  if (!text.trim()) {
    return kind === 'pdf'
      ? 'This PDF has no text layer — it looks scanned or unreadable. Paste the text instead (scanned pages would need OCR, which is not supported).'
      : `${kind === 'docx' ? 'This Word file' : 'This file'} has no readable text — paste the text instead.`;
  }
  const { printable, realWords } = textQuality(qualitySample(text));
  if (kind === 'pdf') {
    const sparse = pages > 0 && text.length / pages < 30;
    return printable < 0.9 || realWords < 0.5 || sparse ? 'This PDF looks scanned or unreadable — paste the text instead.' : undefined;
  }
  if (printable >= 0.9) return undefined;
  return kind === 'docx'
    ? "This Word file's text could not be read — save it again as .docx or PDF, or paste the text instead."
    : 'This file does not look like text — it may be binary or not saved as UTF-8. Save it as UTF-8 text, or paste the text instead.';
}

function finish(blocks: ExtractBlock[], outline: OutlineEntry[], pages: number, kind: 'pdf' | 'docx' | 'text', fullText: string, warning?: string): ExtractResult {
  const unreadable = unreadableWarning(fullText, pages, kind);
  if (unreadable) return empty(pages, unreadable);
  return { blocks, outline, pages, chars: fullText.length, fullText, ...(warning ? { warning } : {}) };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;

/**
 * Turn one page's pdf.js text items into lines. pdf.js marks line ends with
 * hasEOL; each line keeps the font size (vertical scale of the text matrix)
 * that carries most of its characters, so a bold drop-cap or a superscript
 * does not decide whether the line is a heading.
 */
export function linesFromTextItems(items: ReadonlyArray<unknown>, page: number): ExtractBlock[] {
  const out: ExtractBlock[] = [];
  let text = '';
  let y: number | undefined;
  const sizes = new Map<number, number>();
  const flush = () => {
    const line = collapse(text);
    if (line) {
      let size = 0;
      let best = -1;
      sizes.forEach((chars, s) => {
        if (chars > best) {
          best = chars;
          size = s;
        }
      });
      out.push({ kind: 'para', text: line, page, ...(size > 0 ? { size } : {}), ...(y !== undefined ? { y } : {}) });
    }
    text = '';
    y = undefined;
    sizes.clear();
  };
  for (const item of items) {
    // Marked-content markers carry no `str`.
    if (!item || typeof item !== 'object' || !('str' in item)) continue;
    const { str, transform, hasEOL } = item as TextItem;
    text += str;
    const visible = str.replace(/\s+/g, '').length;
    if (visible && Array.isArray(transform)) {
      const size = Math.round(Math.hypot(transform[2], transform[3]) * 10) / 10;
      sizes.set(size, (sizes.get(size) ?? 0) + visible);
      if (y === undefined && Number.isFinite(transform[5])) y = Math.round(transform[5] * 10) / 10;
    }
    if (hasEOL) flush();
  }
  flush();
  return out;
}

async function destinationPage(doc: PdfDocument, dest: unknown): Promise<number | undefined> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit[0] == null) return undefined;
    const target = explicit[0];
    // An explicit destination starts with a page reference, or (rarely, in
    // remote-go-to style dests) a 0-based page index.
    const index = typeof target === 'number' ? target : await doc.getPageIndex(target);
    return index + 1;
  } catch {
    return undefined;
  }
}

async function readOutline(doc: PdfDocument): Promise<OutlineEntry[]> {
  let tree: Awaited<ReturnType<PdfDocument['getOutline']>>;
  try {
    tree = await doc.getOutline();
  } catch {
    return [];
  }
  const out: OutlineEntry[] = [];
  const walk = async (nodes: typeof tree, level: number) => {
    for (const node of nodes ?? []) {
      if (out.length >= MAX_OUTLINE_ENTRIES) return;
      const title = collapse(node.title ?? '');
      if (title) {
        const page = await destinationPage(doc, node.dest);
        out.push({ title, level, ...(page ? { page } : {}) });
      }
      if (node.items?.length) await walk(node.items, level + 1);
    }
  };
  await walk(tree, 1);
  return out;
}

async function extractPdf(data: Uint8Array, opts: ExtractOptions): Promise<ExtractResult> {
  const pdfjs: PdfJs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Browsers load the worker we self-host; under Node (tests, scripts) pdf.js
  // runs its bundled worker in-process and must keep its own default.
  if (typeof window !== 'undefined') pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  throwIfAborted(opts.signal);

  // isEvalSupported:false: pdf.js must never compile font code from the file
  // (defence in depth against CVE-2024-4367-style font exploits).
  // verbosity ERRORS: font-substitution warnings are noise in an upload form.
  const task = pdfjs.getDocument({ data, isEvalSupported: false, verbosity: pdfjs.VerbosityLevel.ERRORS });
  const onAbort = () => void task.destroy();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let doc: PdfDocument;
    try {
      doc = await task.promise;
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'PasswordException') {
        return empty(0, 'This PDF is password-protected — remove the password (for example, print it to a new PDF) or paste the text instead.');
      }
      if (name === 'InvalidPDFException') {
        return empty(0, 'This file is not a readable PDF (it may be damaged) — export it to PDF again, or paste the text instead.');
      }
      throw err;
    }

    const total = Math.min(doc.numPages, MAX_PDF_PAGES);
    const outline = await readOutline(doc);
    const blocks: ExtractBlock[] = [];
    const pageTexts: string[] = [];
    for (let i = 1; i <= total; i++) {
      throwIfAborted(opts.signal);
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const lines = linesFromTextItems(content.items, i);
      for (const line of lines) blocks.push(line);
      pageTexts.push(lines.map((l) => l.text).join('\n'));
      // Free the page's parsed resources now; a 600-page book otherwise keeps
      // them all alive until destroy().
      page.cleanup();
      opts.onProgress?.(i, total);
    }
    const capped = doc.numPages > MAX_PDF_PAGES
      ? `Only the first ${MAX_PDF_PAGES} of ${doc.numPages} pages were read — split the PDF to include the rest.`
      : undefined;
    // The page loop awaited pdf.js's worker; joining the text and the quality
    // check below run on this thread, so let the final progress label paint first.
    await nextTask();
    throwIfAborted(opts.signal);
    return finish(blocks, outline, total, 'pdf', pageTexts.join('\n\n').trim(), capped);
  } catch (err) {
    // Cancelling destroys the worker, so the pending pdf.js call rejects with
    // its own error; report the cancellation instead.
    throwIfAborted(opts.signal);
    throw err;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    await task.destroy();
  }
}

// ---------------------------------------------------------------------------
// DOCX / HTML / text
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const H_OPEN = '\u0001';
const H_CLOSE = '\u0002';

/**
 * HTML (mammoth's DOCX conversion, or an uploaded .html page) to heading and
 * paragraph blocks. Block-level tags become line breaks and h1..h6 keep their
 * level; everything else is flattened to text.
 */
export function htmlToBlocks(html: string): ExtractBlock[] {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<h([1-6])\b[^>]*>/gi, `\n${H_OPEN}$1${H_CLOSE}`)
    .replace(/<\/h[1-6]\s*>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol|tr|table|thead|tbody|tfoot|section|article|header|footer|nav|aside|main|blockquote|pre|dt|dd|dl|figure|figcaption|caption)\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  const blocks: ExtractBlock[] = [];
  for (const rawLine of text.split('\n')) {
    const heading = rawLine.startsWith(H_OPEN) ? Number(rawLine[1]) : 0;
    const line = collapse(decodeEntities(heading ? rawLine.slice(3) : rawLine));
    if (!line) continue;
    blocks.push(heading ? { kind: 'heading', text: line, level: heading } : { kind: 'para', text: line });
  }
  return blocks;
}

/** Plain text lines; markdown ATX headings (`## Title`) become heading blocks. */
export function textToBlocks(text: string, markdown: boolean): ExtractBlock[] {
  const blocks: ExtractBlock[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const h = markdown ? raw.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
    const line = collapse(h ? h[2] : raw);
    if (!line) continue;
    blocks.push(h ? { kind: 'heading', text: line, level: h[1].length } : { kind: 'para', text: line });
  }
  return blocks;
}

const joinBlocks = (blocks: ExtractBlock[]) => blocks.map((b) => b.text).join('\n');

async function extractDocx(buffer: ArrayBuffer): Promise<ExtractResult> {
  const mammoth = (await import('mammoth')).default;
  // The bundler picks mammoth's browser entry, which reads `arrayBuffer`; its
  // Node entry (vitest, scripts) reads `buffer`. Both accept an ArrayBuffer.
  const input = { arrayBuffer: buffer, buffer } as unknown as { arrayBuffer: ArrayBuffer };
  const { value } = await mammoth.convertToHtml(
    input,
    // Skip images: the default inlines each one as a base64 data URI, which
    // costs memory and time for text we then throw away.
    { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
  );
  const blocks = htmlToBlocks(value);
  return finish(blocks, [], 0, 'docx', joinBlocks(blocks));
}

async function extractText(file: File, name: string): Promise<ExtractResult> {
  const raw = await file.text();
  if (HTML_EXT.test(name) || file.type === 'text/html') {
    const blocks = htmlToBlocks(raw);
    return finish(blocks, [], 0, 'text', joinBlocks(blocks));
  }
  const text = raw.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return finish(textToBlocks(text, MARKDOWN_EXT.test(name)), [], 0, 'text', text);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read an uploaded document into structured text. Known problems (scanned or
 * password-protected PDF, unsupported type, too large) come back as `warning`
 * with no text rather than as an exception, so the caller can show them as-is.
 * Throws only for unexpected failures, or an AbortError when `signal` fires.
 */
export async function extractDocument(file: File, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const name = file.name.toLowerCase();
  throwIfAborted(opts.signal);

  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    if (file.size > MAX_PDF_BYTES) {
      return empty(0, 'This PDF is larger than 100 MB — split it into smaller files, or paste the text instead.');
    }
    return extractPdf(new Uint8Array(await file.arrayBuffer()), opts);
  }
  if (name.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return extractDocx(await file.arrayBuffer());
  }
  if (TEXT_EXT.test(name) || file.type.startsWith('text/')) {
    return extractText(file, name);
  }
  if (name.endsWith('.doc')) {
    return empty(0, 'Old Word .doc files are not supported — save it as .docx or PDF, or paste the text instead.');
  }
  return empty(0, 'Unsupported file type — upload a PDF, DOCX or text file, or paste the text instead.');
}

/**
 * Backward-compatible wrapper: the document's full text, or empty text plus a
 * warning when nothing usable could be read.
 */
export async function extractTextFromFile(file: File): Promise<{ text: string; warning?: string }> {
  const result = await extractDocument(file);
  return { text: result.fullText, ...(result.warning ? { warning: result.warning } : {}) };
}
