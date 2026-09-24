import {
  CHANGED_TEXT_MAX,
  changedText,
  changelogSentence,
  closeLessonIds,
  computeDiff,
  contentHash,
  CourseLike,
  frozenAssessments,
  KnowledgeLike,
  LessonLike,
  mergedCourse,
  mergedLesson,
  mergedSection,
  pendingAssessmentIds,
  RevisionState,
  SectionLike,
  validateMerged,
} from './revision-diff';

function course(over: Partial<CourseLike> = {}): CourseLike {
  return {
    id: 'c1',
    title: 'Approved title',
    description: 'Approved description of the course',
    category: 'programming',
    thumbnail_url: 'http://x/thumb.png',
    pricing_type: 'paid',
    price_etb: '500.00',
    status: 'published',
    pending: null,
    ...over,
  };
}

function section(id: string, order: number, over: Partial<SectionLike> = {}): SectionLike {
  return { id, title: `Section ${id}`, order_index: order, is_free_preview: false, pending_state: null, pending: null, ...over };
}

function lesson(id: string, sectionId: string, order: number, over: Partial<LessonLike> = {}): LessonLike {
  return {
    id,
    section_id: sectionId,
    title: `Lesson ${id}`,
    summary: `Summary ${id}`,
    duration_seconds: 300,
    video_s3_key: `videos/edu1/${id}.mp4`,
    order_index: order,
    pending_state: null,
    pending: null,
    ...over,
  };
}

/** A live course with one of every kind of staged change. */
function stagedState(): RevisionState {
  return {
    course: course({ pending: { title: 'New title', price_etb: '600', description: 'Approved description of the course' } }),
    sections: [
      section('s1', 0, { is_free_preview: true, pending: { title: 'Intro (updated)' } }),
      section('s2', 1, { pending_state: 'added', is_free_preview: true }),
      section('s3', 2, { pending_state: 'removed' }),
    ],
    lessons: [
      lesson('l1', 's1', 0, { pending: { video_s3_key: 'videos/edu1/NEW.mp4', summary: 'Better summary' } }),
      lesson('l2', 's1', 1, { pending_state: 'removed' }),
      lesson('l4', 's1', 2, { pending_state: 'added', video_s3_key: null }),
      lesson('l3', 's2', 0, { pending_state: 'added' }),
      lesson('l5', 's3', 0, { pending_state: 'removed' }),
    ],
    pendingKnowledge: [
      { title: 'Cheat sheet', text: 'second chunk', chunk_index: 1 },
      { title: 'Cheat sheet', text: 'first chunk', chunk_index: 0 },
    ],
  };
}

describe('merge helpers', () => {
  it('overlay pending values on live ones and keep live values for absent keys', () => {
    expect(mergedCourse(course({ pending: { title: 'T2', thumbnail_url: null } }))).toEqual({
      title: 'T2',
      description: 'Approved description of the course',
      category: 'programming',
      thumbnail_url: null,
      pricing_type: 'paid',
      price_etb: '500.00',
    });
    expect(mergedSection(section('s', 0, { pending: { is_free_preview: true } }))).toEqual({ title: 'Section s', is_free_preview: true });
    expect(mergedLesson(lesson('l', 's', 0, { pending: { title: 'New', duration_seconds: 90 } }))).toEqual({
      title: 'New',
      summary: 'Summary l',
      duration_seconds: 90,
      video_s3_key: 'videos/edu1/l.mp4',
    });
  });
});

