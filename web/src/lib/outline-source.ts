/**
 * Condenses an extracted document (see extract-text.ts) into the digest sent
 * to the AI outline generator: the document's heading outline, which the model
 * treats as authoritative for order and scope, plus an excerpt under each
 * heading sized to share the budget. Documents without detectable headings get
 * evenly spaced windows instead. Sending the whole document's shape, rather
 * than its first N characters, is what lets the outline cover chapter 12 as
 * well as chapter 1, and keeps the request small (the API caps source_text,
 * and Ge'ez script costs several times more tokens per character).
 *
 * Format — api/packages/ai/src/index.ts (outlineHeadings) reads the outline
 * block, and the excerpts, to build a starter outline when the AI is offline,
 * so keep the two in sync:
 *
 *   DOCUMENT OUTLINE (authoritative order):
 *   Chapter 1 Introduction
 *     1.1 Background            (two spaces of indent per level below the top)
 *
 *   EXCERPTS:
 *   ## Chapter 1 Introduction
 *   <excerpt, one line>
 *
 * Pure: no DOM or I/O, so it is unit-tested directly.
 */

import type { ExtractBlock, ExtractResult, OutlineEntry } from './extract-text';

export const OUTLINE_HEADER = 'DOCUMENT OUTLINE (authoritative order):';
export const EXCERPTS_HEADER = 'EXCERPTS:';
/** Excerpt label for text that precedes the first heading. */
export const OPENING_LABEL = '(Before the first heading)';

export interface DigestOptions {
  /** Maximum digest length in characters. Default 24,000. */
  budgetChars?: number;
  /** Maximum estimated tokens (see estimateTokens). Default 6,000. */
  budgetTokens?: number;
}

export interface Digest {
  digest: string;
  /** Headings listed in the digest's outline; 0 when none were detected. */
  headings: number;
  estTokens: number;
  /**
   * True when the digest leaves out part of the document's content (book
   * apparatus — contents, index, references — is always left out and does
   * not count).
   */
  truncated: boolean;
}

/**
 * What the outline model reads of source_text: COURSE_SOURCE_LIMIT in
 * api/packages/ai (it drops anything past 24,000 characters), and a token
 * budget that keeps a Ge'ez-script request within the provider's limits.
 */
export const DIGEST_BUDGET_CHARS = 24_000;
export const DIGEST_BUDGET_TOKENS = 6_000;
/** The outline may use at most this share of the budget; excerpts get the rest. */
const OUTLINE_SHARE = 0.4;
const MIN_EXCERPT = 200;
const MAX_LEVEL = 3;
const MAX_TITLE = 120;
const HEADING_SIZE_RATIO = 1.15;
/** A header/footer-zone line repeated on more than this share of pages is page furniture. */
const RUNNING_SHARE = 0.3;
/** Lines at each end of a page (reading order) that count as its header/footer zone. */
const EDGE_LINES = 3;
const OPENING_CHARS = 2000;
const WINDOW_CHARS = 1000;
/** Split a long body into up to this many windows so a chapter's end is represented too. */
const BODY_WINDOWS = 3;
const BODY_WINDOW_MIN = 600;

/**
 * Rough token count for budget purposes: English BPE averages ~4 characters
 * per token, while Ge'ez script and other non-ASCII text tokenizes far worse.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 4 + (text.length - ascii) / 1.5);
}

/** True when the model would see all of `text` as-is; anything longer must be condensed with buildDigest first. */
export function fitsDigestBudget(text: string): boolean {
  return text.length <= DIGEST_BUDGET_CHARS && estimateTokens(text) <= DIGEST_BUDGET_TOKENS;
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

// Page furniture: "12", "- 12 -", "Page 3 of 10", "3/10", "ገጽ 4", roman "xiv".
const PAGE_NUMBER = /^(?:page|p\.|pg\.?|ገጽ)?\s*[-–—]?\s*(?:\d{1,4}|(?=[ivxlcdm]+\s*[-–—]?\s*$)m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))\s*[-–—]?\s*(?:(?:of|\/)\s*\d{1,4})?$/i;
// Table-of-contents entries: "Introduction ........ 5".
const TOC_LEADER = /(?:\.\s?){5,}\s*\S{0,6}$|…{2,}/;
// Any letter in the scripts course material here is written in.
const HAS_LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0600-\u06FF\u1200-\u137F\u2D80-\u2DDF\uAB00-\uAB2F]/;

