/**
 * AI capabilities backed by Groq (OpenAI-compatible chat completions).
 * Used for: AI viva question generation + grading, quiz generation, course
 * structure generation from source material, and plagiarism/spam screening.
 *
 * `createAiAssessor()` returns the Groq implementation when a real GROQ_API_KEY
 * is configured, otherwise a deterministic offline mock so the whole platform
 * runs locally with zero external credentials.
 */

export interface VivaEvaluation {
  score: number; // 0-100
  feedback: string;
}

export interface WrittenGrade {
  score: number; // 0-100
  feedback: string;
}

export interface PlagiarismResult {
  similarity_score: number; // 0-100
  flagged: boolean;
  reason: string;
}

export interface QuizQuestion {
  prompt: string;
  options: string[];
  correct_index: number;
}

export interface GeneratedLesson {
  title: string;
  summary?: string;
}

export interface GeneratedSection {
  title: string;
  is_free_preview: boolean;
  lessons: GeneratedLesson[];
}

/**
 * Where a generated outline came from, so the caller can label it honestly:
 * `model` = the AI's own reading of the material; `headings` = the offline
 * draft built from the document's headings; `placeholder` = generic numbered
 * sections (no headings found, nothing from the document was used).
 */
export type CourseStructureOrigin = 'model' | 'headings' | 'placeholder';

export interface GeneratedCourseStructure {
  sections: GeneratedSection[];
  origin?: CourseStructureOrigin;
}

export interface TutorChunk {
  /** e.g. "Lesson 3: Variables" or "Educator notes: Setup" */
  title: string;
  text: string;
}

export interface TutorInput {
  course_title: string;
  question: string;
  chunks: TutorChunk[];
  /** prior turns, oldest first */
  history: { role: 'user' | 'assistant'; content: string }[];
}

export interface TutorAnswer {
  answer: string;
  /** titles of the chunks the answer drew on */
  sources: string[];
  /** true when the material did not cover the question */
  not_covered: boolean;
}

export interface CourseStructureInput {
  title: string;
  source_text?: string;
  prompt?: string;
  section_count: number;
  lessons_per_section: number;
  /** Target learner level: beginner | intermediate | advanced. */
  level?: string;
  /** Preferred learning style, e.g. hands-on / project-based / theory-first / visual. */
  learning_style?: string;
}

export interface StudyPlanItem {
  /** what to review, e.g. "Section 2: Variables and types" */
  focus: string;
  /** why — the concept the learner missed */
  reason: string;
}

export interface StudyPlan {
  /** one-paragraph encouraging summary addressed to the learner */
  summary: string;
  /** ordered, specific things to review before retrying */
  plan: StudyPlanItem[];
}

export interface MissedQuestion {
  prompt: string;
  /** the concept/topic the question tests, if the educator tagged it */
  topic?: string;
}

export interface AiAssessor {
  generateVivaQuestion(courseTitle: string, topicContext: string): Promise<string>;
  evaluateVivaAnswer(question: string, answer: string): Promise<VivaEvaluation>;
  /**
   * Personalized study coach: turn the questions a learner got wrong into a
   * short, specific review plan, grounded in the course's lesson outline.
   */
  buildStudyPlan(courseTitle: string, score: number, missed: MissedQuestion[], outline: string[]): Promise<StudyPlan>;
  /** Grade an exam written answer against the question (and optional educator guidance). */
  gradeWrittenAnswer(question: string, answer: string, guidance?: string, courseTitle?: string): Promise<WrittenGrade>;
  /** Screen a listing for spam / fabrication and near-duplication of `corpus` (existing catalog). */
  plagiarismCheck(title: string, description: string, corpus?: string[]): Promise<PlagiarismResult>;
  /** Generate `count` multiple-choice questions on a topic. */
  generateQuiz(topic: string, count: number, difficulty?: string): Promise<QuizQuestion[]>;
  /**
   * Organize source material / a prompt into an ordered course outline.
   * `origin` says whether the model's reply or an offline draft was returned.
   */
  generateCourseStructure(input: CourseStructureInput): Promise<GeneratedCourseStructure>;
  /**
   * Course tutor: answer a learner's question ONLY from the retrieved course
   * excerpts (RAG). Must say so when the material does not cover the question.
   */
  answerWithContext(input: TutorInput): Promise<TutorAnswer>;
  /** Whether this is a real AI backend (vs the offline mock). */
  readonly isLive: boolean;
}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const CHAT_TIMEOUT_MS = 25_000;

