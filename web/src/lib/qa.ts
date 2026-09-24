/**
 * Pure helpers for the quality-review screens (QA queue, revision diff preview,
 * institution review). Kept free of React so the rules are unit-tested.
 */

export type QaItemKind = 'new_course' | 'revision' | 'appeal' | 'post_publish';
export type QaAction = 'approve' | 'coach' | 'flag' | 'reject';

/** Mirror of the contracts RevisionDiffSummary (the web app does not import the api packages). */
export interface RevisionDiffSummary {
  fields_changed: string[];
  sections_added: number;
  sections_removed: number;
  sections_changed: number;
  lessons_added: number;
  lessons_removed: number;
  lessons_changed: number;
  videos_replaced: number;
  price_from: number | null;
  price_to: number | null;
  pricing_type_from: string | null;
  pricing_type_to: string | null;
  new_free_preview_section: boolean;
  knowledge_added: number;
  assessments_added: number;
}

/** GET /qa/queue row. Older rows may predate kind/claim/diff fields, so those are optional. */
export interface QaQueueItem {
  id: string;
  course_id: string;
  course_title: string;
  owner_id: string;
  owner_type: string;
  owner_name?: string;
  owner_email?: string;
  status: string;
  trigger: string;
  plagiarism?: Record<string, unknown>;
  kind?: QaItemKind;
  revision_id?: string | null;
  diff_summary?: Partial<RevisionDiffSummary> | null;
  changelog_summary?: string | null;
  priority?: number;
  claimed_by?: string | null;
  claimed_at?: string | null;
  claim_active?: boolean;
  sla_deadline: string;
  created_at?: string;
}

export interface RevisionView {
  id: string;
  status: string;
  changelog_summary: string | null;
  major: boolean;
  submitted_at: string | null;
  decision_notes: string | null;
}

export interface PendingAssessmentQuestion {
  prompt: string;
  kind: 'mcq' | 'written';
  options?: string[];
  correct_index?: number;
  guidance?: string;
}

export interface PendingAssessment {
  id: string;
  type: string;
  is_required: boolean;
  pass_score: number;
  question_count: number;
  created_at: string;
  questions: PendingAssessmentQuestion[];
  instructions?: string;
  topic_context?: string | null;
}

