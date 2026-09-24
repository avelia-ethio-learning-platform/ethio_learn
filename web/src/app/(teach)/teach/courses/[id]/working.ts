/**
 * Pure helpers for the course authoring page: the working-copy shape returned
 * by GET /courses/:id/working, the edit lock, staged-change badges and the
 * AI outline payload. Free of React so the rules are unit-tested.
 */

import { textToBlocks, type ExtractResult } from '@/lib/extract-text';
import { buildDigest, DIGEST_BUDGET_CHARS, fitsDigestBudget, type Digest } from '@/lib/outline-source';
import type { ResumableUploadInfo } from '@/lib/upload';

export type PendingState = 'added' | 'removed' | null;

export interface WorkingLesson {
  id: string;
  title: string;
  summary: string | null;
  duration_seconds: number;
  order: number;
  has_video: boolean;
  video_pending: boolean;
  pending_state: PendingState;
  changed_fields: string[];
}

export interface WorkingSection {
  id: string;
  title: string;
  order: number;
  is_free_preview: boolean;
  pending_state: PendingState;
  changed_fields: string[];
  lessons: WorkingLesson[];
}

export interface WorkingRevision {
  id: string;
  status: string;
  changelog_summary: string | null;
  major: boolean;
  submitted_at: string | null;
  decision_notes: string | null;
}

export interface ReviewFeedbackView {
  action: string;
  notes: string | null;
  reviewed_at: string | null;
}

/** GET /courses/:id/working — live values overlaid with staged edits. */
export interface WorkingCourse {
  id: string;
  title: string;
  description: string;
  category: string;
  language: string;
  thumbnail_url: string | null;
  pricing_type: 'free' | 'freemium' | 'paid';
  price_etb: number | null;
  status: string;
  review_feedback: ReviewFeedbackView | null;
  pending_fields: string[];
  has_pending_changes: boolean;
  revision: WorkingRevision | null;
  pending_assessments_count: number;
  pending_knowledge_count: number;
  sections: WorkingSection[];
}

export const LIVE_STATUSES = ['published', 'unlisted'];
/** A first-time submission waiting for a decision: the server refuses edits (409). */
export const COURSE_IN_REVIEW = ['submitted', 'under_review', 'institution_review'];
/** A live course's staged update waiting for a decision: also locked until withdrawn. */
export const REVISION_IN_REVIEW = ['submitted', 'institution_review'];

export interface EditState {
  /** Approved course: every edit is staged until a quality review approves it. */
  live: boolean;
  /** Editing tools are offered at all (archived and flagged courses have none). */
  canEdit: boolean;
  /** Editing tools are shown but disabled because something is in review. */
  locked: boolean;
  lockReason: string | null;
}

export function editState(course: Pick<WorkingCourse, 'status' | 'revision'>): EditState {
  const live = LIVE_STATUSES.includes(course.status);
  const canEdit = !['archived', 'flagged'].includes(course.status);
  let lockReason: string | null = null;
  if (COURSE_IN_REVIEW.includes(course.status)) {
    lockReason = 'This course is in review, so editing is locked. Withdraw it to make changes.';
  } else if (live && course.revision && REVISION_IN_REVIEW.includes(course.revision.status)) {
    lockReason = 'Your changes are in review, so editing is locked. Withdraw them to keep editing.';
  }
  return { live, canEdit, locked: lockReason !== null, lockReason };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Course fields as the educator knows them (pending_fields uses column names). */
export const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  description: 'description',
  category: 'category',
  thumbnail_url: 'thumbnail',
  pricing_type: 'pricing',
  price_etb: 'price',
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/_/g, ' ');
}