function groqConfigured(): boolean {
  const key = process.env.GROQ_API_KEY;
  return !!key && key !== 'gsk_REPLACE_ME' && key.startsWith('gsk_');
}

/**
 * Operator-facing explanation for why an AI call fell back to the offline
 * generator. Distinguishes an expired/invalid key (rotate it) from a rate limit
 * (wait) from a timeout or outage, so the note in the UI is actionable instead
 * of generic. `subject` names what the offline generator produced.
 */
export function aiFallbackNote(err: unknown, subject: 'questions' | 'outline' = 'questions'): string {
  const reason = (err as { reason?: string })?.reason;
  const fallback = subject === 'outline' ? 'showing a starter outline you can edit' : 'showing placeholder questions';
  if (reason === 'auth') {
    return subject === 'outline'
      ? 'The AI service rejected the API key (expired or invalid) — an admin needs to rotate GROQ_API_KEY. Showing a starter outline you can edit.'
      : 'The AI service rejected the API key (expired or invalid) — an admin needs to rotate GROQ_API_KEY. Showing placeholder questions you can edit.';
  }
  if (reason === 'rate_limit') return `The AI service is rate-limited right now — ${fallback}. Try again in a minute.`;
  if (reason === 'timeout') return `The AI service took too long to answer — ${fallback}. Try again, or send a shorter source text.`;
  return subject === 'outline'
    ? 'AI generation was unavailable — showing a starter outline you can edit. Try again later.'
    : 'AI generation was unavailable — showing placeholder questions. Edit them or try again.';
}

// ---------------------------------------------------------------------------
// Course outlines
// ---------------------------------------------------------------------------

/**
 * How much source text the outline generator reads. The web client condenses
 * whole documents into a digest of about this size (web/src/lib/outline-source.ts),
 * so nothing it sends is cut off here.
 */
export const COURSE_SOURCE_LIMIT = 24_000;
/** Same limits as the course service's apply-structure DTOs. */
const MAX_SECTIONS = 12;
const MAX_LESSONS = 12;
const MAX_TITLE = 160;
const MAX_SUMMARY = 500;
/**
 * Digest markers written by web/src/lib/outline-source.ts: the outline block
 * lists one heading per line, indented two spaces per level below the top;
 * each excerpt is a "## <heading>" line followed by one line of text.
 */
const DIGEST_OUTLINE = 'DOCUMENT OUTLINE';
const DIGEST_EXCERPTS = 'EXCERPTS:';

const cleanTitle = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE).trim() : '');

/**
 * Bring an outline (from the model or the offline generator) inside the
 * limits apply-structure accepts, so "Add all to course" never fails
 * validation: titles trimmed to 2..160 chars (shorter ones dropped),
 * summaries ≤ 500 chars, at most 12 sections of at most 12 lessons, and only
 * the first section as the free preview.
 */
export function clampCourseStructure(raw: unknown): GeneratedSection[] {
  const sections: GeneratedSection[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    if (sections.length >= MAX_SECTIONS) break;
    const title = cleanTitle((s as { title?: unknown })?.title);
    if (title.length < 2) continue;
    const lessons: GeneratedLesson[] = [];
    const rawLessons = (s as { lessons?: unknown })?.lessons;
    for (const l of Array.isArray(rawLessons) ? rawLessons : []) {
      if (lessons.length >= MAX_LESSONS) break;
      const lessonTitle = cleanTitle((l as { title?: unknown })?.title);
      if (lessonTitle.length < 2) continue;
      const rawSummary = (l as { summary?: unknown })?.summary;
      const summary = typeof rawSummary === 'string' ? rawSummary.trim().slice(0, MAX_SUMMARY).trim() : '';
      lessons.push(summary ? { title: lessonTitle, summary } : { title: lessonTitle });
    }
    sections.push({ title, is_free_preview: sections.length === 0, lessons });
  }
  return sections;
}

export interface OutlineHeading {
  title: string;
  /** 1 = top level. */
  level: number;
}

// Heading-shaped lines in pasted notes (kept close to outline-source.ts).
const KEYWORD_HEADING = /^(part|chapter|unit|module|section|lesson|ምዕራፍ|ክፍል)(?=$|[\s:.\-–—\d])/i;
const KEYWORD_LEVEL: Record<string, number> = { part: 1, chapter: 2, unit: 2, module: 2, ምዕራፍ: 2, section: 3, lesson: 3, ክፍል: 3 };
const NUMBERED_HEADING = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+([A-Z\u1200-\u137F][^,]*)$/;
/** Longer lines in pasted notes are prose, never headings. */
const MAX_HEADING_LINE = 200;