describe('computeDiff', () => {
  it('produces the documented before/after shape', () => {
    const diff = computeDiff(stagedState(), [{ id: 'a1' }]);

    expect(diff.course).toEqual({ id: 'c1', title: 'Approved title', status: 'published', thumbnail_url: 'http://x/thumb.png' });
    // description is staged with its live value → not a change; price compares numerically
    expect(diff.metadata).toEqual([
      { field: 'title', before: 'Approved title', after: 'New title' },
      { field: 'price_etb', before: 500, after: 600 },
    ]);
    expect(diff.sections).toEqual({
      added: [{ id: 's2', title: 'Section s2', is_free_preview: true, lessons: [{ id: 'l3', title: 'Lesson l3', summary: 'Summary l3', has_video: true }] }],
      removed: [{ id: 's3', title: 'Section s3' }],
      changed: [{ id: 's1', before: { title: 'Section s1', is_free_preview: true }, after: { title: 'Intro (updated)', is_free_preview: true } }],
    });
    expect(diff.lessons.added).toEqual([
      { id: 'l4', section_id: 's1', section_title: 'Intro (updated)', title: 'Lesson l4', summary: 'Summary l4', has_video: false },
    ]);
    expect(diff.lessons.removed).toEqual([
      { id: 'l2', section_title: 'Section s1', title: 'Lesson l2' },
      { id: 'l5', section_title: 'Section s3', title: 'Lesson l5' },
    ]);
    expect(diff.lessons.changed).toEqual([
      {
        id: 'l1',
        section_title: 'Intro (updated)',
        title_before: 'Lesson l1',
        title_after: 'Lesson l1',
        summary_before: 'Summary l1',
        summary_after: 'Better summary',
        duration_before: 300,
        duration_after: 300,
        video_replaced: true,
      },
    ]);
    expect(diff.knowledge_added).toEqual([{ title: 'Cheat sheet', chars: 23, excerpt: 'first chunk second chunk' }]);
    expect(diff.pending_assessments).toEqual([{ id: 'a1' }]);
    expect(diff.empty).toBe(false);
  });

  it('summarises the counts the QA queue shows as chips', () => {
    expect(computeDiff(stagedState(), [{ id: 'a1' }, { id: 'a2' }]).diff_summary).toEqual({
      fields_changed: ['title', 'price_etb'],
      sections_added: 1,
      sections_removed: 1,
      sections_changed: 1,
      lessons_added: 2, // l4 in a live section + l3 in the added section
      lessons_removed: 2, // l2 + l5 (inside the removed section)
      lessons_changed: 1,
      videos_replaced: 1,
      price_from: 500,
      price_to: 600,
      pricing_type_from: null,
      pricing_type_to: null,
      new_free_preview_section: true, // s2 is added as free preview
      knowledge_added: 1,
      assessments_added: 2,
    });
  });

  it('flags a live section that becomes free preview, and reports pricing type changes', () => {
    const diff = computeDiff({
      course: course({ pricing_type: 'free', price_etb: null, pending: { pricing_type: 'paid', price_etb: '250.00' } }),
      sections: [section('s1', 0, { pending: { is_free_preview: true } })],
      lessons: [lesson('l1', 's1', 0)],
      pendingKnowledge: [],
    });
    expect(diff.diff_summary).toMatchObject({
      new_free_preview_section: true,
      pricing_type_from: 'free',
      pricing_type_to: 'paid',
      price_from: null,
      price_to: 250,
      sections_changed: 1,
    });
  });

  it('is empty when nothing differs from live (pending values equal to live do not count)', () => {
    const diff = computeDiff({
      course: course({ pending: { title: 'Approved title', price_etb: '500' } }),
      sections: [section('s1', 0, { pending: { title: 'Section s1' } })],
      lessons: [lesson('l1', 's1', 0, { pending: { video_s3_key: 'videos/edu1/l1.mp4' } })],
      pendingKnowledge: [],
    });
    expect(diff.empty).toBe(true);
    expect(diff.metadata).toEqual([]);
  });

  it('a pending assessment alone makes the diff non-empty', () => {
    const state: RevisionState = { course: course(), sections: [section('s1', 0)], lessons: [lesson('l1', 's1', 0)], pendingKnowledge: [] };
    expect(computeDiff(state).empty).toBe(true);
    expect(computeDiff(state, [{ id: 'a1' }]).empty).toBe(false);
  });

  it('a cleared video key is a change but not a replaced video', () => {
    const diff = computeDiff({
      course: course(),
      sections: [section('s1', 0)],
      lessons: [lesson('l1', 's1', 0, { pending: { video_s3_key: null } })],
      pendingKnowledge: [],
    });
    expect(diff.lessons.changed).toHaveLength(1);
    expect(diff.lessons.changed[0].video_replaced).toBe(false);
    expect(diff.diff_summary.videos_replaced).toBe(0);
  });

  it('lists the lesson ids downstream services react to on apply', () => {
    expect(closeLessonIds(computeDiff(stagedState()))).toEqual({
      added_lesson_ids: ['l4', 'l3'],
      removed_lesson_ids: ['l2', 'l5'],
      replaced_video_lesson_ids: ['l1'],
    });
  });
});