export function isPageNumber(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && PAGE_NUMBER.test(t);
}

const isToc = (text: string) => TOC_LEADER.test(text);
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
// Symbol-font bullets (Wingdings and friends) come through as private-use
// code points; list bullets add nothing to a title either.
const PRIVATE_USE = /[\uE000-\uF8FF]/g;
const LEADING_BULLETS = /^[•·▪►▶✓✔➢➤○●■□◆◇\-–—*]+\s*/;
const tidy = (s: string) => collapse(s.replace(PRIVATE_USE, ' '));
const clampTitle = (s: string) => {
  const t = tidy(s).replace(LEADING_BULLETS, '');
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1).trimEnd()}…` : t;
};
/** Comparison key that ignores case, spacing and punctuation. */
const matchKey = (s: string) => s.toLowerCase().replace(/[\s.,:;'"’‘“”()[\]\-–—_•·|/\\]+/g, '');

function isHeadingText(text: string): boolean {
  return text.length >= 3 && text.length <= MAX_TITLE && HAS_LETTER.test(text) && !/[.,;]$/.test(text) && !isPageNumber(text) && !isToc(text);
}

/** The font size that carries the most characters: the body text size. */
function bodyFontSize(blocks: ExtractBlock[]): number {
  const chars = new Map<number, number>();
  for (const b of blocks) {
    if (!b.size) continue;
    const key = Math.round(b.size * 2) / 2;
    chars.set(key, (chars.get(key) ?? 0) + b.text.length);
  }
  let body = 0;
  let best = -1;
  chars.forEach((n, size) => {
    if (n > best) {
      best = n;
      body = size;
    }
  });
  return body;
}

/**
 * Indices of lines in a page's header/footer zone: the first and last lines
 * in reading order, or the top/bottom tenth of the page's text by position.
 */
function pageEdges(blocks: ExtractBlock[]): Set<number> {
  const byPage = new Map<number, number[]>();
  blocks.forEach((b, i) => {
    if (!b.page) return;
    const idx = byPage.get(b.page);
    if (idx) idx.push(i);
    else byPage.set(b.page, [i]);
  });
  const edges = new Set<number>();
  byPage.forEach((idx) => {
    idx.slice(0, EDGE_LINES).concat(idx.slice(-EDGE_LINES)).forEach((i) => edges.add(i));
    const ys = idx.map((i) => blocks[i].y).filter((y): y is number => y !== undefined);
    if (ys.length < 2) return;
    const top = Math.max(...ys);
    const bottom = Math.min(...ys);
    const zone = (top - bottom) * 0.1;
    for (const i of idx) {
      const y = blocks[i].y;
      if (y !== undefined && (y >= top - zone || y <= bottom + zone)) edges.add(i);
    }
  });
  return edges;
}

/**
 * Drop page numbers and running headers/footers from each page's
 * header/footer zone: bare numbers, and lines repeated on more than 30% of
 * pages (at least 3). Only the zone counts, so a table whose cells repeat from
 * page to page keeps its rows, and a "C" answer option is not page "C". Lines that
 * differ only in their digits ("Page 3 of 10") also count as repeats — unless
 * they are set larger than body text, so "Chapter 1", "Chapter 2"… headings
 * of a short document survive.
 */
function dropPageFurniture(blocks: ExtractBlock[], headingSize: number): ExtractBlock[] {
  const edges = pageEdges(blocks);
  const pages = new Set<number>();
  const exact = new Map<string, Set<number>>();
  const loose = new Map<string, Set<number>>();
  const note = (map: Map<string, Set<number>>, key: string, page: number) => {
    const set = map.get(key) ?? new Set<number>();
    set.add(page);
    map.set(key, set);
  };
  blocks.forEach((b, i) => {
    if (!b.page) return;
    pages.add(b.page);
    if (!edges.has(i)) return;
    const key = b.text.toLowerCase();
    note(exact, key, b.page);
    note(loose, key.replace(/\d+/g, '#'), b.page);
  });
  const repeated = (set?: Set<number>) => !!set && set.size >= 3 && set.size > pages.size * RUNNING_SHARE;
  return blocks.filter((b, i) => {
    if (!b.page || !edges.has(i)) return true;
    if (isPageNumber(b.text)) return false;
    const key = b.text.toLowerCase();
    if (repeated(exact.get(key))) return false;
    const large = headingSize > 0 && (b.size ?? 0) >= headingSize;
    return large || !repeated(loose.get(key.replace(/\d+/g, '#')));
  });
}

// ---------------------------------------------------------------------------
// Heading sources, in priority order
// ---------------------------------------------------------------------------

interface Heading {
  title: string;
  level: number;
  /** Index into the lines where this heading's region starts. */
  anchor?: number;
  /** Index where its body text starts (after the heading's own lines). */
  bodyStart?: number;
  /**
   * Book apparatus (copyright, contents, index…): still ends the previous
   * heading's body, but is left out of the outline and excerpts so the model
   * (or the offline outline) never turns it into a lesson.
   */
  skip?: boolean;
}

const APPARATUS = /^(?:copyright|(?:table of )?contents|index|acknowledge?ments?|about the authors?|colophon|dedication|bibliography|references|works cited|list of (?:figures|tables|abbreviations)|ማውጫ|thank you|thanks|questions|q ?& ?a|the end)$/i;

/** 1. PDF bookmarks (depth ≤ 3, at least 3), anchored to their pages' text. */
function fromBookmarks(outline: OutlineEntry[], lines: ExtractBlock[]): Heading[] | undefined {
  const entries = outline.filter((e) => e.level <= MAX_LEVEL && HAS_LETTER.test(e.title) && !isPageNumber(e.title));
  if (entries.length < 3) return undefined;
  const firstOnPage = new Map<number, number>();
  lines.forEach((l, i) => {
    if (l.page && !firstOnPage.has(l.page)) firstOnPage.set(l.page, i);
  });
  const lastPage = lines.length ? lines[lines.length - 1].page ?? 0 : 0;
  let prev = 0;
  return entries.map((e) => {
    const heading: Heading = { title: clampTitle(e.title), level: e.level };
    if (!e.page) return heading;
    let start: number | undefined;
    for (let p = e.page; p <= lastPage && start === undefined; p++) start = firstOnPage.get(p);
    if (start === undefined) return heading;
    // Prefer the line that carries the bookmark's title; otherwise the region
    // starts at the top of its page. Never step back before the previous
    // heading, or the earlier heading would lose its body.
    const want = matchKey(e.title);
    for (let i = Math.max(start, prev); i < lines.length && lines[i].page === lines[start].page; i++) {
      const have = matchKey(lines[i].text);
      if (have && (have.startsWith(want.slice(0, 40)) || (have.length >= 6 && want.startsWith(have)))) {
        prev = i;
        return { ...heading, anchor: i, bodyStart: i + 1 };
      }
    }
    if (start < prev) return heading;
    prev = start;
    return { ...heading, anchor: start, bodyStart: start };
  });
}

// A heading label on its own line, completed by the next line:
// "Chapter 3" / "Networks", "PART II" / "Foundations", "ምዕራፍ አንድ" / "…".
const LABEL_ONLY = /^(?:(?:part|chapter|unit|module|section|lesson|ምዕራፍ|ክፍል)(?:\s+\S{1,10})?|[\dIVX]{1,4})[.:]?$/i;

/**
 * Whether `next` continues the heading line `prev` (same size, same page): a
 * bare label ("Chapter 3") completed by its title, a wrap continuing in lower
 * case, or a line set at wrapped-line spacing (≤ 1.5× the font size; separate
 * headings such as a document title and "Chapter 1" sit further apart).
 */
function continuesHeading(prev: ExtractBlock, next: ExtractBlock, first: boolean): boolean {
  if (next.page !== prev.page || !next.size || !prev.size || Math.abs(next.size - prev.size) > 0.5) return false;
  if (first && LABEL_ONLY.test(prev.text)) return true;
  if (/^[a-z]/.test(next.text)) return true;
  if (prev.y === undefined || next.y === undefined) return false;
  const gap = prev.y - next.y;
  return gap > 0 && gap <= prev.size * 1.5;
}

/** Cluster heading sizes within 5% of each other into one level, biggest first. */
function sizeLevels(sizes: number[]): Map<number, number> {
  const levels = new Map<number, number>();
  let level = 0;
  let top = Infinity;
  for (const size of Array.from(new Set(sizes)).sort((a, b) => b - a)) {
    if (size < top * 0.95) {
      level++;
      top = size;
    }
    levels.set(size, level);
  }
  return levels;
}

/**
 * 2. Font-size headings: lines at least 1.15× the body size, 3–120 chars, not
 * ending like a sentence; multi-line headings are joined (continuesHeading).
 * Bigger sizes rank higher.
 */
function fromFontSizes(lines: ExtractBlock[], headingSize: number): Heading[] | undefined {
  if (!headingSize || lines.filter((l) => l.size).length < lines.length / 2) return undefined;
  const found: (Heading & { size: number })[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.size || line.size < headingSize || isToc(line.text)) continue;
    let text = line.text;
    let j = i;
    while (j + 1 < lines.length && continuesHeading(lines[j], lines[j + 1], j === i)) {
      if (text.length + 1 + lines[j + 1].text.length > MAX_TITLE) break;
      text += ` ${lines[j + 1].text}`;
      j++;
    }
    if (isHeadingText(text)) found.push({ title: clampTitle(text), level: 0, anchor: i, bodyStart: j + 1, size: Math.round(line.size * 2) / 2 });
    i = j;
  }
  // Too few is no structure; too many means "large" is really the body style
  // (e.g. a slide deck with a tiny footer font).
  if (found.length < 2 || found.length > Math.max(3, lines.length * 0.4)) return undefined;
  const levels = sizeLevels(found.map((h) => h.size));
  // A size tier used only on the first two pages is the cover or title page
  // (book title, author) — not the top of the outline — when the document has
  // more pages and other tiers to outline.
  const coverTiers = new Set<number>();
  levels.forEach((level) => {
    const tier = found.filter((h) => levels.get(h.size) === level);
    if (tier.every((h) => (lines[h.anchor!].page ?? 0) <= 2) && tier.length < found.length && (lines[lines.length - 1].page ?? 0) > 4) coverTiers.add(level);
  });
  return found.filter((h) => !coverTiers.has(levels.get(h.size)!)).map(({ size, ...h }) => ({ ...h, level: levels.get(size) ?? 1 }));
}

/** 3. Explicit heading blocks: DOCX heading styles, markdown `#`, HTML h1..h6. */
function fromHeadingBlocks(lines: ExtractBlock[]): Heading[] | undefined {
  const found: Heading[] = [];
  lines.forEach((l, i) => {
    if (l.kind === 'heading' && HAS_LETTER.test(l.text)) found.push({ title: clampTitle(l.text), level: l.level ?? 1, anchor: i, bodyStart: i + 1 });
  });
  return found.length >= 2 ? found : undefined;
}