/**
 * A markdown ATX heading ("## Title" or "## Title ##"). Parsed by hand
 * because the obvious `/^(#{1,6})\s+(.+?)\s*#*$/` backtracks quadratically
 * (about 3.5 s on "# a" + 30,000 spaces + "b"). The only regex here is
 * anchored with nothing after its last quantifier, so it is linear.
 */
function markdownHeading(line: string): OutlineHeading | null {
  const open = /^(#{1,6})\s+/.exec(line);
  if (!open) return null;
  let title = line.slice(open[0].length).trimEnd();
  // A closing run of '#' is dropped only when whitespace precedes it
  // (CommonMark), so "Intro to C#" keeps its '#'.
  let cut = title.length;
  while (cut > 0 && title[cut - 1] === '#') cut--;
  if (cut === 0) title = '';
  else if (cut < title.length && /\s/.test(title[cut - 1])) title = title.slice(0, cut).trimEnd();
  return title ? { title, level: open[1].length } : null;
}

/**
 * The headings of a source text: the digest's DOCUMENT OUTLINE block when
 * present, otherwise lines that look like headings (markdown `#`,
 * Chapter/Unit/Module/Part/Section/Lesson/ምዕራፍ/ክፍል, or "1.2 Title").
 */
export function outlineHeadings(sourceText: string): OutlineHeading[] {
  const lines = sourceText.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith(DIGEST_OUTLINE));
  if (start >= 0) {
    const headings: OutlineHeading[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.trim() || line.trim() === DIGEST_EXCERPTS) break;
      // Tolerate a hand-edited outline written as markdown headings.
      headings.push({ title: line.trim().replace(/^#{1,6}\s+/, ''), level: Math.floor((line.length - line.trimStart().length) / 2) + 1 });
    }
    return headings;
  }
  const headings: OutlineHeading[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    // Checked before any regex: a real heading is short (titles are clamped
    // to 160 chars anyway), and this bounds the work any pattern below can
    // do on a hostile 30,000-char line.
    if (!line || line.length > MAX_HEADING_LINE) continue;
    const md = markdownHeading(line);
    if (md) {
      headings.push(md);
      continue;
    }
    if (line.length > 100 || /[.,;]$/.test(line)) continue;
    const keyword = line.match(KEYWORD_HEADING);
    if (keyword && !/^[a-z]/.test(keyword[1])) {
      headings.push({ title: line, level: KEYWORD_LEVEL[keyword[1].toLowerCase()] ?? 2 });
      continue;
    }
    const numbered = line.match(NUMBERED_HEADING);
    if (numbered && !/\d$/.test(numbered[2])) headings.push({ title: line, level: 1 + numbered[1].split('.').length });
  }
  return headings;
}

/** "## heading" → the first sentence of its excerpt, from a digest's EXCERPTS block. */
function excerptSummaries(sourceText: string): Map<string, string> {
  const out = new Map<string, string>();
  const at = sourceText.indexOf(`\n${DIGEST_EXCERPTS}\n`);
  if (at < 0) return out;
  const lines = sourceText.slice(at + DIGEST_EXCERPTS.length + 2).split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].startsWith('## ') || !lines[i + 1].trim()) continue;
    // Only the first 200 chars are ever kept, so a longer look changes nothing
    // except how long the sentence scan can run on one huge excerpt line.
    const text = lines[i + 1].trim().slice(0, 400);
    const sentence = text.match(/^.{20,}?[.!?።](?=\s|$)/)?.[0] ?? text;
    out.set(lines[i].slice(3).trim().toLowerCase(), sentence.length > 200 ? `${sentence.slice(0, 199).trimEnd()}…` : sentence);
  }
  return out;
}

/**
 * Offline outline from a document's headings: one section per top-level
 * heading with its sub-headings as lessons, or — when there are more
 * top-level headings than requested sections — consecutive top-level
 * headings grouped into that many sections (more when needed so that no
 * chapter is cut). Empty when the text has fewer than two headings.
 */
