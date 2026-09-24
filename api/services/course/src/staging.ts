import { EntityManager, In } from 'typeorm';
import { Course, CourseKnowledge, Lesson, Section } from './entities';
import { closeLessonIds, computeDiff, mergedLesson, mergedSection, RevisionState } from './revision-diff';

/**
 * Row-level operations on the staged (pending) state of one course: load it,
 * make it live, or throw it away. They only touch the course's own rows — no
 * events, no revision rows and no course.status / published_at changes — so
 * both the revision decision paths and the course lifecycle paths can share
 * them. Callers run them inside a transaction and hold the course row lock,
 * so the state cannot change between load and write.
 */

/** Everything staged for one course, as the entity rows loaded from the database. */
export interface StagedState extends RevisionState {
  course: Course;
  sections: Section[];
  lessons: Lesson[];
  pendingKnowledge: CourseKnowledge[];
}

/** Lessons downstream services react to once the staged state went live. */
export interface AppliedLessonIds {
  addedLessonIds: string[];
  removedLessonIds: string[];
  replacedVideoLessonIds: string[];
}

export async function loadStagedState(m: EntityManager, course: Course): Promise<StagedState> {
  const sections = await m.getRepository(Section).find({ where: { course_id: course.id } });
  const lessons = sections.length ? await m.getRepository(Lesson).find({ where: { section_id: In(sections.map((s) => s.id)) } }) : [];
  const pendingKnowledge = await m.getRepository(CourseKnowledge).find({ where: { course_id: course.id, state: 'pending' } });
  return { course, sections, lessons, pendingKnowledge };
}

/**
 * Same rules as the teach page's has_pending_changes (CourseService.workingView,
 * minus assessments, which live in the outcomes service): if the page offers
 * Submit / Discard, this must say there is something to act on.
 */
export function hasStagedState(state: Pick<StagedState, 'course' | 'sections' | 'lessons' | 'pendingKnowledge'>): boolean {
  const staged = (row: { pending_state?: string | null; pending?: object | null }) => !!row.pending_state || !!row.pending;
  return (
    Object.keys(state.course.pending ?? {}).length > 0 ||
    state.sections.some(staged) ||
    state.lessons.some(staged) ||
    state.pendingKnowledge.length > 0
  );
}

/**
 * Copy the staged state onto the live columns: course/section/lesson pending
 * values become live, 'removed' lessons then sections are deleted, markers are
 * cleared, and pending tutor notes go live (replacing the live note of the
 * same title). Returns the lesson ids that changed for learners.
 */
export async function applyStagedState(m: EntityManager, state: StagedState): Promise<AppliedLessonIds> {
  // Computed before any write: the ids describe the change set, not the rows left afterwards.
  const ids = closeLessonIds(computeDiff(state));
  const { course } = state;
  const p = course.pending ?? {};
  const live: Partial<Pick<Course, 'title' | 'description' | 'category' | 'thumbnail_url' | 'pricing_type' | 'price_etb'>> = {};
  if (p.title !== undefined) live.title = p.title;
  if (p.description !== undefined) live.description = p.description;
  if (p.category !== undefined) live.category = p.category as Course['category'];
  if (p.thumbnail_url !== undefined) live.thumbnail_url = p.thumbnail_url;
  if (p.pricing_type !== undefined) live.pricing_type = p.pricing_type as Course['pricing_type'];
  if (p.price_etb !== undefined) live.price_etb = p.price_etb;
  if (Object.keys(live).length || course.pending) await m.getRepository(Course).update({ id: course.id }, { ...live, pending: null });

  const lessonRepo = m.getRepository(Lesson);
  const sectionRepo = m.getRepository(Section);
  const removedSectionIds = state.sections.filter((s) => s.pending_state === 'removed').map((s) => s.id);
  const removedSections = new Set(removedSectionIds);
  // Every lesson of a removed section goes with it, including ones added there.
  const deleteLessonIds = state.lessons.filter((l) => l.pending_state === 'removed' || removedSections.has(l.section_id)).map((l) => l.id);
  const deleteLessons = new Set(deleteLessonIds);

  for (const l of state.lessons) {
    if (deleteLessons.has(l.id) || (!l.pending_state && !l.pending)) continue;
    const merged = mergedLesson(l);
    await lessonRepo.update(
      { id: l.id },
      { title: merged.title, summary: merged.summary, duration_seconds: merged.duration_seconds, video_s3_key: merged.video_s3_key, pending: null, pending_state: null },
    );
  }
  for (const s of state.sections) {
    if (removedSections.has(s.id) || (!s.pending_state && !s.pending)) continue;
    const merged = mergedSection(s);
    await sectionRepo.update({ id: s.id }, { title: merged.title, is_free_preview: merged.is_free_preview, pending: null, pending_state: null });
  }
  // Lessons first: they reference their section.
  if (deleteLessonIds.length) await lessonRepo.delete({ id: In(deleteLessonIds) });
  if (removedSectionIds.length) await sectionRepo.delete({ id: In(removedSectionIds) });

  const noteTitles = [...new Set(state.pendingKnowledge.map((k) => k.title))];
  if (noteTitles.length) {
    const knowledgeRepo = m.getRepository(CourseKnowledge);
    // A re-uploaded note replaces the live note of the same title.
    await knowledgeRepo.delete({ course_id: course.id, source: 'notes', state: 'live', title: In(noteTitles) });
    // Only the notes that were loaded (and hashed/reviewed): a note is not
    // covered by the course row lock, so one added meanwhile stays pending
    // for the next revision instead of going live unreviewed.
    await knowledgeRepo.update({ id: In(state.pendingKnowledge.map((k) => k.id)) }, { state: 'live' });
  }
  return { addedLessonIds: ids.added_lesson_ids, removedLessonIds: ids.removed_lesson_ids, replacedVideoLessonIds: ids.replaced_video_lesson_ids };
}

