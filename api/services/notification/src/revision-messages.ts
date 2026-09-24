import { RevisionDiffSummary } from '@ethiopialearn/contracts';

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  description: 'description',
  category: 'category',
  thumbnail_url: 'thumbnail',
};

function count(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

/**
 * Total staged changes in a revision. Replaced videos and new free-preview
 * sections are not added: they are already counted as changed lessons or
 * sections.
 */
export function revisionChangeCount(s: RevisionDiffSummary): number {
  return (
    s.fields_changed.length +
    s.sections_added +
    s.sections_removed +
    s.sections_changed +
    s.lessons_added +
    s.lessons_removed +
    s.lessons_changed +
    s.knowledge_added +
    s.assessments_added
  );
}

/** Short labels a quality officer can triage from, e.g. "+2 lessons", "1 video replaced", "price 400→500". */
export function revisionChips(s: RevisionDiffSummary): string[] {
  const chips: string[] = [];
  if (s.sections_added) chips.push(`+${count(s.sections_added, 'section')}`);
  if (s.lessons_added) chips.push(`+${count(s.lessons_added, 'lesson')}`);
  if (s.sections_removed) chips.push(`−${count(s.sections_removed, 'section')}`);
  if (s.lessons_removed) chips.push(`−${count(s.lessons_removed, 'lesson')}`);
  if (s.sections_changed) chips.push(`${count(s.sections_changed, 'section')} edited`);
  if (s.lessons_changed) chips.push(`${count(s.lessons_changed, 'lesson')} edited`);
  if (s.videos_replaced) chips.push(`${count(s.videos_replaced, 'video')} replaced`);
  if (s.fields_changed.includes('pricing_type')) chips.push(`pricing ${s.pricing_type_from ?? '—'}→${s.pricing_type_to ?? '—'}`);
  if (s.fields_changed.includes('price_etb')) chips.push(`price ${s.price_from ?? '—'}→${s.price_to ?? '—'}`);
  if (s.new_free_preview_section) chips.push('free preview added');
  if (s.assessments_added) chips.push(`+${count(s.assessments_added, 'assessment')}`);
  if (s.knowledge_added) chips.push(`+${count(s.knowledge_added, 'tutor note')}`);
  const edited = s.fields_changed.filter((f) => f in FIELD_LABELS).map((f) => FIELD_LABELS[f]);
  if (edited.length) chips.push(`${edited.join(', ')} edited`);
  return chips;
}

const NO_CHANGES: RevisionDiffSummary = {
  fields_changed: [],
  sections_added: 0,
  sections_removed: 0,
  sections_changed: 0,
  lessons_added: 0,
  lessons_removed: 0,
  lessons_changed: 0,
  videos_replaced: 0,
  price_from: null,
  price_to: null,
  pricing_type_from: null,
  pricing_type_to: null,
  new_free_preview_section: false,
  knowledge_added: 0,
  assessments_added: 0,
};

/** Inbox body for the QA queue: "<title>: <n> change(s) — <chips>". */
export function revisionSubmittedBody(courseTitle: string, summary: Partial<RevisionDiffSummary> | null | undefined): string {
  // Event payloads cross a process boundary; a missing count must not drop the QO's notification.
  const s = { ...NO_CHANGES, ...summary };
  const n = revisionChangeCount(s);
  const chips = revisionChips(s);
  return `${courseTitle}: ${count(n, 'change')}${chips.length ? ` — ${chips.join(' · ')}` : ''}`;
}