export function outlineFromHeadings(input: CourseStructureInput): GeneratedSection[] {
  // The same cap the model gets. The DTO accepts more, and nothing past this
  // point should cost more than the digest the web client actually sends.
  const source = (input.source_text ?? '').slice(0, COURSE_SOURCE_LIMIT);
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  // The document's own title adds nothing as a section of a course with that title.
  const courseTitle = norm(input.title);
  let headings = outlineHeadings(source).filter((h) => norm(h.title) !== courseTitle);
  if (headings.length < 2) return [];
  headings = withImpliedChapters(headings);
  let top = Math.min(...headings.map((h) => h.level));
  // A lone top-level heading is the document title: outline what is under it.
  while (headings.filter((h) => h.level === top).length === 1 && headings.some((h) => h.level > top)) {
    headings = headings.filter((h) => h.level > top);
    top = Math.min(...headings.map((h) => h.level));
  }
  const tops: { title: string; children: string[] }[] = [];
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].level !== top) continue;
    // Scan forward to the next top-level heading. (A findIndex from 0 for
    // every chapter made this quadratic in the number of headings.)
    let end = i + 1;
    while (end < headings.length && headings[end].level > top) end++;
    const below = headings.slice(i + 1, end);
    const childLevel = Math.min(...below.map((n) => n.level));
    tops.push({ title: headings[i].title, children: below.filter((n) => n.level === childLevel).map((n) => n.title) });
  }
  const summaries = excerptSummaries(source);
  const lesson = (title: string) => {
    const summary = summaries.get(title.toLowerCase());
    return summary ? { title, summary } : { title };
  };
  const target = Math.max(1, Math.min(input.section_count, MAX_SECTIONS));
  // Go past the requested count when needed so that one lesson per chapter
  // always fits in a section: clampCourseStructure would otherwise cut the
  // chapters past the 12th of each group without a word.
  const groups = Math.min(MAX_SECTIONS, Math.max(Math.min(tops.length, target), Math.ceil(tops.length / MAX_LESSONS)));
  const sections: GeneratedSection[] = Array.from({ length: groups }, (_, g) => {
    const group = tops.slice(Math.floor((g * tops.length) / groups), Math.floor(((g + 1) * tops.length) / groups));
    if (group.length === 1) {
      const [only] = group;
      return { title: only.title, is_free_preview: false, lessons: (only.children.length ? only.children : [only.title]).map(lesson) };
    }
    // Several chapters share a section: their topics become its lessons when
    // they fit (a chapter without sub-headings stands for itself, so it is not
    // lost beside neighbours that have some), otherwise one lesson per chapter.
    const children = group.flatMap((t) => (t.children.length ? t.children : [t.title]));
    if (children.length <= MAX_LESSONS) {
      return { title: groupTitle(group.map((t) => t.title)), is_free_preview: false, lessons: children.map(lesson) };
    }
    // Only past 144 chapters can a group exceed 12; name it after the chapters it keeps.
    const kept = group.slice(0, MAX_LESSONS).map((t) => t.title);
    return { title: groupTitle(kept), is_free_preview: false, lessons: kept.map(lesson) };
  });
  return clampCourseStructure(splitLongSections(sections));
}

/**
 * A chapter with more topics than one section holds continues in
 * "<chapter> (part n)" sections while there is room under MAX_SECTIONS,
 * instead of losing its later topics to clampCourseStructure.
 */
function splitLongSections(sections: GeneratedSection[]): GeneratedSection[] {
  let room = MAX_SECTIONS - sections.length;
  return sections.flatMap((s) => {
    const parts = Math.min(Math.ceil(s.lessons.length / MAX_LESSONS), 1 + Math.max(0, room));
    if (parts <= 1) return [s];
    room -= parts - 1;
    // Even parts when they all fit; otherwise full parts of 12, and the topics
    // past the last part are dropped (there is no room left for another section).
    const size = Math.min(MAX_LESSONS, Math.ceil(s.lessons.length / parts));
    const base = s.title.slice(0, MAX_TITLE - 12).trim();
    return Array.from({ length: parts }, (_, p) => ({ ...s, title: `${base} (part ${p + 1})`, lessons: s.lessons.slice(p * size, (p + 1) * size) }));
  });
}

const NUMBER_PREFIX = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+/;

/**
 * Some PDFs bookmark only their numbered sub-sections ("1.1 …", "1.2 …",
 * "2.1 …") as one flat list. Grouped as-is, a course section would be titled
 * "1.1 Topic 1 of X – 3.4 Topic 4 of Z". When most same-level headings are
 * numbered at depth ≥ 2 and share leading numbers, insert the implied chapter
 * ("1", "2", …) above them, named after what its sub-sections have in common.
 */