// "Chapter 3", "UNIT 2: Cells", "ምዕራፍ ሁለት", "ክፍል 1" …
const KEYWORD_HEADING = /^(part|chapter|unit|module|section|lesson|ምዕራፍ|ክፍል)(?=$|[\s:.\-–—\d])/i;
// "3 Results", "2.1 Data collection", "4. Conclusion"
const NUMBERED_HEADING = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(\S.*)$/;
const KEYWORD_LEVEL: Record<string, number> = { part: 1, chapter: 2, unit: 2, module: 2, ምዕራፍ: 2, section: 3, lesson: 3, ክፍል: 3 };

function patternLevel(text: string): number {
  if (text.length > 100 || text.split(' ').length > 14 || /[.,;]$/.test(text)) return 0;
  const keyword = text.match(KEYWORD_HEADING);
  if (keyword) {
    // Latin keywords must be capitalised: "section 3 of the act…" is prose.
    const word = keyword[1];
    if (/^[a-z]/.test(word)) return 0;
    return KEYWORD_LEVEL[word.toLowerCase()] ?? 2;
  }
  const numbered = text.match(NUMBERED_HEADING);
  // The title must start with a capital or a non-Latin letter ("2 cups of…"
  // is prose), and neither end in a number (a contents entry's page, a postal
  // code) nor contain a comma (an address or a list item).
  if (numbered && !/\d$|,/.test(numbered[2]) && /^[A-Z\u00C0-\u00DE\u0370-\u03FF\u0400-\u042F\u1200-\u137F]/.test(numbered[2]) && HAS_LETTER.test(numbered[2])) {
    return 1 + numbered[1].split('.').length;
  }
  return 0;
}