/** GET /courses/:id/revisions/current/diff */
export interface RevisionDiff {
  revision: RevisionView | null;
  course: { id: string; title: string; status: string; thumbnail_url: string | null };
  metadata: { field: string; before: unknown; after: unknown }[];
  sections: {
    added: {
      id: string;
      title: string;
      is_free_preview: boolean;
      lessons: { id: string; title: string; summary: string | null; has_video: boolean }[];
    }[];
    removed: { id: string; title: string }[];
    changed: {
      id: string;
      before: { title: string; is_free_preview: boolean };
      after: { title: string; is_free_preview: boolean };
    }[];
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
  pending_assessments: PendingAssessment[];
  diff_summary: RevisionDiffSummary;
  empty: boolean;
}

export const KIND_LABEL: Record<QaItemKind, string> = {
  new_course: 'New course',
  revision: 'Update',
  appeal: 'Appeal',
  post_publish: 'Post-publish',
};

export function itemKind(item: { kind?: string | null }): QaItemKind {
  return item.kind && item.kind in KIND_LABEL ? (item.kind as QaItemKind) : 'new_course';
}

// ---- decisions ---------------------------------------------------------------

export interface QaActionOption {
  action: QaAction;
  label: string;
  /** What happens to the course — shown under the buttons so the effect is never a surprise. */
  hint: string;
  tone: 'primary' | 'secondary' | 'danger';
  notesRequired: boolean;
  /** Confirmation shown once the decision is recorded. */
  done: string;
  /** Irreversible for the educator or the learners → ask before sending. */
  confirm?: string;
}

const COACH_HINT_DRAFT = 'Sends the course back to the educator as a draft with your notes.';
const FLAG_CONFIRM = 'Flag this course? It is taken out of the catalog until an appeal succeeds.';

/**
 * The server accepts approve | coach | reject for revisions and approve | coach | flag for
 * everything else (a revision never changes the live course, so there is nothing to flag;
 * the other kinds review the course itself, so there are no staged changes to reject).
 */
export function actionsForKind(kind: QaItemKind): QaActionOption[] {
  switch (kind) {
    case 'revision':
      return [
        { action: 'approve', label: 'Approve → changes go live', hint: 'The staged changes replace the live course at once.', tone: 'primary', notesRequired: false, done: 'Approved — the changes go live in a moment.' },
        { action: 'coach', label: 'Request changes', hint: 'Back to the educator with your notes; their edits are kept.', tone: 'secondary', notesRequired: true, done: 'Sent back to the educator with your notes.' },
        {
          action: 'reject',
          label: 'Reject changes',
          hint: 'The staged changes are discarded; the live course stays as it is.',
          tone: 'danger',
          notesRequired: true,
          done: 'Changes rejected — the live course is unchanged.',
          confirm: "Reject these changes? The educator's staged edits are discarded and the live course stays as it is.",
        },
      ];
    case 'appeal':
      return [
        { action: 'approve', label: 'Approve → reinstate', hint: 'The course goes back into the catalog.', tone: 'primary', notesRequired: false, done: 'Appeal approved — the course is back in the catalog.' },
        { action: 'coach', label: 'Coach → back to draft', hint: COACH_HINT_DRAFT, tone: 'secondary', notesRequired: true, done: 'Sent back to the educator as a draft.' },
        { action: 'flag', label: 'Flag → keep taken down', hint: 'The course stays out of the catalog.', tone: 'danger', notesRequired: false, done: 'Flag upheld.', confirm: FLAG_CONFIRM },
      ];
    case 'post_publish':
      return [
        { action: 'approve', label: 'Approve → keep live', hint: 'Closes the check; the course is unchanged.', tone: 'primary', notesRequired: false, done: 'Check closed — the course stays live.' },
        { action: 'coach', label: 'Coach (stays live)', hint: 'The educator gets your notes; the course stays in the catalog.', tone: 'secondary', notesRequired: true, done: 'Notes sent — the course stays live.' },
        { action: 'flag', label: 'Flag → take down', hint: 'Removes the course from the catalog until an appeal succeeds.', tone: 'danger', notesRequired: false, done: 'Flagged — the course is out of the catalog.', confirm: FLAG_CONFIRM },
      ];
    default:
      return [
        { action: 'approve', label: 'Approve → publish', hint: 'The course goes live in the catalog.', tone: 'primary', notesRequired: false, done: 'Approved — the course is being published.' },
        { action: 'coach', label: 'Coach → back to draft', hint: COACH_HINT_DRAFT, tone: 'secondary', notesRequired: true, done: 'Sent back to the educator as a draft.' },
        { action: 'flag', label: 'Flag (policy violation)', hint: 'Blocks the course until an appeal succeeds.', tone: 'danger', notesRequired: false, done: 'Flagged.', confirm: 'Flag this course for a policy violation? It cannot be published unless an appeal succeeds.' },
      ];
  }
}

/** Client-side copy of the server's notes rule, so the officer is told before a round trip. */
export function decisionNotesError(action: QaAction, notes: string): string | null {
  if (notes.trim()) return null;
  if (action === 'coach') return 'Add notes for the educator first — say what needs to change.';
  if (action === 'reject') return "Add notes for the educator first — say why these changes can't go live.";
  return null;
}

// ---- diff chips ----------------------------------------------------------------

export type ChipTone = 'neutral' | 'info' | 'warn' | 'success';
export interface DiffChip {
  text: string;
  tone: ChipTone;
}

/** Badge class per chip tone (globals.css). */
export const CHIP_CLASS: Record<ChipTone, string> = {
  neutral: 'badge-neutral',
  info: 'badge-info',
  warn: 'badge-warn',
  success: 'badge-success',
};

const FIELD_LABEL: Record<string, string> = {
  title: 'title',
  description: 'description',
  category: 'category',
  thumbnail_url: 'thumbnail',
  pricing_type: 'pricing',
  price_etb: 'price',
};

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field.replace(/_/g, ' ');
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function formatAmount(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v);
}

export function formatPrice(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'none';
  return `${formatAmount(v)} ETB`;
}