/** Short chips summarising everything staged on a live course, for the "unpublished changes" banner. */
export function stagedChangeChips(course: Pick<WorkingCourse, 'pending_fields' | 'sections' | 'pending_knowledge_count' | 'pending_assessments_count'>): string[] {
  let sectionsAdded = 0;
  let sectionsRemoved = 0;
  let sectionsEdited = 0;
  let lessonsAdded = 0;
  let lessonsRemoved = 0;
  let lessonsEdited = 0;
  let videos = 0;
  for (const s of course.sections) {
    if (s.pending_state === 'added') sectionsAdded++;
    else if (s.pending_state === 'removed') sectionsRemoved++;
    else if (s.changed_fields.length) sectionsEdited++;
    for (const l of s.lessons) {
      // Lessons of a removed section are counted by the section chip.
      if (s.pending_state === 'removed') continue;
      if (l.pending_state === 'added' || s.pending_state === 'added') {
        lessonsAdded++;
        if (l.has_video) videos++;
      } else if (l.pending_state === 'removed') {
        lessonsRemoved++;
      } else {
        if (l.video_pending) videos++;
        if (l.changed_fields.some((f) => f !== 'video_s3_key')) lessonsEdited++;
      }
    }
  }
  const chips: string[] = [];
  if (course.pending_fields.length) chips.push(`${course.pending_fields.map(fieldLabel).join(', ')} edited`);
  if (sectionsAdded) chips.push(`+${plural(sectionsAdded, 'section')}`);
  if (sectionsRemoved) chips.push(`−${plural(sectionsRemoved, 'section')}`);
  if (sectionsEdited) chips.push(`${plural(sectionsEdited, 'section')} edited`);
  if (lessonsAdded) chips.push(`+${plural(lessonsAdded, 'lesson')}`);
  if (lessonsRemoved) chips.push(`−${plural(lessonsRemoved, 'lesson')}`);
  if (lessonsEdited) chips.push(`${plural(lessonsEdited, 'lesson')} edited`);
  if (videos) chips.push(`${plural(videos, 'new video')}`);
  if (course.pending_knowledge_count) chips.push(`${plural(course.pending_knowledge_count, 'tutor note')}`);
  if (course.pending_assessments_count) chips.push(`${plural(course.pending_assessments_count, 'new assessment')}`);
  return chips;
}

export type BadgeTone = 'new' | 'removing' | 'edited' | 'video';
export interface RowBadge {
  label: string;
  tone: BadgeTone;
}

export const BADGE_CLASS: Record<BadgeTone, string> = {
  new: 'badge-success',
  removing: 'badge-danger',
  edited: 'badge-warn',
  video: 'badge-info',
};

export function sectionBadges(section: Pick<WorkingSection, 'pending_state' | 'changed_fields'>): RowBadge[] {
  if (section.pending_state === 'added') return [{ label: 'New', tone: 'new' }];
  if (section.pending_state === 'removed') return [{ label: 'Removing', tone: 'removing' }];
  return section.changed_fields.length ? [{ label: 'Edited', tone: 'edited' }] : [];
}

/** Badges for a lesson row; a lesson inside a new or removed section inherits that state. */
export function lessonBadges(lesson: Pick<WorkingLesson, 'pending_state' | 'changed_fields' | 'video_pending'>, sectionState: PendingState): RowBadge[] {
  if (sectionState === 'removed' || lesson.pending_state === 'removed') return [{ label: 'Removing', tone: 'removing' }];
  // Inside a new section every lesson is new; the section badge already says so.
  if (sectionState === 'added') return [];
  if (lesson.pending_state === 'added') return [{ label: 'New', tone: 'new' }];
  const badges: RowBadge[] = [];
  if (lesson.changed_fields.some((f) => f !== 'video_s3_key')) badges.push({ label: 'Edited', tone: 'edited' });
  if (lesson.video_pending) badges.push({ label: 'New video pending', tone: 'video' });
  return badges;
}

// ---------------------------------------------------------------------------
// AI outline
// ---------------------------------------------------------------------------

/** Limits of POST /courses/:id/apply-structure (ApplyStructureDto / SectionInputDto / LessonInputDto). */
export const OUTLINE_LIMITS = { sections: 12, lessons: 12, title: 160, summary: 500 };

export interface DraftLesson {
  title: string;
  summary?: string;
}

export interface DraftSection {
  title: string;
  is_free_preview: boolean;
  lessons: DraftLesson[];
}