/**
 * 4. Heading-shaped lines: Chapter/Unit/Module/Part/Section/Lesson/ምዕራፍ/ክፍል
 * or "1.2 Title". A line that recurs three or more times is a table cell or
 * a label, not a heading.
 */
function fromPatterns(lines: ExtractBlock[]): Heading[] | undefined {
  const found: Heading[] = [];
  const seen = new Map<string, number>();
  lines.forEach((l, i) => {
    const level = isToc(l.text) ? 0 : patternLevel(l.text);
    if (!level) return;
    const title = clampTitle(l.text);
    seen.set(matchKey(title), (seen.get(matchKey(title)) ?? 0) + 1);
    found.push({ title, level, anchor: i, bodyStart: i + 1 });
  });
  const kept = found.filter((h) => (seen.get(matchKey(h.title)) ?? 0) < 3);
  return kept.length >= 2 ? kept : undefined;
}

/**
 * Levels become 1..n by rank, never more than one deeper than the heading
 * before (an unused size or style tier must not leave a gap in the
 * indentation), and deeper than 3 is dropped. A heading repeated right after
 * itself (a title continued on the next page) collapses into one.
 */
function normalizeLevels(headings: Heading[]): Heading[] {
  const ranks = Array.from(new Set(headings.map((h) => h.level))).sort((a, b) => a - b);
  const out: Heading[] = [];
  for (const h of headings) {
    const last = out[out.length - 1];
    const level = Math.min(ranks.indexOf(h.level) + 1, (last?.level ?? 0) + 1);
    if (level > MAX_LEVEL) continue;
    if (last && matchKey(last.title) === matchKey(h.title)) continue;
    out.push({ ...h, level });
  }
  return out;
}