describe('contentHash', () => {
  it('is stable across row order and object key order', () => {
    const a = stagedState();
    const b = stagedState();
    b.sections.reverse();
    b.lessons.reverse();
    b.pendingKnowledge.reverse();
    b.course.pending = { description: 'Approved description of the course', price_etb: '600', title: 'New title' };
    expect(contentHash(b)).toBe(contentHash(a));
    expect(contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any staged value changes (incl. the content of an added row and pending notes)', () => {
    const base = contentHash(stagedState());
    const pendingEdit = stagedState();
    pendingEdit.lessons[0].pending = { video_s3_key: 'videos/edu1/OTHER.mp4', summary: 'Better summary' };
    const addedEdit = stagedState();
    addedEdit.lessons[3].title = 'Renamed added lesson';
    const noteEdit = stagedState();
    noteEdit.pendingKnowledge[0].text = 'second chunk, longer';
    const unmarked = stagedState();
    unmarked.lessons[1].pending_state = null;
    for (const s of [pendingEdit, addedEdit, noteEdit, unmarked]) expect(contentHash(s)).not.toBe(base);
  });

  it('ignores untouched live rows and treats an empty pending object as no pending', () => {
    const a = stagedState();
    const b = stagedState();
    b.sections.push(section('s9', 9));
    b.lessons.push(lesson('l9', 's9', 0, { pending: {} }));
    expect(contentHash(b)).toBe(contentHash(a));
  });

  // A revision id is reused across withdraw + resubmit; an approval of the
  // earlier submission must not match a resubmission that only adds a quiz.
  it('binds the frozen assessment ids, in any order, and hashes as before when there are none', () => {
    const state = stagedState();
    const without = contentHash(state);
    expect(contentHash(state, [])).toBe(without);
    expect(contentHash(state, ['a1'])).not.toBe(without);
    expect(contentHash(state, ['a1', 'a2'])).not.toBe(contentHash(state, ['a1']));
    expect(contentHash(state, ['a2', 'a1', 'a1'])).toBe(contentHash(state, ['a1', 'a2']));
  });
});

describe('pending assessment ids', () => {
  it('reads the ids outcomes returns, ignoring malformed items and duplicates', () => {
    expect(pendingAssessmentIds([{ id: 'a1', type: 'quiz' }, { id: 'a2' }, { id: 'a1' }, { type: 'no id' }, null, 'x', { id: 7 }, { id: '' }])).toEqual(['a1', 'a2']);
    expect(pendingAssessmentIds(undefined)).toEqual([]);
    expect(pendingAssessmentIds(null)).toEqual([]);
  });

  it('keeps only the assessments frozen at submit (one created later is not part of the decision)', () => {
    const live = [{ id: 'a1', created_at: 't1' }, { id: 'a-late', created_at: 't3' }, { id: 'a2', created_at: 't2' }];
    expect(frozenAssessments(live, ['a1', 'a2'])).toEqual([{ id: 'a1', created_at: 't1' }, { id: 'a2', created_at: 't2' }]);
    expect(frozenAssessments(live, [])).toEqual([]);
  });
});

describe('changedText', () => {
  it('contains only new/changed learner-facing text', () => {
    const text = changedText(computeDiff(stagedState()));
    expect(text.split('\n')).toEqual([
      'New title',
      'Section s2',
      'Lesson l3',
      'Summary l3',
      'Intro (updated)',
      'Lesson l4',
      'Summary l4',
      'Better summary',
      'Cheat sheet: first chunk second chunk',
    ]);
    expect(text).not.toContain('Approved description');
    expect(text).not.toContain('Lesson l1'); // unchanged title of a changed lesson
  });

  it(`is capped at ${CHANGED_TEXT_MAX} characters`, () => {
    const notes: KnowledgeLike[] = Array.from({ length: 40 }, (_, i) => ({ title: `Note ${i}`, text: 'x'.repeat(1000), chunk_index: 0 }));
    const diff = computeDiff({
      course: course({ pending: { description: 'd'.repeat(2000) } }),
      sections: [section('s1', 0)],
      lessons: [lesson('l1', 's1', 0)],
      pendingKnowledge: notes,
    });
    expect(diff.knowledge_added.every((k) => k.excerpt.length <= 400)).toBe(true);
    expect(changedText(diff).length).toBe(CHANGED_TEXT_MAX);
  });
});

describe('validateMerged', () => {
  const ok = (): RevisionState => ({ course: course(), sections: [section('s1', 0)], lessons: [lesson('l1', 's1', 0)], pendingKnowledge: [] });

  it('accepts a publishable merged course', () => {
    expect(validateMerged(ok())).toBeNull();
  });

  it('applies the first-submission rules to the course as it will look after apply', () => {
    const noSections = ok();
    noSections.sections[0].pending_state = 'removed';
    expect(validateMerged(noSections)).toMatch(/no sections/);

    const noLessons = ok();
    noLessons.lessons[0].pending_state = 'removed';
    expect(validateMerged(noLessons)).toMatch(/no lessons/);

    const noThumb = ok();
    noThumb.course.pending = { thumbnail_url: null };
    expect(validateMerged(noThumb)).toMatch(/thumbnail/i);

    const paidNoPrice = ok();
    paidNoPrice.course.pending = { price_etb: null };
    expect(validateMerged(paidNoPrice)).toMatch(/price/);

    const freemium = ok();
    freemium.course.pending = { pricing_type: 'freemium' };
    expect(validateMerged(freemium)).toMatch(/free-preview/);
    freemium.sections[0].pending = { is_free_preview: true };
    expect(validateMerged(freemium)).toBeNull();
  });

  it('counts added rows as live-after-apply', () => {
    const state = ok();
    state.sections[0].pending_state = 'removed';
    state.sections.push(section('s2', 1, { pending_state: 'added' }));
    state.lessons.push(lesson('l2', 's2', 0, { pending_state: 'added' }));
    expect(validateMerged(state)).toBeNull();
  });
});

describe('changelogSentence', () => {
  it('builds one readable sentence from the summary', () => {
    expect(changelogSentence(computeDiff(stagedState(), [{ id: 'a1' }]).diff_summary)).toBe(
      'Course updated: 1 new section, 2 new lessons, 1 lesson updated, 1 video replaced, 1 section updated, 2 lessons removed, 1 section removed, 1 new assessment, 1 new tutor note, updated title and price.',
    );
  });

  it('falls back to a generic sentence', () => {
    const empty = computeDiff({ course: course(), sections: [], lessons: [], pendingKnowledge: [] }).diff_summary;
    expect(changelogSentence(empty)).toBe('Course content updated.');
  });
});