/**
 * Short, scannable labels for the queue card, e.g. "+2 lessons", "1 video replaced",
 * "price 400→500 ETB". Anything a learner pays for or gets for free is 'warn' so it
 * stands out; "low risk" (priority 1) only ever reorders the queue, it never approves.
 */
export function diffChips(summary: Partial<RevisionDiffSummary> | null | undefined, priority = 0): DiffChip[] {
  const s = summary ?? {};
  const chips: DiffChip[] = [];
  const add = (n: number | undefined, text: (n: number) => string, tone: ChipTone = 'neutral') => {
    if (n && n > 0) chips.push({ text: text(n), tone });
  };
  add(s.sections_added, (n) => `+${count(n, 'section')}`, 'info');
  add(s.lessons_added, (n) => `+${count(n, 'lesson')}`, 'info');
  add(s.sections_changed, (n) => `${count(n, 'section')} edited`);
  add(s.lessons_changed, (n) => `${count(n, 'lesson')} edited`);
  add(s.videos_replaced, (n) => `${count(n, 'video')} replaced`, 'warn');
  add(s.sections_removed, (n) => `−${count(n, 'section')}`);
  add(s.lessons_removed, (n) => `−${count(n, 'lesson')}`);

  const priceFrom = s.price_from ?? null;
  const priceTo = s.price_to ?? null;
  if (priceFrom !== priceTo) {
    const text =
      priceFrom === null
        ? `price set: ${formatPrice(priceTo)}`
        : priceTo === null
          ? `price removed (was ${formatPrice(priceFrom)})`
          : `price ${formatAmount(priceFrom)}→${formatPrice(priceTo)}`;
    chips.push({ text, tone: 'warn' });
  }
  const typeFrom = s.pricing_type_from ?? null;
  const typeTo = s.pricing_type_to ?? null;
  if (typeFrom !== typeTo) chips.push({ text: `pricing ${typeFrom ?? '?'}→${typeTo ?? '?'}`, tone: 'warn' });
  if (s.new_free_preview_section) chips.push({ text: 'free preview added', tone: 'warn' });

  for (const field of s.fields_changed ?? []) {
    // Price and pricing already have their own before→after chip.
    if (field === 'price_etb' || field === 'pricing_type') continue;
    chips.push({ text: `${fieldLabel(field)} changed`, tone: 'neutral' });
  }
  add(s.assessments_added, (n) => `+${count(n, 'assessment')}`, 'info');
  add(s.knowledge_added, (n) => `+${count(n, 'tutor note')}`, 'info');
  if (priority === 1) chips.push({ text: 'low risk', tone: 'success' });
  return chips;
}

// ---- SLA & claim ---------------------------------------------------------------

function formatSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Countdown to the review deadline; under 8 hours (or overdue) is urgent. */
export function slaCountdown(
  deadline: string | Date | null | undefined,
  now: number = Date.now(),
): { text: string; tone: 'danger' | 'warn' | 'neutral'; overdue: boolean } {
  const at = deadline ? new Date(deadline).getTime() : NaN;
  if (!Number.isFinite(at)) return { text: 'No deadline', tone: 'neutral', overdue: false };
  const left = at - now;
  if (left <= 0) return { text: `Overdue by ${formatSpan(-left)}`, tone: 'danger', overdue: true };
  return { text: `${formatSpan(left)} left`, tone: left < 8 * 3_600_000 ? 'danger' : 'warn', overdue: false };
}

/** Must match the quality service: a claim lapses on its own after 30 minutes. */
export const CLAIM_TTL_MS = 30 * 60 * 1000;

export type ClaimState = { state: 'unclaimed' } | { state: 'mine'; expiresIn: string } | { state: 'other' };

export function claimState(
  item: Pick<QaQueueItem, 'claimed_by' | 'claimed_at' | 'claim_active'>,
  userId: string | null | undefined,
  now: number = Date.now(),
): ClaimState {
  if (!item.claimed_by) return { state: 'unclaimed' };
  const at = item.claimed_at ? new Date(item.claimed_at).getTime() : NaN;
  // Re-check the lapse locally: the queue is polled, so the server's flag can be minutes old.
  const left = Number.isFinite(at) ? at + CLAIM_TTL_MS - now : item.claim_active ? CLAIM_TTL_MS : 0;
  if (left <= 0) return { state: 'unclaimed' };
  return item.claimed_by === userId ? { state: 'mine', expiresIn: formatSpan(left) } : { state: 'other' };
}