function withImpliedChapters(headings: OutlineHeading[]): OutlineHeading[] {
  const level = headings[0].level;
  if (headings.some((h) => h.level !== level)) return headings;
  const numbers = headings.map((h) => h.title.match(NUMBER_PREFIX)?.[1].split('.') ?? null);
  const deep = numbers.filter((n) => n && n.length >= 2).length;
  if (deep < headings.length * 0.6) return headings;
  const chapters = new Set(numbers.filter((n): n is string[] => !!n && n.length >= 2).map((n) => n[0]));
  if (chapters.size < 2 || chapters.size === deep) return headings;

  // Each chapter's name is worked out once from all of its sub-sections. (Doing
  // it at every change of chapter number took seconds on a digest whose
  // numbering alternates "1.1", "2.1", "1.1", …)
  const members = new Map<string, string[]>();
  headings.forEach((h, i) => {
    const n = numbers[i];
    if (!n || n.length < 2) return;
    const list = members.get(n[0]) ?? [];
    if (!list.length) members.set(n[0], list);
    list.push(h.title.replace(NUMBER_PREFIX, ''));
  });
  const names = new Map<string, string>();
  const nameOf = (chapter: string) => {
    let name = names.get(chapter);
    if (name === undefined) names.set(chapter, (name = impliedChapterTitle(chapter, members.get(chapter) ?? [])));
    return name;
  };

  const out: OutlineHeading[] = [];
  let current: string | null = null;
  headings.forEach((h, i) => {
    const n = numbers[i];
    if (n && n.length >= 2 && n[0] !== current) {
      current = n[0];
      out.push({ title: nameOf(current), level });
    }
    out.push({ title: h.title, level: n && n.length >= 2 ? level + 1 : level });
  });
  return out;
}

/** "Topic 1 of Email Marketing", "Topic 2 of Email Marketing" → "Email Marketing"; else "Chapter 6". */
function impliedChapterTitle(number: string, titles: string[]): string {
  if (titles.length >= 2) {
    const words = titles.map((t) => t.split(/\s+/));
    // Count the shared trailing words, then slice once: prepending word by word
    // is quadratic in the length of a (hostile) multi-thousand-word title.
    let k = 0;
    while (words.every((w) => w.length > k && w[w.length - 1 - k] === words[0][words[0].length - 1 - k])) k++;
    const suffix = words[0].slice(words[0].length - k);
    let from = 0;
    while (from < suffix.length && /^(of|in|on|for|to|and|the|–|-|—|:)$/i.test(suffix[from])) from++;
    const common = suffix.slice(from).join(' ');
    // Every title identical is not a shared theme, just repetition.
    if (common.length >= 4 && titles.some((t) => t !== titles[0])) return common;
  }
  return `Chapter ${number}`;
}

/** Title for a section that merges consecutive chapters, without their numbering. */
function groupTitle(titles: string[]): string {
  const plain = titles.map((t) => t.replace(NUMBER_PREFIX, '').trim());
  const listed = plain.length === 2 ? plain.join(' & ') : `${plain.slice(0, -1).join(', ')} & ${plain[plain.length - 1]}`;
  return listed.length <= 120 ? listed : `${plain[0]} – ${plain[plain.length - 1]}`;
}

export class MockAiAssessor implements AiAssessor {
  readonly isLive = false;

  async generateVivaQuestion(courseTitle: string, topicContext: string): Promise<string> {
    return `In your own words, explain the most important concept from "${courseTitle}"${topicContext ? ` (${topicContext.slice(0, 80)})` : ''}. Describe how you would apply it to a real problem in Ethiopia.`;
  }

  async evaluateVivaAnswer(_question: string, answer: string): Promise<VivaEvaluation> {
    const words = answer.trim().split(/\s+/).filter(Boolean).length;
    const score = Math.min(100, Math.round((words / 60) * 100));
    return {
      score,
      feedback:
        score >= 60
          ? '[mock evaluator] Substantive answer demonstrating engagement with the material.'
          : '[mock evaluator] Answer too brief — explain the concept in more depth.',
    };
  }

  async gradeWrittenAnswer(question: string, answer: string, guidance?: string): Promise<WrittenGrade> {
    const words = answer.trim().split(/\s+/).filter(Boolean).length;
    // Offline heuristic: length + naive keyword overlap with the question/guidance.
    const keywords = `${question} ${guidance ?? ''}`.toLowerCase().match(/[a-z]{5,}/g) ?? [];
    const hit = keywords.filter((k) => answer.toLowerCase().includes(k)).length;
    const overlap = keywords.length ? hit / keywords.length : 0.5;
    const score = Math.min(100, Math.round(Math.min(1, words / 40) * 60 + overlap * 40));
    return {
      score,
      feedback:
        score >= 60
          ? '[mock grader] Answer addresses the question with reasonable depth.'
          : '[mock grader] Answer is too brief or off-topic — address the question directly and in more depth.',
    };
  }

