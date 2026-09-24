import { createHash } from 'crypto';
import type { RevisionDiffSummary } from '@ethiopialearn/contracts';

/**
 * Pure helpers for staged revisions of a live course: merge the staged
 * (pending) values over the live rows, diff them, summarise the diff and hash
 * the staged state. No I/O here so the rules are unit-testable in isolation.
 *
 * Row model (see entities.ts): the live values sit in the normal columns;
 * `pending` holds partial overrides and `pending_state` marks rows that are
 * 'added' (not live yet) or 'removed' (still live until the revision applies).
 */

export interface CoursePendingFields {
  title?: string;
  description?: string;
  category?: string;
  thumbnail_url?: string | null;
  pricing_type?: string;
  price_etb?: string | null;
}

export interface SectionPendingFields {
  title?: string;
  is_free_preview?: boolean;
}

export interface LessonPendingFields {
  title?: string;
  summary?: string | null;
  duration_seconds?: number;
  video_s3_key?: string | null;
}

export interface CourseLike {
  id: string;
  title: string;
  description: string;
  category: string;
  thumbnail_url: string | null;
  pricing_type: string;
  price_etb: string | null;
  status: string;
  pending?: CoursePendingFields | null;
}

export interface SectionLike {
  id: string;
  title: string;
  order_index: number;
  is_free_preview: boolean;
  pending_state?: string | null;
  pending?: SectionPendingFields | null;
}

export interface LessonLike {
  id: string;
  section_id: string;
  title: string;
  summary: string | null;
  duration_seconds: number;
  video_s3_key: string | null;
  order_index: number;
  pending_state?: string | null;
  pending?: LessonPendingFields | null;
}

/** A pending tutor-note chunk (course_knowledge row with state='pending'). */
export interface KnowledgeLike {
  title: string;
  text: string;
  chunk_index: number;
}

/** Everything staged for one course, as loaded from the database. */
export interface RevisionState {
  course: CourseLike;
  sections: SectionLike[];
  lessons: LessonLike[];
  pendingKnowledge: KnowledgeLike[];
}

export const COURSE_DIFF_FIELDS = ['title', 'description', 'category', 'thumbnail_url', 'pricing_type', 'price_etb'] as const;
export type CourseDiffField = (typeof COURSE_DIFF_FIELDS)[number];

export const CHANGED_TEXT_MAX = 8000;
export const KNOWLEDGE_EXCERPT_MAX = 400;

export interface RevisionDiffBody {
  course: { id: string; title: string; status: string; thumbnail_url: string | null };
  metadata: { field: CourseDiffField; before: unknown; after: unknown }[];
  sections: {
    added: { id: string; title: string; is_free_preview: boolean; lessons: { id: string; title: string; summary: string | null; has_video: boolean }[] }[];
    removed: { id: string; title: string }[];
    changed: { id: string; before: { title: string; is_free_preview: boolean }; after: { title: string; is_free_preview: boolean } }[];
  };
  lessons: {
    added: { id: string; section_id: string; section_title: string; title: string; summary: string | null; has_video: boolean }[];
    removed: { id: string; section_title: string; title: string }[];
    changed: {
      id: string;
      section_title: string;
      title_before: string;
      title_after: string;
      summary_before: string | null;
      summary_after: string | null;
      duration_before: number;
      duration_after: number;
      video_replaced: boolean;
    }[];
  };
  knowledge_added: { title: string; chars: number; excerpt: string }[];
  pending_assessments: unknown[];
  diff_summary: RevisionDiffSummary;
  empty: boolean;
}

// ---- merge ------------------------------------------------------------------

function has<T extends object>(obj: T | null | undefined, key: keyof T): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

function pick<T extends object, K extends keyof T>(pending: T | null | undefined, key: K, live: T[K]): T[K] {
  return pending && has(pending, key) ? (pending[key] as T[K]) : live;
}