// ---- videos-reviewed checklist -------------------------------------------------

export interface ReviewVideo {
  lesson_id: string;
  title: string;
  section_title: string;
  /** new = lesson added with a video; replaced = a live lesson gets a different video */
  change: 'new' | 'replaced';
}

/** Every video the reviewer has to watch before approving: new lessons with video + replaced videos. */
export function videosToReview(diff: Pick<RevisionDiff, 'sections' | 'lessons'>): ReviewVideo[] {
  const videos: ReviewVideo[] = [];
  for (const s of diff.sections.added) {
    for (const l of s.lessons) {
      if (l.has_video) videos.push({ lesson_id: l.id, title: l.title, section_title: s.title, change: 'new' });
    }
  }
  for (const l of diff.lessons.added) {
    if (l.has_video) videos.push({ lesson_id: l.id, title: l.title, section_title: l.section_title, change: 'new' });
  }
  for (const l of diff.lessons.changed) {
    if (l.video_replaced) videos.push({ lesson_id: l.id, title: l.title_after, section_title: l.section_title, change: 'replaced' });
  }
  return videos;
}

/**
 * Per-browser record of what the officer has seen of one revision's diff: which new/replaced
 * videos were opened, and whether the diff failed to load its new assessments. Keyed by
 * revision; `item_id` ties it to one QA item: a withdrawn-and-resubmitted revision keeps its
 * id but gets a new item, and videos opened for the earlier submission must not count again.
 */
export interface VideosReviewedRecord {
  item_id: string | null;
  required: string[];
  opened: string[];
  /**
   * The diff answered 503: the new assessments could not be loaded, so the officer has not
   * seen them. Approve stays locked until "Review changes" loads completely (which clears it).
   */
  assessments_unavailable?: boolean;
  /** When it was last written (ms since epoch); old records are pruned from localStorage. */
  saved_at?: number;
}