  async plagiarismCheck(title: string, _description: string, corpus: string[] = []): Promise<PlagiarismResult> {
    // Offline heuristic: flag a near-identical title already in the catalog.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const t = norm(title);
    const dup = corpus.map(norm).find((c) => c && (c === t || c.includes(t) || t.includes(c)) && Math.min(c.length, t.length) > 6);
    if (dup) return { similarity_score: 85, flagged: true, reason: `[offline] Title closely matches an existing course ("${dup}").` };
    return { similarity_score: 4, flagged: false, reason: '[offline] no similarity detected' };
  }

  async generateQuiz(topic: string, count: number): Promise<QuizQuestion[]> {
    const n = Math.max(1, Math.min(count, 20));
    return Array.from({ length: n }, (_, i) => ({
      prompt: `[mock Q${i + 1}] Which statement about "${topic}" is correct?`,
      options: ['A plausible but wrong option', `The correct fact about ${topic}`, 'Another wrong option', 'Yet another wrong option'],
      correct_index: 1,
    }));
  }

  async generateCourseStructure(input: CourseStructureInput): Promise<GeneratedCourseStructure> {
    // With a document (or pasted notes with headings), a real draft of its
    // structure beats numbered placeholders.
    const fromDocument = outlineFromHeadings(input);
    if (fromDocument.length) return { sections: fromDocument, origin: 'headings' };
    const sections: GeneratedSection[] = Array.from({ length: Math.max(1, Math.min(input.section_count, 12)) }, (_, s) => ({
      title: `Section ${s + 1}: ${input.title} — part ${s + 1}`,
      is_free_preview: s === 0,
      lessons: Array.from({ length: Math.max(1, Math.min(input.lessons_per_section, 12)) }, (_, l) => ({
        title: `Lesson ${s + 1}.${l + 1}`,
        summary: '[mock] Draft lesson — edit before saving.',
      })),
    }));
    return { sections, origin: 'placeholder' };
  }

  /** Offline tutor: no model call — surfaces the best-matching excerpts verbatim. */
  async answerWithContext(input: TutorInput): Promise<TutorAnswer> {
    if (!input.chunks.length) {
      return { answer: "I couldn't find anything in this course's material about that. Try rephrasing, or ask your instructor directly.", sources: [], not_covered: true };
    }
    const top = input.chunks.slice(0, 3);
    return {
      answer: `The AI tutor is offline, but here is what the course material says:\n\n${top.map((c) => `• ${c.title}: ${c.text.slice(0, 280)}`).join('\n\n')}`,
      sources: top.map((c) => c.title),
      not_covered: false,
    };
  }

  /** Offline study plan: point at the outline sections nearest the missed topics. */
  async buildStudyPlan(courseTitle: string, score: number, missed: MissedQuestion[], outline: string[]): Promise<StudyPlan> {
    const plan = (missed.length ? missed : [{ prompt: 'the core concepts' }]).slice(0, 5).map((m) => ({
      focus: outline[0] ?? `Review "${courseTitle}"`,
      reason: `Revisit before retrying: ${(m.topic || m.prompt).slice(0, 120)}`,
    }));
    return {
      summary: `You scored ${score}%. Review the topics below and try again — you're close.`,
      plan,
    };
  }
}

export class GroqAiAssessor implements AiAssessor {
  readonly isLive = true;
  private readonly model = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