/** Throw away every staged change: 'added' rows, pending overrides, 'removed' markers, pending notes. */
export async function discardStagedState(m: EntityManager, state: StagedState): Promise<void> {
  const lessonRepo = m.getRepository(Lesson);
  const sectionRepo = m.getRepository(Section);
  const addedSectionIds = state.sections.filter((s) => s.pending_state === 'added').map((s) => s.id);
  const addedSections = new Set(addedSectionIds);
  const dropLessonIds = state.lessons.filter((l) => l.pending_state === 'added' || addedSections.has(l.section_id)).map((l) => l.id);
  const dropLessons = new Set(dropLessonIds);
  const resetLessonIds = state.lessons.filter((l) => !dropLessons.has(l.id) && (l.pending_state || l.pending)).map((l) => l.id);
  const resetSectionIds = state.sections.filter((s) => !addedSections.has(s.id) && (s.pending_state || s.pending)).map((s) => s.id);

  if (dropLessonIds.length) await lessonRepo.delete({ id: In(dropLessonIds) });
  if (addedSectionIds.length) await sectionRepo.delete({ id: In(addedSectionIds) });
  if (resetLessonIds.length) await lessonRepo.update({ id: In(resetLessonIds) }, { pending_state: null, pending: null });
  if (resetSectionIds.length) await sectionRepo.update({ id: In(resetSectionIds) }, { pending_state: null, pending: null });
  if (state.course.pending) await m.getRepository(Course).update({ id: state.course.id }, { pending: null });
  // Unconditional: a note is not covered by the course row lock, so one added
  // after the state was loaded must go too.
  await m.getRepository(CourseKnowledge).delete({ course_id: state.course.id, state: 'pending' });
}

async function courseRow(m: EntityManager, courseId: string): Promise<Course | null> {
  return m.getRepository(Course).findOne({ where: { id: courseId } });
}

const NOTHING_APPLIED: AppliedLessonIds = { addedLessonIds: [], removedLessonIds: [], replacedVideoLessonIds: [] };

/** applyStagedState for a course id; a missing course applies nothing. */
export async function applyStagedRows(manager: EntityManager, courseId: string): Promise<AppliedLessonIds> {
  const course = await courseRow(manager, courseId);
  if (!course) return { ...NOTHING_APPLIED };
  return applyStagedState(manager, await loadStagedState(manager, course));
}

/** discardStagedState for a course id; a missing course has nothing to discard. */
export async function discardStagedRows(manager: EntityManager, courseId: string): Promise<void> {
  const course = await courseRow(manager, courseId);
  if (!course) return;
  await discardStagedState(manager, await loadStagedState(manager, course));
}

/** True when the course has staged rows (course/section/lesson pending values or markers, pending notes). */
export async function hasStagedRows(manager: EntityManager, courseId: string): Promise<boolean> {
  const course = await courseRow(manager, courseId);
  if (!course) return false;
  return hasStagedState(await loadStagedState(manager, course));
}