type HeadingSource = 'bookmarks' | 'font-size' | 'heading-styles' | 'patterns';

interface Prepared {
  lines: ExtractBlock[];
  headings: Heading[];
  source?: HeadingSource;
}

function prepare(result: ExtractResult): Prepared {
  const body = bodyFontSize(result.blocks);
  const headingSize = body ? body * HEADING_SIZE_RATIO : 0;
  const lines = dropPageFurniture(result.blocks, headingSize);
  const sources: [HeadingSource, () => Heading[] | undefined][] = [
    ['bookmarks', () => fromBookmarks(result.outline, lines)],
    ['font-size', () => fromFontSizes(lines, headingSize)],
    ['heading-styles', () => fromHeadingBlocks(lines)],
    ['patterns', () => fromPatterns(lines)],
  ];
  for (const [source, find] of sources) {
    const found = find();
    const headings = (found ? normalizeLevels(found) : []).map((h) => (APPARATUS.test(h.title.replace(/[.:!?]$/, '')) ? { ...h, skip: true } : h));
    // One heading (after duplicates collapse) is not an outline.
    if (headings.filter((h) => !h.skip).length >= 2) return { lines, headings, source };
  }
  return { lines, headings: [] };
}

// ---------------------------------------------------------------------------
// Excerpts
// ---------------------------------------------------------------------------

const SENTENCE_END = /[.!?።፧][)"'’”\]]?(?=\s|$)/g;

/** At most `max` chars, cut at a sentence end (or a word boundary + "…"). */
export function trimToSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '';
  const cut = text.slice(0, max);
  let end = -1;
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(cut); m; m = SENTENCE_END.exec(cut)) end = m.index + m[0].length;
  if (end >= max * 0.5) return cut.slice(0, end);
  const space = cut.lastIndexOf(' ', max - 1);
  if (space >= max * 0.5) return `${cut.slice(0, space).trimEnd()}…`;
  return `${cut.slice(0, max - 1)}…`;
}

/** Start reading at the next sentence (or word) boundary after `pos`. */
function alignedFrom(text: string, pos: number): string {
  if (pos <= 0) return text;
  const ahead = text.slice(pos, pos + 200);
  SENTENCE_END.lastIndex = 0;
  const sentence = SENTENCE_END.exec(ahead);
  if (sentence) return text.slice(pos + sentence.index + sentence[0].length).trimStart();
  const space = ahead.indexOf(' ');
  return text.slice(space >= 0 ? pos + space + 1 : pos);
}

/**
 * The excerpt of a body in `max` chars. A body much longer than its share is
 * sampled at its start, middle and end rather than only its opening, so a
 * long chapter's later topics still reach the model.
 */