  private async chat(system: string, user: string, json = true): Promise<string> {
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.4,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        // The gateway gives up on the upstream at 30 s and answers a bare 502.
        // Stopping first lets the caller fall back and explain why instead.
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const text = await res.text();
        // Classify so callers can tell the operator to rotate the key (401 =
        // expired/invalid) or back off (429) rather than showing a generic error.
        const err = new Error(`Groq request failed (${res.status}): ${text.slice(0, 300)}`) as Error & { status?: number; reason?: string };
        err.status = res.status;
        if (res.status === 401 || /invalid[_ ]api[_ ]key|expired/i.test(text)) err.reason = 'auth';
        else if (res.status === 429) err.reason = 'rate_limit';
        throw err;
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error('Groq returned no content');
      return content.trim();
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw Object.assign(new Error(`Groq request timed out after ${CHAT_TIMEOUT_MS / 1000}s`), { reason: 'timeout' });
      }
      throw err;
    }
  }

  private parseJson<T>(raw: string): T {
    // Models occasionally wrap JSON in prose or code fences — extract defensively.
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : raw;
    const start = candidate.search(/[[{]/);
    const slice = start >= 0 ? candidate.slice(start) : candidate;
    return JSON.parse(slice) as T;
  }

  async generateVivaQuestion(courseTitle: string, topicContext: string): Promise<string> {
    const raw = await this.chat(
      'You are an oral examiner for an Ethiopian online learning platform. Reply with JSON {"question": "..."} — one open-ended question testing genuine understanding, no preamble.',
      `Course: ${courseTitle}\nTopic context: ${topicContext}`,
    );
    return this.parseJson<{ question: string }>(raw).question;
  }

  async evaluateVivaAnswer(question: string, answer: string): Promise<VivaEvaluation> {
    const raw = await this.chat(
      'You grade oral-exam answers. Reply with JSON {"score": 0-100, "feedback": "one short paragraph addressed to the learner"}.',
      `Question: ${question}\n\nLearner answer: ${answer}`,
    );
    const p = this.parseJson<VivaEvaluation>(raw);
    return { score: Math.max(0, Math.min(100, Math.round(p.score))), feedback: p.feedback };
  }

  async gradeWrittenAnswer(question: string, answer: string, guidance?: string, courseTitle?: string): Promise<WrittenGrade> {
    const raw = await this.chat(
      'You grade written exam answers strictly but fairly. Award marks for correctness, completeness and understanding — not length. Reply with JSON {"score": 0-100, "feedback": "2-3 sentences addressed to the learner explaining the mark and what a full answer needed"}.',
      `${courseTitle ? `Course: ${courseTitle}\n` : ''}Exam question: ${question}\n${guidance ? `Educator marking guidance (what a good answer covers): ${guidance}\n` : ''}\nLearner's answer:\n${answer.slice(0, 6000)}`,
    );
    const p = this.parseJson<WrittenGrade>(raw);
    return { score: Math.max(0, Math.min(100, Math.round(p.score))), feedback: p.feedback };
  }

  async plagiarismCheck(title: string, description: string, corpus: string[] = []): Promise<PlagiarismResult> {
    const catalog = corpus.length
      ? `\n\nExisting courses already on this platform (flag if the submission is a near-duplicate of any):\n${corpus.slice(0, 60).map((c) => `- ${c}`).join('\n')}`
      : '';
    const raw = await this.chat(
      'You screen online-course listings for spam, keyword stuffing, fabricated claims, content copied from well-known courses, AND near-duplication of the existing platform catalog provided. Reply with JSON {"similarity_score": 0-100, "flagged": bool (true if score > 70, a clear duplicate, or clearly spam), "reason": "one sentence explaining the decision"}.',
      `Course title: ${title}\n\nDescription: ${description}${catalog}`,
    );
    return this.parseJson<PlagiarismResult>(raw);
  }

  async generateQuiz(topic: string, count: number, difficulty = 'mixed'): Promise<QuizQuestion[]> {
    const n = Math.max(1, Math.min(count, 20));
    const raw = await this.chat(
      `You write multiple-choice quiz questions. Reply with JSON {"questions": [{"prompt": "...", "options": ["...","...","...","..."], "correct_index": 0}]}. Exactly ${n} questions, ${difficulty} difficulty, each with 3-4 options and exactly one correct answer (correct_index is 0-based).`,
      `Topic: ${topic}`,
    );
    const parsed = this.parseJson<{ questions: QuizQuestion[] }>(raw);
    return (parsed.questions ?? []).slice(0, n).map((q) => ({
      prompt: q.prompt,
      options: q.options,
      correct_index: Math.max(0, Math.min(q.correct_index ?? 0, (q.options?.length ?? 1) - 1)),
    }));
  }

  async answerWithContext(input: TutorInput): Promise<TutorAnswer> {
    if (!input.chunks.length) {
      return { answer: "I couldn't find anything in this course's material about that. Try rephrasing, or ask your instructor directly.", sources: [], not_covered: true };
    }
    const context = input.chunks.map((c, i) => `[${i + 1}] ${c.title}\n${c.text}`).join('\n\n');
    const history = input.history.slice(-6).map((h) => `${h.role === 'user' ? 'Learner' : 'Tutor'}: ${h.content.slice(0, 600)}`).join('\n');
    const raw = await this.chat(
      `You are the course tutor for "${input.course_title}" on EthiopiaLearn. Answer the learner's question using ONLY the numbered course excerpts provided. Be concise, friendly and concrete; use short paragraphs or bullets. Reply in the same language the learner wrote in (Amharic if they wrote Amharic). If the excerpts do not contain the answer, say you couldn't find it in the course material and suggest asking the instructor — never invent facts. Reply with JSON {"answer": "...", "sources": [excerpt numbers you used, e.g. 1, 3], "not_covered": bool}.`,
      `${history ? `Conversation so far:\n${history}\n\n` : ''}Course excerpts:\n${context.slice(0, 14000)}\n\nLearner question: ${input.question.slice(0, 1500)}`,
    );
    const p = this.parseJson<{ answer: string; sources?: (number | string)[]; not_covered?: boolean }>(raw);
    const titles = (p.sources ?? [])
      .map((n) => input.chunks[Number(n) - 1]?.title)
      .filter((t): t is string => !!t);
    return { answer: p.answer, sources: [...new Set(titles)], not_covered: !!p.not_covered };
  }

  async buildStudyPlan(courseTitle: string, score: number, missed: MissedQuestion[], outline: string[]): Promise<StudyPlan> {
    const raw = await this.chat(
      'You are an encouraging study coach on EthiopiaLearn. A learner just took a quiz and got some questions wrong. Using ONLY the course outline provided, produce a short, specific review plan that points them at the outline sections most relevant to what they missed. Be warm and concrete; never invent lessons that are not in the outline. Reply in the learner\'s likely language (Amharic if the questions are in Amharic). Reply with JSON {"summary": "one encouraging paragraph", "plan": [{"focus": "an outline section title, verbatim", "reason": "the concept to revisit, one sentence"}]} — at most 5 plan items.',
      `Course: ${courseTitle}\nScore: ${score}%\n\nCourse outline (use these titles verbatim in "focus"):\n${outline.slice(0, 40).map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\nQuestions the learner got wrong:\n${missed.slice(0, 15).map((m, i) => `${i + 1}. ${m.prompt}${m.topic ? ` [topic: ${m.topic}]` : ''}`).join('\n') || '(none — they passed, reinforce the whole course)'}`,
    );
    const p = this.parseJson<StudyPlan>(raw);
    return {
      summary: p.summary ?? `You scored ${score}%. Review the topics below and try again.`,
      plan: (p.plan ?? []).slice(0, 5).filter((x) => x?.focus),
    };
  }

  async generateCourseStructure(input: CourseStructureInput): Promise<GeneratedCourseStructure> {
    const sc = Math.max(1, Math.min(input.section_count, MAX_SECTIONS));
    const lc = Math.max(1, Math.min(input.lessons_per_section, MAX_LESSONS));
    const level = input.level ? `Target learner level: ${input.level}. ` : '';
    const style = input.learning_style ? `Preferred learning style: ${input.learning_style} — shape lesson titles accordingly. ` : '';
    const source = (input.source_text ?? '').slice(0, COURSE_SOURCE_LIMIT);
    const grounding = source.trim()
      ? `Base the outline on the provided material. The DOCUMENT OUTLINE is authoritative for order and scope; group chapters into about ${sc} sections; do not invent topics absent from the material; lesson summaries one sentence.`
      : 'Base the outline on the educator prompt; lesson summaries one sentence.';
    const raw = await this.chat(
      `You design online course outlines. Reply with JSON {"sections": [{"title": "...", "is_free_preview": bool, "lessons": [{"title": "...", "summary": "one sentence"}]}]}. Produce about ${sc} sections with about ${lc} lessons each (never more than ${MAX_SECTIONS} sections or ${MAX_LESSONS} lessons per section). Mark ONLY the first section is_free_preview:true. ${level}${style}${grounding} Sequence lessons pedagogically from foundations to mastery.`,
      `Course title: ${input.title}\nEducator prompt: ${input.prompt ?? '(none)'}\n\nSource material:\n${source || '(none)'}`,
    );
    const parsed = this.parseJson<{ sections?: unknown }>(raw);
    const sections = clampCourseStructure(parsed.sections);
    if (sections.length) return { sections, origin: 'model' };
    // Valid JSON of the wrong shape (or only unusable titles): hand back the
    // offline draft, but with its own origin so the caller does not present
    // it as the AI's reading of the document.
    return new MockAiAssessor().generateCourseStructure(input);
  }
}

// (Groq tutor implementation lives inside GroqAiAssessor above.)

export function createAiAssessor(): AiAssessor {
  return groqConfigured() ? new GroqAiAssessor() : new MockAiAssessor();
}