export function videosReviewedKey(revisionId: string): string {
  return `el_qa_videos:v1:${revisionId}`;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function parseVideosRecord(raw: string | null | undefined): VideosReviewedRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<VideosReviewedRecord>;
    if (!v || !isStringArray(v.required) || !isStringArray(v.opened)) return null;
    return {
      item_id: typeof v.item_id === 'string' ? v.item_id : null,
      required: v.required,
      opened: v.opened,
      ...(v.assessments_unavailable === true ? { assessments_unavailable: true } : {}),
      ...(typeof v.saved_at === 'number' ? { saved_at: v.saved_at } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The loaded diff is the truth for what must be watched; progress survives only for the same
 * QA item. A loaded diff includes the new assessments, so an earlier load failure is cleared.
 */
export function syncVideosRecord(
  prev: VideosReviewedRecord | null,
  itemId: string | null,
  required: string[],
): VideosReviewedRecord {
  const sameItem = !!prev && (itemId === null || prev.item_id === itemId);
  return { item_id: itemId ?? prev?.item_id ?? null, required, opened: sameItem ? prev.opened : [] };
}

/** The diff could not load the new assessments (503): lock Approve for this item until it does. */
export function markAssessmentsUnavailable(prev: VideosReviewedRecord | null, itemId: string | null): VideosReviewedRecord {
  return { ...syncVideosRecord(prev, itemId, prev?.required ?? []), assessments_unavailable: true };
}

export function markVideoOpened(record: VideosReviewedRecord, lessonId: string): VideosReviewedRecord {
  return record.opened.includes(lessonId) ? record : { ...record, opened: [...record.opened, lessonId] };
}

export function videosReviewedProgress(record: VideosReviewedRecord | null): { opened: number; total: number; complete: boolean } {
  if (!record) return { opened: 0, total: 0, complete: true };
  const opened = record.required.filter((id) => record.opened.includes(id)).length;
  return { opened, total: record.required.length, complete: opened === record.required.length };
}

/** A decided item's record is useless; the SLA is 24 hours, so a week leaves plenty of room. */
export const VIDEOS_RECORD_TTL_MS = 7 * 24 * 3_600_000;
const VIDEOS_RECORD_PREFIX = videosReviewedKey('');

// localStorage, not sessionStorage: "Review changes" is often opened in a new tab, and a
// per-tab record never reached the queue tab, so Approve stayed locked. It can throw
// (private mode, blocked storage); the checklist is a convenience, so fail soft.
export function readVideosRecord(revisionId: string): VideosReviewedRecord | null {
  try {
    return parseVideosRecord(localStorage.getItem(videosReviewedKey(revisionId)));
  } catch {
    return null;
  }
}

export function writeVideosRecord(revisionId: string, record: VideosReviewedRecord, now: number = Date.now()): void {
  try {
    pruneVideosRecords(now);
    localStorage.setItem(videosReviewedKey(revisionId), JSON.stringify({ ...record, saved_at: now }));
  } catch {
    /* storage unavailable — the preview still shows k/n for this page view */
  }
}

/** localStorage outlives the review, so drop records not written for VIDEOS_RECORD_TTL_MS. */
function pruneVideosRecords(now: number): void {
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(VIDEOS_RECORD_PREFIX)) continue;
    const saved = parseVideosRecord(localStorage.getItem(key))?.saved_at;
    if (saved === undefined || now - saved > VIDEOS_RECORD_TTL_MS) stale.push(key);
  }
  for (const key of stale) localStorage.removeItem(key);
}

/**
 * Approving a revision is only meaningful once the officer has seen all of it: every new or
 * replaced video watched, and the new assessments (with answer keys) loaded. Without a record
 * for this item we cannot know the video count, so a revision that adds lessons, replaces
 * videos or adds assessments stays locked until "Review changes" has been opened.
 */
export function approveGate(
  item: Pick<QaQueueItem, 'id' | 'kind' | 'diff_summary'>,
  record: VideosReviewedRecord | null,
): { allowed: true } | { allowed: false; reason: string } {
  if (itemKind(item) !== 'revision') return { allowed: true };
  if (record && record.item_id === item.id) {
    if (record.assessments_unavailable) {
      return {
        allowed: false,
        reason: 'The new assessments in this update could not be loaded, so nobody has checked them. Open “Review changes” again and approve once they load.',
      };
    }
    const p = videosReviewedProgress(record);
    if (p.complete) return { allowed: true };
    return { allowed: false, reason: `Watch every new or replaced video first — ${p.opened}/${p.total} opened in “Review changes”.` };
  }
  const s = item.diff_summary ?? {};
  if ((s.videos_replaced ?? 0) > 0 || (s.lessons_added ?? 0) > 0) {
    return { allowed: false, reason: 'Open “Review changes” and watch the new or replaced videos before approving.' };
  }
  if ((s.assessments_added ?? 0) > 0) {
    return { allowed: false, reason: 'Open “Review changes” and check the new assessments and their answer keys before approving.' };
  }
  return { allowed: true };
}

// ---- structure tree ------------------------------------------------------------

export type TreeMarker = '+' | '−' | '~' | '';

export interface TreeLesson {
  id: string;
  marker: TreeMarker;
  title: string;
  titleBefore?: string;
  /** e.g. "summary, duration, new video" or "video" */
  note?: string;
  /** Added lessons only: the summary learners will read. */
  summary?: string;
}

export interface TreeSection {
  key: string;
  /** '' = an unchanged section shown only as context for the lesson changes inside it */
  marker: TreeMarker;
  title: string;
  titleBefore?: string;
  note?: string;
  lessons: TreeLesson[];
}

/**
 * The changed part of the course outline: added (+), removed (−) and edited (~) sections
 * and lessons, with lesson changes grouped under their section. Unchanged sections appear
 * only when a lesson inside them changed. The diff names a lesson's section by title for
 * removed/changed lessons, so those are grouped by title (display only).
 */
export function structureTree(diff: Pick<RevisionDiff, 'sections' | 'lessons'>): TreeSection[] {
  const existing: TreeSection[] = [];
  const byId = new Map<string, TreeSection>();
  const byTitle = new Map<string, TreeSection>();

  for (const s of diff.sections.changed) {
    const notes: string[] = [];
    if (s.before.is_free_preview !== s.after.is_free_preview) notes.push(s.after.is_free_preview ? 'now free preview' : 'no longer free preview');
    const node: TreeSection = {
      key: s.id,
      marker: '~',
      title: s.after.title,
      titleBefore: s.before.title !== s.after.title ? s.before.title : undefined,
      note: notes.join(', ') || undefined,
      lessons: [],
    };
    existing.push(node);
    byId.set(s.id, node);
    byTitle.set(s.after.title, node);
    byTitle.set(s.before.title, node);
  }

  const removed: TreeSection[] = diff.sections.removed.map((s) => ({ key: s.id, marker: '−', title: s.title, lessons: [] }));
  // Lessons of a removed section are listed as removed lessons with that section's title.
  const removedByTitle = new Map(removed.map((n) => [n.title, n]));

  const context = (key: string, title: string): TreeSection => {
    const found = byTitle.get(title);
    if (found) return found;
    const node: TreeSection = { key, marker: '', title, lessons: [] };
    existing.push(node);
    byTitle.set(title, node);
    return node;
  };

  for (const l of diff.lessons.added) {
    const node = byId.get(l.section_id) ?? context(`ctx:${l.section_id}`, l.section_title);
    node.lessons.push({ id: l.id, marker: '+', title: l.title, note: l.has_video ? 'video' : 'no video', ...(l.summary ? { summary: l.summary } : {}) });
  }
  for (const l of diff.lessons.removed) {
    const node = removedByTitle.get(l.section_title) ?? context(`ctx-title:${l.section_title}`, l.section_title);
    node.lessons.push({ id: l.id, marker: '−', title: l.title });
  }
  for (const l of diff.lessons.changed) {
    const what: string[] = [];
    if (l.title_before !== l.title_after) what.push('title');
    if ((l.summary_before ?? '') !== (l.summary_after ?? '')) what.push('summary');
    if (l.duration_before !== l.duration_after) what.push('duration');
    if (l.video_replaced) what.push('new video');
    const node = context(`ctx-title:${l.section_title}`, l.section_title);
    node.lessons.push({
      id: l.id,
      marker: '~',
      title: l.title_after,
      titleBefore: l.title_before !== l.title_after ? l.title_before : undefined,
      note: what.join(', ') || undefined,
    });
  }

  const added: TreeSection[] = diff.sections.added.map((s) => ({
    key: s.id,
    marker: '+',
    title: s.title,
    note: s.is_free_preview ? 'free preview' : undefined,
    lessons: s.lessons.map((l) => ({
      id: l.id,
      marker: '+' as const,
      title: l.title,
      note: l.has_video ? 'video' : 'no video',
      ...(l.summary ? { summary: l.summary } : {}),
    })),
  }));

  return [...existing, ...added, ...removed];
}

// ---- word diff -----------------------------------------------------------------

export interface DiffSegment {
  text: string;
  op: 'same' | 'add' | 'del';
}

/**
 * Word-level diff: LCS over word and whitespace tokens (whitespace tokens all match each
 * other, so a changed line break never shows as a change). Returns null when the texts are
 * too long for the quadratic table; callers then show the plain before/after blocks.
 * The "before" text is same+del segments, the "after" text is same+add segments.
 */
export function wordDiff(before: string, after: string, maxCells = 2_000_000): DiffSegment[] | null {
  const a = before.match(/\s+|\S+/g) ?? [];
  const b = after.match(/\s+|\S+/g) ?? [];
  const n = a.length;
  const m = b.length;
  // Uint16 cells: the LCS length never exceeds the shorter token count.
  if ((n + 1) * (m + 1) > maxCells || Math.min(n, m) > 65_535) return null;
  const key = (t: string) => (/^\s/.test(t) ? ' ' : t);
  const w = m + 1;
  const lcs = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = key(a[i]) === key(b[j]) ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: DiffSegment[] = [];
  const push = (text: string, op: DiffSegment['op']) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ text, op });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) {
      push(b[j], 'same');
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      push(a[i++], 'del');
    } else {
      push(b[j++], 'add');
    }
  }
  while (i < n) push(a[i++], 'del');
  while (j < m) push(b[j++], 'add');
  return out;
}

/** Lesson length as m:ss (or h:mm:ss); 0 means "not set". */
export function formatClock(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (!s) return 'not set';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