export interface ApplyBody {
  sections: Array<{ title: string; is_free_preview: boolean; lessons: Array<{ title: string; summary?: string }> }>;
}

/**
 * The apply-structure body for an edited draft, or the first problem to fix.
 * Checked here so the educator gets a pointed message instead of a
 * validation error listing field paths.
 */
export function toApplyBody(draft: DraftSection[]): { ok: true; body: ApplyBody } | { ok: false; error: string } {
  if (!draft.length) return { ok: false, error: 'The outline has no sections — generate one or add a section first.' };
  if (draft.length > OUTLINE_LIMITS.sections) {
    return { ok: false, error: `An outline can have at most ${OUTLINE_LIMITS.sections} sections — remove or merge ${draft.length - OUTLINE_LIMITS.sections}.` };
  }
  const sections: ApplyBody['sections'] = [];
  for (let si = 0; si < draft.length; si++) {
    const s = draft[si];
    const title = s.title.trim().slice(0, OUTLINE_LIMITS.title);
    if (title.length < 2) return { ok: false, error: `Section ${si + 1} needs a title of at least 2 characters.` };
    const lessonsIn = s.lessons ?? [];
    if (lessonsIn.length > OUTLINE_LIMITS.lessons) {
      return { ok: false, error: `"${title}" has ${lessonsIn.length} lessons; the limit is ${OUTLINE_LIMITS.lessons} — split it into two sections.` };
    }
    const lessons: ApplyBody['sections'][number]['lessons'] = [];
    for (let li = 0; li < lessonsIn.length; li++) {
      const l = lessonsIn[li];
      const lessonTitle = l.title.trim().slice(0, OUTLINE_LIMITS.title);
      if (lessonTitle.length < 2) {
        return { ok: false, error: `Lesson ${li + 1} in "${title}" needs a title of at least 2 characters — fill it in or remove the lesson.` };
      }
      const summary = (l.summary ?? '').trim().slice(0, OUTLINE_LIMITS.summary);
      lessons.push(summary ? { title: lessonTitle, summary } : { title: lessonTitle });
    }
    sections.push({ title, is_free_preview: !!s.is_free_preview, lessons });
  }
  return { ok: true, body: { sections } };
}

/** Normalise the generator's reply (lessons may lack summaries) into an editable draft. */
export function toDraft(sections: Array<{ title?: string; is_free_preview?: boolean; lessons?: Array<{ title?: string; summary?: string }> }>): DraftSection[] {
  return sections.map((s) => ({
    title: s.title ?? '',
    is_free_preview: !!s.is_free_preview,
    lessons: (s.lessons ?? []).map((l) => ({ title: l.title ?? '', summary: l.summary ?? '' })),
  }));
}