function excerptOf(body: string, max: number): string {
  if (body.length <= max) return body;
  const windows = Math.min(BODY_WINDOWS, Math.floor(max / BODY_WINDOW_MIN));
  if (windows < 2 || body.length < max * 3) return trimToSentence(body, max);
  const sep = ' … ';
  const each = Math.floor((max - sep.length * (windows - 1)) / windows);
  const parts: string[] = [];
  // Spread so the first window starts the body and the last one ends it.
  for (let w = 0; w < windows; w++) parts.push(trimToSentence(alignedFrom(body, Math.floor((w * (body.length - each)) / (windows - 1))), each));
  return parts.filter(Boolean).join(sep);
}

const outlineLines = (headings: Heading[]) => headings.map((h) => `${'  '.repeat(h.level - 1)}${h.title}`).join('\n');

function pickEvenly<T>(items: T[], n: number): T[] {
  if (n >= items.length) return items;
  return Array.from({ length: Math.max(0, n) }, (_, i) => items[Math.floor((i * items.length) / n)]);
}

/** Headings for the outline block, within `max` chars: drop the deepest level first, then thin evenly. */
function fitOutline(headings: Heading[], max: number): Heading[] {
  let kept = headings;
  let depth = Math.max(0, ...kept.map((h) => h.level));
  while (outlineLines(kept).length > max && depth > 1) {
    depth--;
    kept = kept.filter((h) => h.level <= depth);
  }
  let n = kept.length;
  while (n > 0 && outlineLines(pickEvenly(kept, n)).length > max) n = Math.min(n - 1, Math.floor((n * max) / outlineLines(pickEvenly(kept, n)).length));
  return pickEvenly(kept, n);
}

interface Entry {
  label: string;
  start: number;
  end: number;
  length: number;
}

function bodyText(lines: ExtractBlock[], start: number, end: number): string {
  const parts: string[] = [];
  for (let i = start; i < end; i++) if (!isToc(lines[i].text)) parts.push(lines[i].text);
  return tidy(parts.join(' '));
}

/**
 * One entry per outlined heading with body text: from its body start to the
 * next boundary (the next outlined or apparatus heading placed in the text).
 */
function excerptEntries(lines: ExtractBlock[], boundaries: Heading[], withOpening: boolean): Entry[] {
  const anchored = boundaries.filter((h) => h.anchor !== undefined);
  const entries: Entry[] = [];
  const push = (label: string, start: number, end: number) => {
    let length = 0;
    for (let i = start; i < end; i++) if (!isToc(lines[i].text)) length += lines[i].text.length + 1;
    if (length > 1) entries.push({ label, start, end, length: length - 1 });
  };
  if (withOpening && anchored.length) push(OPENING_LABEL, 0, anchored[0].anchor!);
  anchored.forEach((h, i) => {
    if (h.skip) return;
    const next = anchored.slice(i + 1).find((n) => n.anchor! > h.anchor!);
    push(h.title, h.bodyStart ?? h.anchor!, next ? next.anchor! : lines.length);
  });
  return entries;
}

const entryOverhead = (e: Entry) => `## ${e.label}\n`.length + 2;

/**
 * Share `budget` chars among the entries: every chosen entry gets at least
 * MIN_EXCERPT (or its whole body when shorter); short bodies take only what
 * they have and the rest flows to longer ones. When even the minimum does not
 * fit for all, an evenly spaced subset is kept.
 */
function allocate(entries: Entry[], budget: number): { chosen: Entry[]; sizes: number[] } {
  const cost = (list: Entry[]) => list.reduce((n, e) => n + entryOverhead(e) + Math.min(e.length, MIN_EXCERPT), 0);
  let m = entries.length;
  while (m > 0 && cost(pickEvenly(entries, m)) > budget) m--;
  const chosen = pickEvenly(entries, m);
  let pool = budget - chosen.reduce((n, e) => n + entryOverhead(e), 0);
  const order = chosen.map((e, i) => i).sort((a, b) => chosen[a].length - chosen[b].length);
  const sizes = new Array<number>(chosen.length).fill(0);
  order.forEach((idx, k) => {
    const give = Math.min(chosen[idx].length, Math.floor(pool / (order.length - k)));
    sizes[idx] = give;
    pool -= give;
  });
  return { chosen, sizes };
}