/** Prices come back from Postgres as '500.00' but may be staged as '500' — compare numerically. */
export function normPrice(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mergedCourse(c: CourseLike) {
  const p = c.pending ?? null;
  return {
    title: pick<CoursePendingFields, 'title'>(p, 'title', c.title) as string,
    description: pick<CoursePendingFields, 'description'>(p, 'description', c.description) as string,
    category: pick<CoursePendingFields, 'category'>(p, 'category', c.category) as string,
    thumbnail_url: pick<CoursePendingFields, 'thumbnail_url'>(p, 'thumbnail_url', c.thumbnail_url) ?? null,
    pricing_type: pick<CoursePendingFields, 'pricing_type'>(p, 'pricing_type', c.pricing_type) as string,
    price_etb: pick<CoursePendingFields, 'price_etb'>(p, 'price_etb', c.price_etb) ?? null,
  };
}

export function mergedSection(s: SectionLike) {
  const p = s.pending ?? null;
  return {
    title: pick<SectionPendingFields, 'title'>(p, 'title', s.title) as string,
    is_free_preview: !!pick<SectionPendingFields, 'is_free_preview'>(p, 'is_free_preview', s.is_free_preview),
  };
}

export function mergedLesson(l: LessonLike) {
  const p = l.pending ?? null;
  return {
    title: pick<LessonPendingFields, 'title'>(p, 'title', l.title) as string,
    summary: pick<LessonPendingFields, 'summary'>(p, 'summary', l.summary) ?? null,
    duration_seconds: pick<LessonPendingFields, 'duration_seconds'>(p, 'duration_seconds', l.duration_seconds) ?? 0,
    video_s3_key: pick<LessonPendingFields, 'video_s3_key'>(p, 'video_s3_key', l.video_s3_key) ?? null,
  };
}

function sameValue(field: CourseDiffField, a: unknown, b: unknown): boolean {
  if (field === 'price_etb') return normPrice(a as string | null) === normPrice(b as string | null);
  return (a ?? null) === (b ?? null);
}

function byOrder<T extends { order_index: number; id: string }>(a: T, b: T) {
  return a.order_index - b.order_index || a.id.localeCompare(b.id);
}

/** Pending note chunks grouped per document, in chunk order. */
function knowledgeDocs(chunks: KnowledgeLike[]) {
  const docs = new Map<string, KnowledgeLike[]>();
  for (const k of chunks) docs.set(k.title, [...(docs.get(k.title) ?? []), k]);
  return [...docs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([title, rows]) => {
      const ordered = [...rows].sort((a, b) => a.chunk_index - b.chunk_index);
      return { title, chunks: ordered.length, chars: ordered.reduce((n, r) => n + r.text.length, 0), text: ordered.map((r) => r.text).join(' ') };
    });
}

// ---- diff -------------------------------------------------------------------

/** Before/after of everything the revision would change on the live course. */
export function computeDiff(state: RevisionState, pendingAssessments: unknown[] = []): RevisionDiffBody {
  const { course } = state;
  const merged = mergedCourse(course);

  const metadata: RevisionDiffBody['metadata'] = [];
  for (const field of COURSE_DIFF_FIELDS) {
    if (!has(course.pending ?? null, field)) continue;
    const before = course[field];
    const after = merged[field];
    if (sameValue(field, before, after)) continue;
    metadata.push(field === 'price_etb' ? { field, before: normPrice(before), after: normPrice(after) } : { field, before: before ?? null, after: after ?? null });
  }

  const sections = [...state.sections].sort(byOrder);
  const lessonsBySection = new Map<string, LessonLike[]>();
  for (const l of [...state.lessons].sort(byOrder)) {
    lessonsBySection.set(l.section_id, [...(lessonsBySection.get(l.section_id) ?? []), l]);
  }

  const diff: RevisionDiffBody = {
    course: { id: course.id, title: course.title, status: course.status, thumbnail_url: course.thumbnail_url },
    metadata,
    sections: { added: [], removed: [], changed: [] },
    lessons: { added: [], removed: [], changed: [] },
    knowledge_added: knowledgeDocs(state.pendingKnowledge).map((d) => ({ title: d.title, chars: d.chars, excerpt: d.text.slice(0, KNOWLEDGE_EXCERPT_MAX) })),
    pending_assessments: pendingAssessments,
    diff_summary: undefined as unknown as RevisionDiffSummary,
    empty: false,
  };

  for (const section of sections) {
    const ms = mergedSection(section);
    const children = lessonsBySection.get(section.id) ?? [];
    if (section.pending_state === 'added') {
      diff.sections.added.push({
        id: section.id,
        title: ms.title,
        is_free_preview: ms.is_free_preview,
        lessons: children
          .filter((l) => l.pending_state !== 'removed')
          .map((l) => {
            const ml = mergedLesson(l);
            return { id: l.id, title: ml.title, summary: ml.summary, has_video: !!ml.video_s3_key };
          }),
      });
      continue;
    }
    if (section.pending_state === 'removed') {
      diff.sections.removed.push({ id: section.id, title: section.title });
      // Every live lesson of a removed section disappears with it; 'added'
      // children were never live, so they are not a removal learners notice.
      for (const l of children) {
        if (l.pending_state !== 'added') diff.lessons.removed.push({ id: l.id, section_title: section.title, title: l.title });
      }
      continue;
    }
    if (ms.title !== section.title || ms.is_free_preview !== section.is_free_preview) {
      diff.sections.changed.push({
        id: section.id,
        before: { title: section.title, is_free_preview: section.is_free_preview },
        after: { title: ms.title, is_free_preview: ms.is_free_preview },
      });
    }
    for (const l of children) {
      const ml = mergedLesson(l);
      if (l.pending_state === 'added') {
        diff.lessons.added.push({ id: l.id, section_id: section.id, section_title: ms.title, title: ml.title, summary: ml.summary, has_video: !!ml.video_s3_key });
      } else if (l.pending_state === 'removed') {
        diff.lessons.removed.push({ id: l.id, section_title: section.title, title: l.title });
      } else {
        const videoChanged = ml.video_s3_key !== (l.video_s3_key ?? null);
        if (ml.title !== l.title || ml.summary !== (l.summary ?? null) || ml.duration_seconds !== l.duration_seconds || videoChanged) {
          diff.lessons.changed.push({
            id: l.id,
            section_title: ms.title,
            title_before: l.title,
            title_after: ml.title,
            summary_before: l.summary ?? null,
            summary_after: ml.summary,
            duration_before: l.duration_seconds,
            duration_after: ml.duration_seconds,
            // A cleared key is a change but not a new video for the reviewer to watch.
            video_replaced: videoChanged && !!ml.video_s3_key,
          });
        }
      }
    }
  }
  diff.diff_summary = diffSummary(diff);
  diff.empty = isEmptyDiff(diff);
  return diff;
}

export function isEmptyDiff(diff: Pick<RevisionDiffBody, 'metadata' | 'sections' | 'lessons' | 'knowledge_added' | 'pending_assessments'>): boolean {
  return (
    diff.metadata.length === 0 &&
    diff.sections.added.length === 0 &&
    diff.sections.removed.length === 0 &&
    diff.sections.changed.length === 0 &&
    diff.lessons.added.length === 0 &&
    diff.lessons.removed.length === 0 &&
    diff.lessons.changed.length === 0 &&
    diff.knowledge_added.length === 0 &&
    diff.pending_assessments.length === 0
  );
}

/** Deterministic counts for the QA queue chips (contracts RevisionDiffSummary). */
export function diffSummary(diff: Omit<RevisionDiffBody, 'diff_summary' | 'empty'>): RevisionDiffSummary {
  const meta = (f: CourseDiffField) => diff.metadata.find((m) => m.field === f);
  // from/to stay null when the value is unchanged, so "price changed" is simply from !== to.
  const priceMeta = meta('price_etb');
  const typeMeta = meta('pricing_type');
  return {
    fields_changed: diff.metadata.map((m) => m.field),
    sections_added: diff.sections.added.length,
    sections_removed: diff.sections.removed.length,
    sections_changed: diff.sections.changed.length,
    lessons_added: diff.lessons.added.length + diff.sections.added.reduce((n, s) => n + s.lessons.length, 0),
    lessons_removed: diff.lessons.removed.length,
    lessons_changed: diff.lessons.changed.length,
    videos_replaced: diff.lessons.changed.filter((l) => l.video_replaced).length,
    price_from: priceMeta ? (priceMeta.before as number | null) : null,
    price_to: priceMeta ? (priceMeta.after as number | null) : null,
    pricing_type_from: typeMeta ? (typeMeta.before as string | null) : null,
    pricing_type_to: typeMeta ? (typeMeta.after as string | null) : null,
    new_free_preview_section:
      diff.sections.added.some((s) => s.is_free_preview) || diff.sections.changed.some((s) => !s.before.is_free_preview && s.after.is_free_preview),
    knowledge_added: diff.knowledge_added.length,
    assessments_added: diff.pending_assessments.length,
  };
}

/**
 * Ids of pending assessments as the outcomes service returns them (each item
 * carries its `id`). Frozen into the revision at submit: these, and only these,
 * are what the reviewer decides on.
 */
export function pendingAssessmentIds(items: unknown[] | null | undefined): string[] {
  const ids = (items ?? [])
    .map((a) => (a && typeof a === 'object' ? (a as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)];
}

/**
 * The pending assessments that belong to a submitted revision: those frozen at
 * submit. One created afterwards is not part of this decision (it stays
 * pending for the next revision), so the reviewer must not see it here.
 */
export function frozenAssessments(items: unknown[], frozenIds: string[]): unknown[] {
  const keep = new Set(frozenIds);
  return items.filter((a) => pendingAssessmentIds([a]).some((id) => keep.has(id)));
}

/** Lesson ids downstream services react to once the revision is applied. */
export function closeLessonIds(diff: Pick<RevisionDiffBody, 'sections' | 'lessons'>) {
  return {
    added_lesson_ids: [...diff.lessons.added.map((l) => l.id), ...diff.sections.added.flatMap((s) => s.lessons.map((l) => l.id))],
    removed_lesson_ids: diff.lessons.removed.map((l) => l.id),
    replaced_video_lesson_ids: diff.lessons.changed.filter((l) => l.video_replaced).map((l) => l.id),
  };
}

/**
 * New or changed learner-facing text only (for the QO's plagiarism/spam
 * screen). Unchanged live text is left out so the screen judges the edit, not
 * the whole course again.
 */
export function changedText(diff: Pick<RevisionDiffBody, 'metadata' | 'sections' | 'lessons' | 'knowledge_added'>): string {
  const lines: (string | null | undefined)[] = [];
  for (const m of diff.metadata) {
    if (m.field === 'title' || m.field === 'description') lines.push(m.after as string | null);
  }
  for (const s of diff.sections.added) {
    lines.push(s.title);
    for (const l of s.lessons) lines.push(l.title, l.summary);
  }
  for (const s of diff.sections.changed) {
    if (s.before.title !== s.after.title) lines.push(s.after.title);
  }
  for (const l of diff.lessons.added) lines.push(l.title, l.summary);
  for (const l of diff.lessons.changed) {
    if (l.title_after !== l.title_before) lines.push(l.title_after);
    if (l.summary_after !== l.summary_before) lines.push(l.summary_after);
  }
  for (const k of diff.knowledge_added) lines.push(`${k.title}: ${k.excerpt}`);
  return lines
    .map((t) => (t ?? '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, CHANGED_TEXT_MAX);
}

// ---- merged-course validation ------------------------------------------------

/**
 * The same publishability rules as a first submission, applied to the course
 * as it will look after the revision is applied. Returns an actionable
 * message, or null when the merged course is valid.
 */
export function validateMerged(state: RevisionState): string | null {
  const merged = mergedCourse(state.course);
  const liveAfter = state.sections.filter((s) => s.pending_state !== 'removed');
  const liveAfterIds = new Set(liveAfter.map((s) => s.id));
  const lessonsAfter = state.lessons.filter((l) => l.pending_state !== 'removed' && liveAfterIds.has(l.section_id));
  if (liveAfter.length === 0) return 'Your updated course would have no sections. Add a section or undo a section removal before submitting.';
  if (lessonsAfter.length === 0) return 'Your updated course would have no lessons. Add a lesson or undo a lesson removal before submitting.';
  if (!merged.thumbnail_url) return 'A thumbnail is required. Upload one before submitting your changes.';
  if (merged.pricing_type === 'paid' && !normPrice(merged.price_etb)) return 'Paid courses need a price. Set price_etb before submitting your changes.';
  if (merged.pricing_type === 'freemium' && !liveAfter.some((s) => mergedSection(s).is_free_preview)) {
    return 'Freemium courses need at least one free-preview section. Mark a section as free preview before submitting your changes.';
  }
  return null;
}

// ---- content hash ------------------------------------------------------------

/** JSON with object keys sorted at every level, so logically equal state hashes equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function emptyToNull<T extends object>(v: T | null | undefined): T | null {
  return v && Object.values(v).some((x) => x !== undefined) ? v : null;
}

/**
 * sha256 over every piece of staged state: course.pending, each section/lesson
 * marker + pending overrides (and the content of 'added' rows, whose values
 * live in the normal columns), the pending tutor notes and the ids of the
 * pending assessments frozen at submit. Frozen at submit and re-checked at
 * apply, so a QO never approves something other than what they reviewed.
 * The assessment ids also make the hash name one submission: a revision id is
 * reused when the educator withdraws and resubmits, and a resubmission that
 * only adds an assessment must not match an approval of the earlier one.
 * Row order and key order do not affect the hash.
 */
export function contentHash(state: RevisionState, assessmentIds: string[] = []): string {
  const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
  const canonical = {
    course: emptyToNull(state.course.pending ?? null),
    sections: state.sections
      .filter((s) => s.pending_state || emptyToNull(s.pending ?? null))
      .sort(byId)
      .map((s) => ({
        id: s.id,
        state: s.pending_state ?? null,
        pending: emptyToNull(s.pending ?? null),
        ...(s.pending_state === 'added' ? { title: s.title, is_free_preview: s.is_free_preview } : {}),
      })),
    lessons: state.lessons
      .filter((l) => l.pending_state || emptyToNull(l.pending ?? null))
      .sort(byId)
      .map((l) => ({
        id: l.id,
        section_id: l.section_id,
        state: l.pending_state ?? null,
        pending: emptyToNull(l.pending ?? null),
        ...(l.pending_state === 'added'
          ? { title: l.title, summary: l.summary ?? null, duration_seconds: l.duration_seconds, video_s3_key: l.video_s3_key ?? null }
          : {}),
      })),
    knowledge: knowledgeDocs(state.pendingKnowledge).map((d) => ({ title: d.title, chars: d.chars, chunks: d.chunks })),
    // Only present when there are assessments, so a revision without any
    // hashes exactly as it did before assessments were part of the hash.
    ...(assessmentIds.length ? { assessments: [...new Set(assessmentIds)].sort() } : {}),
  };
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

// ---- change log --------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  description: 'description',
  category: 'category',
  thumbnail_url: 'thumbnail',
  pricing_type: 'pricing',
  price_etb: 'price',
};

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function listJoin(items: string[]) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** One human sentence for the change log when the educator gave no summary. */
export function changelogSentence(s: RevisionDiffSummary): string {
  const parts: string[] = [];
  if (s.sections_added) parts.push(`${plural(s.sections_added, 'new section')}`);
  if (s.lessons_added) parts.push(`${plural(s.lessons_added, 'new lesson')}`);
  if (s.lessons_changed) parts.push(`${plural(s.lessons_changed, 'lesson')} updated`);
  if (s.videos_replaced) parts.push(`${plural(s.videos_replaced, 'video')} replaced`);
  if (s.sections_changed) parts.push(`${plural(s.sections_changed, 'section')} updated`);
  if (s.lessons_removed) parts.push(`${plural(s.lessons_removed, 'lesson')} removed`);
  if (s.sections_removed) parts.push(`${plural(s.sections_removed, 'section')} removed`);
  if (s.assessments_added) parts.push(`${plural(s.assessments_added, 'new assessment')}`);
  if (s.knowledge_added) parts.push(`${plural(s.knowledge_added, 'new tutor note')}`);
  const fields = [...new Set(s.fields_changed.map((f) => FIELD_LABELS[f] ?? f))];
  if (fields.length) parts.push(`updated ${listJoin(fields)}`);
  if (!parts.length) return 'Course content updated.';
  return `Course updated: ${parts.join(', ')}.`;
}