export function appliedMessage(res: { sections_added: number; lessons_added: number }, live: boolean): string {
  const added = `Added ${plural(res.sections_added, 'section')} / ${plural(res.lessons_added, 'lesson')}`;
  return live ? `${added} — staged: submit your changes for review to publish them.` : `${added}.`;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** "full document: 613 pages / 1,413,347 chars → sending a 20,753-char digest" (no pages part for DOCX / text). */
export function digestNote(result: Pick<ExtractResult, 'pages' | 'chars'>, digest: Pick<Digest, 'digest'>): string {
  const pages = result.pages > 0 ? `${fmt(result.pages)} page${result.pages === 1 ? '' : 's'} / ` : '';
  return `full document: ${pages}${fmt(result.chars)} chars → sending a ${fmt(digest.digest.length)}-char digest`;
}

/** Where the outline source box's text came from, while the box holds a digest. */
export interface SourceDoc {
  /** File name, or 'Pasted notes'. */
  name: string;
  kind: 'file' | 'pasted';
  /**
   * The whole original, which "Also add the full text to the course tutor"
   * sends. null once the box mixes the digest with other text: the box then
   * matches neither the document nor any whole text.
   */
  fullText: string | null;
}

/**
 * Condense pasted or typed text exactly like an uploaded file (markdown
 * headings count as headings). The result fits the model's budget.
 */
export function condenseSourceText(text: string): Digest {
  return buildDigest({ blocks: textToBlocks(text, true), outline: [], pages: 0, chars: text.length, fullText: text });
}

export interface PastePlan {
  /** The box text once the paste is in. */
  full: string;
  /** Over the model's budget: cancel the native paste and put condenseSourceText(full) in the box instead. */
  condense: boolean;
  /** What the box stands for afterwards. */
  doc: SourceDoc | null;
  /** A document whose full text is no longer offered to the tutor, to say so. */
  dropped: SourceDoc | null;
}

/**
 * What pasting `pasted` over box[start, end) does. A paste that changes a box
 * holding a digest (short of replacing all of it) mixes the digest with new
 * text: the stored full document no longer matches the box, so it is dropped
 * instead of reaching the tutor under the file's name, and the mix is not a
 * full text either.
 */
export function planPaste(box: string, pasted: string, start: number, end: number, doc: SourceDoc | null): PastePlan {
  const full = box.slice(0, start) + pasted + box.slice(end);
  if (full === box) return { full, condense: false, doc, dropped: null };
  const condense = !fitsDigestBudget(full);
  const dropped = doc?.fullText != null ? doc : null;
  // No digest in the box, or all of it replaced: the text is wholly the educator's own.
  if (!doc || (start === 0 && end === box.length)) {
    return { full, condense, doc: condense ? { name: 'Pasted notes', kind: 'pasted', fullText: full } : null, dropped };
  }
  return { full, condense, doc: { ...doc, fullText: null }, dropped };
}

/** Why the tutor button went away after a paste. */
export function droppedDocNote(doc: SourceDoc): string {
  const again = doc.kind === 'file' ? 'upload the file again' : 'paste the full text again over the whole box';
  return `The box no longer matches “${doc.name}”, so its full text is not offered to the course tutor — ${again} to add it.`;
}

/** Says why the box does not hold the text as typed: over the budget the AI reads at once. */
export const OVER_BUDGET_REASON = `the AI reads at most ${fmt(DIGEST_BUDGET_CHARS)} characters at once (fewer for Amharic text)`;

/** Text over the model's budget was condensed on paste or before sending. */
export function condensedNote(chars: number, digest: Pick<Digest, 'digest'>): string {
  return `Condensed because ${OVER_BUDGET_REASON}: ${fmt(chars)} chars → sending a ${fmt(digest.digest.length)}-char digest.`;
}

/** How POST /courses/generate-structure built the draft (see its `origin`). */
export type OutlineOrigin = 'model' | 'headings' | 'placeholder';

/** POST /courses/generate-structure reply, as far as the banner needs it. */
export interface OutlineReply {
  ai_live: boolean;
  origin?: OutlineOrigin;
  /** The API's own account: how the draft was built, or why the AI call failed (bad key, rate limit…). */
  note?: string;
}

/**
 * Banner over a draft the model did not write, or null when it did. The text
 * is the API's note; it follows the API's `origin`, not the box, so only a
 * 'headings' draft claims to come from the educator's document. When the note
 * is a failure reason that does not say how the draft was built, that is added.
 * A reply without `origin` never claims the document was read.
 */
export function offlineOutlineBanner(res: OutlineReply, sentSource: boolean): string | null {
  const origin = res.origin ?? (res.ai_live ? 'model' : 'placeholder');
  if (origin === 'model') return null;
  const note = res.note?.trim();
  if (origin === 'headings') {
    if (!note) return "AI is offline — this is a starter outline built from your document's headings; edit it.";
    return /heading/i.test(note) ? note : `${note} It is built from your document's headings.`;
  }
  if (!note) {
    return sentSource
      ? 'AI is offline and no headings were found in your text, so this is a generic starter outline (not built from your document) — edit it before adding it to your course.'
      : 'AI is offline — this is a generic starter outline; edit it before adding it to your course.';
  }
  if (/generic/i.test(note) || !sentSource) return note;
  return `${note} No headings were found in your text, so it is generic — not built from your document.`;
}

// ---------------------------------------------------------------------------
// Tutor notes
// ---------------------------------------------------------------------------

/** GET /courses/:id/knowledge row (grouped by source, title and state). */
export interface KnowledgeDoc {
  source: string;
  title: string;
  state?: 'live' | 'pending' | null;
  chunks: number;
}

export interface NoteRemoval {
  /** Ask this first, or null to remove without asking (draft course). */
  confirm: string | null;
  /** DELETE path, relative to /courses/:id. */
  path: string;
}

/**
 * The "remove" action of a tutor-notes row, or null when it has none.
 * DELETE /courses/:id/knowledge/:title removes the pending note of that title
 * when there is one, else the live note, so of a live + pending pair only the
 * pending row offers remove (the live row gets it back once that is gone). On
 * a live course the confirmation names the version that goes and whether
 * learners notice, and the request names that version (`?state=`), so a list
 * that is out of date cannot make the server remove the other one.
 */
export function noteRemoval(doc: KnowledgeDoc, docs: KnowledgeDoc[], live: boolean): NoteRemoval | null {
  if (doc.source !== 'notes') return null;
  const hasTwin = (state: 'live' | 'pending') =>
    docs.some((d) => d !== doc && d.source === 'notes' && d.title === doc.title && (d.state ?? 'live') === state);
  const pending = doc.state === 'pending';
  if (!pending && hasTwin('pending')) return null;
  const base = `knowledge/${encodeURIComponent(doc.title)}`;
  if (!live) return { confirm: null, path: base };
  if (pending) {
    const keep = hasTwin('live') ? `; the live “${doc.title}” note they use stays as it is` : '';
    return { confirm: `Remove your pending note “${doc.title}”? Learners never saw it${keep}.`, path: `${base}?state=pending` };
  }
  return {
    confirm: `Remove “${doc.title}” from the course tutor? Learners lose it right away — removing a live note is not part of your reviewed update and cannot be undone.`,
    path: `${base}?state=live`,
  };
}

/** POST /courses/:id/knowledge limits: KnowledgeDto text ≤ 200,000 chars, and the course service's 512 KB JSON body. */
export const KNOWLEDGE_MAX_CHARS = 200_000;
/** UTF-8 bytes, leaving room for JSON escaping (newlines, quotes) under the 512 KB body limit. */
export const KNOWLEDGE_MAX_BYTES = 400_000;

/**
 * The longest prefix of `text` within both knowledge limits. Amharic costs
 * 3 bytes per character, so the byte cap binds first for Ge'ez text.
 */
export function clampKnowledgeText(text: string, maxChars = KNOWLEDGE_MAX_CHARS, maxBytes = KNOWLEDGE_MAX_BYTES): { text: string; truncated: boolean } {
  let bytes = 0;
  let i = 0;
  const limit = Math.min(text.length, maxChars);
  while (i < limit) {
    const code = text.charCodeAt(i);
    const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length;
    const size = pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    const width = pair ? 2 : 1;
    if (bytes + size > maxBytes || i + width > maxChars) break;
    bytes += size;
    i += width;
  }
  return i >= text.length ? { text, truncated: false } : { text: text.slice(0, i), truncated: true };
}

/** Knowledge title from an uploaded file name: no extension, within the 200-char DTO limit. */
export function knowledgeTitle(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').trim();
  return (base || fileName || 'Course document').slice(0, 200);
}

// ---------------------------------------------------------------------------
// Unfinished uploads
// ---------------------------------------------------------------------------

/** Resume hints per lesson; records for lessons that no longer exist (or none) are orphans. */
export function groupUploadHints(
  hints: ResumableUploadInfo[],
  lessonIds: ReadonlySet<string>,
): { byLesson: Record<string, ResumableUploadInfo[]>; orphans: ResumableUploadInfo[] } {
  const byLesson: Record<string, ResumableUploadInfo[]> = {};
  const orphans: ResumableUploadInfo[] = [];
  for (const h of hints) {
    if (h.lessonId && lessonIds.has(h.lessonId)) (byLesson[h.lessonId] ??= []).push(h);
    else orphans.push(h);
  }
  return { byLesson, orphans };
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