/** Evenly spaced windows through `text` within `budget` chars (no-heading documents). */
function windowExcerpts(text: string, budget: number): { body: string; truncated: boolean } {
  if (text.length <= budget) return { body: text, truncated: false };
  const openingLabel = '[Beginning]\n';
  const opening = trimToSentence(text, Math.min(OPENING_CHARS, Math.floor(budget / 4)));
  const parts = [`${openingLabel}${opening}`];
  let remaining = budget - parts[0].length;
  const rest = text.length - opening.length;
  const perWindow = WINDOW_CHARS + '\n\n[Excerpt 99/99 ~100%]\n'.length;
  const n = Math.min(Math.floor(remaining / perWindow), Math.floor(rest / WINDOW_CHARS));
  for (let i = 0; i < n; i++) {
    const pos = opening.length + Math.floor((i * rest) / n);
    const label = `[Excerpt ${i + 1}/${n} ~${Math.round((pos / text.length) * 100)}%]\n`;
    const room = Math.min(WINDOW_CHARS, remaining - label.length - 2);
    if (room < MIN_EXCERPT) break;
    const window = trimToSentence(alignedFrom(text, pos), room);
    parts.push(`${label}${window}`);
    remaining -= label.length + 2 + window.length;
  }
  return { body: parts.join('\n\n'), truncated: true };
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

function render(prep: Prepared, budget: number): Omit<Digest, 'estTokens'> {
  const { lines } = prep;
  const flat = () => lines.filter((l) => !isToc(l.text)).map((l) => l.text).join(' ');

  const outlined = prep.headings.filter((h) => !h.skip);
  const kept = outlined.length ? fitOutline(outlined, Math.floor(budget * OUTLINE_SHARE)) : [];
  if (!kept.length) {
    const all = lines.map((l) => l.text).join('\n');
    // Short and unstructured: the text itself is the best digest.
    if (all.length <= budget) return { digest: all, headings: 0, truncated: false };
    const { body } = windowExcerpts(flat(), budget - EXCERPTS_HEADER.length - 1);
    return { digest: `${EXCERPTS_HEADER}\n${body}`, headings: 0, truncated: true };
  }

  let truncated = kept.length < outlined.length;
  const outline = `${OUTLINE_HEADER}\n${outlineLines(kept)}`;
  const room = budget - outline.length - `\n\n${EXCERPTS_HEADER}\n`.length;
  // Front matter before the first bookmark is cover/copyright/contents pages.
  const keptSet = new Set(kept);
  const boundaries = prep.headings.filter((h) => h.skip || keptSet.has(h));
  const entries = excerptEntries(lines, boundaries, prep.source !== 'bookmarks');
  let excerpts = '';
  if (entries.length) {
    const { chosen, sizes } = allocate(entries, room);
    if (chosen.length < entries.length) truncated = true;
    excerpts = chosen
      .map((e, i) => {
        const body = bodyText(lines, e.start, e.end);
        const text = excerptOf(body, sizes[i]);
        if (text.length < body.length) truncated = true;
        return `## ${e.label}\n${text}`;
      })
      .join('\n\n');
  } else if (lines.length && room > MIN_EXCERPT) {
    // Headings we could not place in the text (e.g. bookmarks without pages).
    const windows = windowExcerpts(flat(), room);
    excerpts = windows.body;
    truncated ||= windows.truncated;
  } else if (lines.length) {
    truncated = true;
  }
  const digest = excerpts ? `${outline}\n\n${EXCERPTS_HEADER}\n${excerpts}` : outline;
  return { digest, headings: kept.length, truncated };
}

/**
 * Build the digest for `result`, within both the character budget and the
 * token estimate (Amharic text gets fewer characters for the same tokens).
 */
export function buildDigest(result: ExtractResult, opts: DigestOptions = {}): Digest {
  const budgetChars = Math.max(1000, opts.budgetChars ?? DIGEST_BUDGET_CHARS);
  const budgetTokens = Math.max(500, opts.budgetTokens ?? DIGEST_BUDGET_TOKENS);
  const prep = prepare(result);
  let budget = budgetChars;
  for (let attempt = 0; attempt < 4; attempt++) {
    const out = render(prep, budget);
    const estTokens = estimateTokens(out.digest);
    if (estTokens <= budgetTokens) return { ...out, estTokens };
    budget = Math.floor((budget * budgetTokens * 0.97) / estTokens);
  }
  // Every character costs at most 1/1.5 token, so this budget always fits.
  const out = render(prep, Math.min(budgetChars, Math.floor(budgetTokens * 1.5)));
  return { ...out, estTokens: estimateTokens(out.digest) };
}
