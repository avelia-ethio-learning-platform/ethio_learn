import { describe, expect, it } from 'vitest';
import { DIGEST_BUDGET_CHARS, DIGEST_BUDGET_TOKENS, estimateTokens, fitsDigestBudget, OUTLINE_HEADER } from '@/lib/outline-source';
import {
  appliedMessage,
  clampKnowledgeText,
  condensedNote,
  condenseSourceText,
  digestNote,
  droppedDocNote,
  editState,
  groupUploadHints,
  knowledgeTitle,
  lessonBadges,
  noteRemoval,
  offlineOutlineBanner,
  planPaste,
  sectionBadges,
  stagedChangeChips,
  toApplyBody,
  toDraft,
  type KnowledgeDoc,
  type SourceDoc,
  type WorkingLesson,
  type WorkingSection,
} from './working';

const lesson = (over: Partial<WorkingLesson> = {}): WorkingLesson => ({
  id: 'l1',
  title: 'Lesson',
  summary: null,
  duration_seconds: 0,
  order: 0,
  has_video: false,
  video_pending: false,
  pending_state: null,
  changed_fields: [],
  ...over,
});

const section = (over: Partial<WorkingSection> = {}): WorkingSection => ({
  id: 's1',
  title: 'Section',
  order: 0,
  is_free_preview: false,
  pending_state: null,
  changed_fields: [],
  lessons: [],
  ...over,
});

describe('editState', () => {
  it('edits drafts directly', () => {
    expect(editState({ status: 'draft', revision: null })).toEqual({ live: false, canEdit: true, locked: false, lockReason: null });
  });

  it('stages edits on live courses until a revision is submitted', () => {
    expect(editState({ status: 'published', revision: null })).toMatchObject({ live: true, canEdit: true, locked: false });
    const draftRevision = { id: 'r', status: 'draft', changelog_summary: null, major: false, submitted_at: null, decision_notes: null };
    expect(editState({ status: 'unlisted', revision: draftRevision }).locked).toBe(false);
    for (const status of ['submitted', 'institution_review']) {
      const s = editState({ status: 'published', revision: { ...draftRevision, status } });
      expect(s.locked).toBe(true);
      expect(s.lockReason).toMatch(/withdraw them/i);
    }
  });

  it('locks a first-time submission in review', () => {
    for (const status of ['submitted', 'under_review', 'institution_review']) {
      const s = editState({ status, revision: null });
      expect(s).toMatchObject({ canEdit: true, locked: true, live: false });
      expect(s.lockReason).toMatch(/withdraw it/i);
    }
  });

  it('offers no editing on archived or flagged courses', () => {
    expect(editState({ status: 'archived', revision: null }).canEdit).toBe(false);
    expect(editState({ status: 'flagged', revision: null }).canEdit).toBe(false);
  });
});

describe('badges', () => {
  it('marks new, removing and edited sections', () => {
    expect(sectionBadges(section({ pending_state: 'added' }))).toEqual([{ label: 'New', tone: 'new' }]);
    expect(sectionBadges(section({ pending_state: 'removed', changed_fields: ['title'] }))).toEqual([{ label: 'Removing', tone: 'removing' }]);
    expect(sectionBadges(section({ changed_fields: ['is_free_preview'] }))).toEqual([{ label: 'Edited', tone: 'edited' }]);
    expect(sectionBadges(section())).toEqual([]);
  });

  it('separates a replaced video from other lesson edits', () => {
    expect(lessonBadges(lesson({ changed_fields: ['video_s3_key'], video_pending: true }), null)).toEqual([{ label: 'New video pending', tone: 'video' }]);
    expect(lessonBadges(lesson({ changed_fields: ['title', 'video_s3_key'], video_pending: true }), null).map((b) => b.label)).toEqual([
      'Edited',
      'New video pending',
    ]);
    expect(lessonBadges(lesson({ pending_state: 'added' }), null)).toEqual([{ label: 'New', tone: 'new' }]);
  });

  it('lets a section state override its lessons', () => {
    expect(lessonBadges(lesson({ changed_fields: ['title'] }), 'removed')).toEqual([{ label: 'Removing', tone: 'removing' }]);
    expect(lessonBadges(lesson({ pending_state: 'added' }), 'added')).toEqual([]);
  });
});

describe('stagedChangeChips', () => {
  const base = { pending_fields: [] as string[], pending_knowledge_count: 0, pending_assessments_count: 0 };

  it('is empty when nothing is staged', () => {
    expect(stagedChangeChips({ ...base, sections: [section({ lessons: [lesson()] })] })).toEqual([]);
  });

  it('summarises every kind of staged change', () => {
    const chips = stagedChangeChips({
      pending_fields: ['title', 'price_etb'],
      pending_knowledge_count: 1,
      pending_assessments_count: 2,
      sections: [
        section({
          id: 'live',
          changed_fields: ['title'],
          lessons: [
            lesson({ id: 'a', pending_state: 'added', has_video: true }),
            lesson({ id: 'b', pending_state: 'removed' }),
            lesson({ id: 'c', changed_fields: ['summary'] }),
            lesson({ id: 'd', changed_fields: ['video_s3_key'], video_pending: true, has_video: true }),
          ],
        }),
        section({ id: 'new', pending_state: 'added', lessons: [lesson({ id: 'e', pending_state: 'added' }), lesson({ id: 'f', pending_state: 'added' })] }),
        section({ id: 'gone', pending_state: 'removed', lessons: [lesson({ id: 'g', pending_state: 'removed' })] }),
      ],
    });
    expect(chips).toEqual([
      'title, price edited',
      '+1 section',
      '−1 section',
      '1 section edited',
      '+3 lessons',
      '−1 lesson',
      '1 lesson edited',
      '2 new videos',
      '1 tutor note',
      '2 new assessments',
    ]);
  });
});

describe('toApplyBody', () => {
  it('trims, clamps and drops empty summaries', () => {
    const res = toApplyBody([
      { title: '  Intro  ', is_free_preview: true, lessons: [{ title: ' Welcome ', summary: '  ' }, { title: 'Setup', summary: 'x'.repeat(600) }] },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.sections[0]).toEqual({
      title: 'Intro',
      is_free_preview: true,
      lessons: [{ title: 'Welcome' }, { title: 'Setup', summary: 'x'.repeat(500) }],
    });
  });

  it('keeps sections without lessons', () => {
    const res = toApplyBody([{ title: 'Later', is_free_preview: false, lessons: [] }]);
    expect(res).toEqual({ ok: true, body: { sections: [{ title: 'Later', is_free_preview: false, lessons: [] }] } });
  });

  it('explains what to fix instead of sending an invalid outline', () => {
    expect(toApplyBody([])).toMatchObject({ ok: false, error: expect.stringMatching(/no sections/) });
    expect(toApplyBody([{ title: ' x ', is_free_preview: false, lessons: [] }])).toMatchObject({ ok: false, error: expect.stringMatching(/Section 1 needs a title/) });
    expect(toApplyBody([{ title: 'Basics', is_free_preview: false, lessons: [{ title: 'ok' }, { title: '' }] }])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Lesson 2 in "Basics"/),
    });
    const many = Array.from({ length: 13 }, (_, i) => ({ title: `S${i + 1}`, is_free_preview: false, lessons: [] }));
    expect(toApplyBody(many)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 12 sections — remove or merge 1/) });
    const long = [{ title: 'Big', is_free_preview: false, lessons: Array.from({ length: 13 }, (_, i) => ({ title: `L${i + 1}` })) }];
    expect(toApplyBody(long)).toMatchObject({ ok: false, error: expect.stringMatching(/"Big" has 13 lessons/) });
  });
});

describe('toDraft', () => {
  it('fills in missing fields from the generator reply', () => {
    expect(toDraft([{ title: 'A', lessons: [{ title: 'L' }] }, {}])).toEqual([
      { title: 'A', is_free_preview: false, lessons: [{ title: 'L', summary: '' }] },
      { title: '', is_free_preview: false, lessons: [] },
    ]);
  });
});

describe('messages', () => {
  it('reports what was applied and whether it is staged', () => {
    expect(appliedMessage({ sections_added: 1, lessons_added: 3 }, false)).toBe('Added 1 section / 3 lessons.');
    expect(appliedMessage({ sections_added: 4, lessons_added: 1 }, true)).toBe('Added 4 sections / 1 lesson — staged: submit your changes for review to publish them.');
  });

  it('describes the digest, leaving pages out for formats without them', () => {
    expect(digestNote({ pages: 613, chars: 1413347 }, { digest: 'x'.repeat(20753) })).toBe(
      'full document: 613 pages / 1,413,347 chars → sending a 20,753-char digest',
    );
    expect(digestNote({ pages: 1, chars: 900 }, { digest: 'x'.repeat(900) })).toBe('full document: 1 page / 900 chars → sending a 900-char digest');
    expect(digestNote({ pages: 0, chars: 59295 }, { digest: 'x'.repeat(21044) })).toBe('full document: 59,295 chars → sending a 21,044-char digest');
  });
});

describe('clampKnowledgeText', () => {
  it('leaves short text alone', () => {
    expect(clampKnowledgeText('hello')).toEqual({ text: 'hello', truncated: false });
  });

  it('caps characters', () => {
    expect(clampKnowledgeText('abcdef', 4, 100)).toEqual({ text: 'abcd', truncated: true });
  });

  it('caps UTF-8 bytes, so Amharic gets fewer characters', () => {
    // Ethiopic syllables are 3 bytes each in UTF-8.
    expect(clampKnowledgeText('ሰላምሰላም', 100, 7)).toEqual({ text: 'ሰላ', truncated: true });
  });

  it('never splits a surrogate pair', () => {
    expect(clampKnowledgeText('a😀b', 100, 4)).toEqual({ text: 'a', truncated: true });
    expect(clampKnowledgeText('a😀b', 2, 100)).toEqual({ text: 'a', truncated: true });
    expect(clampKnowledgeText('a😀b', 100, 5)).toEqual({ text: 'a😀', truncated: true });
  });
});

describe('knowledgeTitle', () => {
  it('drops the extension and stays within 200 chars', () => {
    expect(knowledgeTitle('Chapter 1 notes.pdf')).toBe('Chapter 1 notes');
    expect(knowledgeTitle('.pdf')).toBe('.pdf');
    expect(knowledgeTitle(`${'n'.repeat(250)}.docx`)).toHaveLength(200);
  });
});

describe('groupUploadHints', () => {
  it('groups by lesson and collects records for missing lessons', () => {
    const hint = (storageKey: string, lessonId?: string) => ({ storageKey, fileName: `${storageKey}.mp4`, size: 1, lessonId, createdAt: 0 });
    const { byLesson, orphans } = groupUploadHints([hint('a', 'l1'), hint('b', 'l1'), hint('c', 'gone'), hint('d')], new Set(['l1', 'l2']));
    expect(Object.keys(byLesson)).toEqual(['l1']);
    expect(byLesson.l1.map((h) => h.storageKey)).toEqual(['a', 'b']);
    expect(orphans.map((h) => h.storageKey)).toEqual(['c', 'd']);
  });
});

// ---------------------------------------------------------------------------
// Source text over the model's budget (pdf-ai-01) and pastes over a digest (pdf-ai-06)
// ---------------------------------------------------------------------------

/** Plain prose of exactly `chars` characters, one sentence per line. */
const prose = (chars: number, word = 'Soil') => {
  const lines: string[] = [];
  for (let i = 0, n = 0; n < chars; i++) {
    lines.push(`${word} topic ${i} is explained in this plain sentence here.`);
    n += lines[i].length + 1;
  }
  return lines.join('\n').slice(0, chars);
};
/** Ge'ez-script text: about 1.5 characters per estimated token, so the token budget binds long before 24,000 characters. */
const geez = (chars: number) => 'ሰላም ለዓለም። '.repeat(Math.ceil(chars / 10)).slice(0, chars);

describe('condenseSourceText', () => {
  it('condenses pasted text between the model budget and the old 30,000 limit instead of letting the server cut its end', () => {
    const notes = `${prose(24_000)}\nSkip chapter 12; focus on mobile money.`;
    expect(notes.length).toBeGreaterThan(DIGEST_BUDGET_CHARS);
    expect(notes.length).toBeLessThan(30_000);
    expect(fitsDigestBudget(notes)).toBe(false);
    const d = condenseSourceText(notes);
    expect(d.digest.length).toBeLessThanOrEqual(DIGEST_BUDGET_CHARS);
    expect(fitsDigestBudget(d.digest)).toBe(true);
    // Evenly spaced windows cover the whole text, up to its end, rather than its first 24,000 characters.
    const shares = (d.digest.match(/\[Excerpt \d+\/\d+ ~\d+%\]/g) ?? []).map((label) => Number(label.replace(/.*~(\d+)%.*/, '$1')));
    expect(Math.max(...shares)).toBeGreaterThanOrEqual(90);
  });

  it('condenses Amharic text that is short in characters but over the token budget', () => {
    const amharic = geez(20_000);
    expect(amharic.length).toBeLessThan(DIGEST_BUDGET_CHARS);
    expect(estimateTokens(amharic)).toBeGreaterThan(DIGEST_BUDGET_TOKENS);
    const d = condenseSourceText(amharic);
    expect(d.estTokens).toBeLessThanOrEqual(DIGEST_BUDGET_TOKENS);
    expect(fitsDigestBudget(d.digest)).toBe(true);
  });

  it('reads markdown headings in pasted notes as the outline', () => {
    const notes = Array.from({ length: 12 }, (_, i) => `## Week ${i + 1} topic\n${prose(2_500, `Week${i + 1}`)}`).join('\n\n');
    const d = condenseSourceText(notes);
    expect(d.digest.startsWith(OUTLINE_HEADER)).toBe(true);
    expect(d.digest).toContain('Week 12 topic');
    expect(d.headings).toBe(12);
  });

  it('says why the text was condensed and how big the digest is', () => {
    expect(condensedNote(29_000, { digest: 'x'.repeat(23_500) })).toBe(
      'Condensed because the AI reads at most 24,000 characters at once (fewer for Amharic text): 29,000 chars → sending a 23,500-char digest.',
    );
  });
});

describe('planPaste', () => {
  const book: SourceDoc = { name: 'ddia.pdf', kind: 'file', fullText: 'the whole 1.4M-character book' };
  const digest = `${OUTLINE_HEADER}\nChapter 1 Reliable systems\n\nEXCERPTS:\n## Chapter 1 Reliable systems\nFaults happen.`;

  it('lets a short paste into an empty box through untouched', () => {
    expect(planPaste('', 'My notes', 0, 0, null)).toEqual({ full: 'My notes', condense: false, doc: null, dropped: null });
  });

  it('condenses a paste that takes the box past the budget, keeping the whole text for the tutor', () => {
    const box = prose(23_800);
    const plan = planPaste(box, `\n${prose(400, 'Extra')}`, box.length, box.length, null);
    expect(plan.condense).toBe(true);
    expect(plan.doc).toEqual({ name: 'Pasted notes', kind: 'pasted', fullText: plan.full });
    expect(plan.dropped).toBeNull();
  });

  it('condenses Amharic that is over the token budget though under 24,000 characters', () => {
    const plan = planPaste('', geez(12_000), 0, 0, null);
    expect(plan.full.length).toBeLessThan(DIGEST_BUDGET_CHARS);
    expect(plan.condense).toBe(true);
  });

  it('stops offering the uploaded book to the tutor once a paste mixes other text into its digest', () => {
    const plan = planPaste(digest, '\nAlso cover mobile money.', digest.length, digest.length, book);
    expect(plan.condense).toBe(false);
    expect(plan.doc).toEqual({ ...book, fullText: null });
    expect(plan.dropped).toBe(book);
    expect(droppedDocNote(book)).toMatch(/no longer matches “ddia\.pdf”.*upload the file again/);
  });

  it('keeps the digest-plus-notes out of the tutor even when the mix has to be condensed', () => {
    const plan = planPaste(digest, prose(30_000, 'Notes'), digest.length, digest.length, book);
    expect(plan.condense).toBe(true);
    // Never "Pasted notes" with the digest inside: the tutor would get excerpts instead of the book.
    expect(plan.doc).toEqual({ ...book, fullText: null });
    expect(plan.dropped).toBe(book);
  });

  it('treats replacing the whole box as the educator’s own text', () => {
    const short = planPaste(digest, 'Short notes', 0, digest.length, book);
    expect(short).toMatchObject({ condense: false, doc: null, dropped: book });
    const long = planPaste(digest, prose(30_000, 'Notes'), 0, digest.length, book);
    expect(long.condense).toBe(true);
    expect(long.doc).toEqual({ name: 'Pasted notes', kind: 'pasted', fullText: long.full });
    expect(long.dropped).toBe(book);
  });

  it('keeps the document when the paste leaves the text unchanged', () => {
    const selected = 'Faults happen.';
    const start = digest.indexOf(selected);
    expect(planPaste(digest, selected, start, start + selected.length, book)).toEqual({ full: digest, condense: false, doc: book, dropped: null });
  });

  it('does not report a document that was already dropped again', () => {
    const mixed: SourceDoc = { ...book, fullText: null };
    expect(planPaste(digest, ' more', 0, 0, mixed)).toMatchObject({ doc: mixed, dropped: null });
  });
});

describe('offlineOutlineBanner (pdf-ai-05)', () => {
  const headingsNote = "AI is offline — this is a starter outline built from your document's headings; edit it.";
  const genericNote = 'AI is offline — this is a generic starter outline; edit it or paste your notes with headings.';
  const keyNote = 'The AI service rejected the API key (expired or invalid) — an admin needs to rotate GROQ_API_KEY. Showing a starter outline you can edit.';

  it('shows nothing over a model outline', () => {
    expect(offlineOutlineBanner({ ai_live: true, origin: 'model' }, true)).toBeNull();
    expect(offlineOutlineBanner({ ai_live: true }, true)).toBeNull();
  });

  it('uses the API note, which says headings only for a headings outline', () => {
    expect(offlineOutlineBanner({ ai_live: false, origin: 'headings', note: headingsNote }, true)).toBe(headingsNote);
    expect(offlineOutlineBanner({ ai_live: false, origin: 'placeholder', note: genericNote }, true)).toBe(genericNote);
  });

  it('never claims the document’s headings for a placeholder outline, even with source text in the box', () => {
    const banner = offlineOutlineBanner({ ai_live: false, origin: 'placeholder' }, true)!;
    expect(banner).toMatch(/no headings were found in your text, so this is a generic starter outline/);
    expect(banner).not.toMatch(/built from your document's headings/);
    // An API that does not report `origin` is not trusted to have read the document either.
    expect(offlineOutlineBanner({ ai_live: false }, true)).toBe(banner);
    expect(offlineOutlineBanner({ ai_live: false, origin: 'placeholder' }, false)).toBe('AI is offline — this is a generic starter outline; edit it before adding it to your course.');
  });

  it('adds how the draft was built to a failure reason that does not say it', () => {
    expect(offlineOutlineBanner({ ai_live: false, origin: 'headings', note: keyNote }, true)).toBe(`${keyNote} It is built from your document's headings.`);
    expect(offlineOutlineBanner({ ai_live: false, origin: 'placeholder', note: keyNote }, true)).toBe(
      `${keyNote} No headings were found in your text, so it is generic — not built from your document.`,
    );
    expect(offlineOutlineBanner({ ai_live: false, origin: 'placeholder', note: keyNote }, false)).toBe(keyNote);
  });
});

describe('noteRemoval (web-ui-1)', () => {
  const note = (title: string, state: KnowledgeDoc['state'], source = 'notes'): KnowledgeDoc => ({ source, title, state, chunks: 3 });

  it('offers nothing for the automatic description and lesson index', () => {
    expect(noteRemoval(note('Course overview', 'live', 'description'), [], true)).toBeNull();
  });

  it('removes directly on a draft course', () => {
    const faq = note('FAQ', 'live');
    expect(noteRemoval(faq, [faq], false)).toEqual({ confirm: null, path: 'knowledge/FAQ' });
  });

  it('of a live note and its staged replacement, removes only the pending one and says the live one stays', () => {
    const live = note('FAQ', 'live');
    const pending = note('FAQ', 'pending');
    const docs = [live, pending];
    expect(noteRemoval(live, docs, true)).toBeNull();
    const removal = noteRemoval(pending, docs, true)!;
    expect(removal.path).toBe('knowledge/FAQ?state=pending');
    expect(removal.confirm).toBe('Remove your pending note “FAQ”? Learners never saw it; the live “FAQ” note they use stays as it is.');
  });

  it('warns that removing a live note reaches learners at once, and names the live version', () => {
    const live = note('Week 1 / Q&A', 'live');
    const removal = noteRemoval(live, [live, note('Other', 'pending')], true)!;
    expect(removal.path).toBe('knowledge/Week%201%20%2F%20Q%26A?state=live');
    expect(removal.confirm).toMatch(/Learners lose it right away/);
  });

  it('removes a new pending note without mentioning a live one', () => {
    const pending = note('Glossary', 'pending');
    expect(noteRemoval(pending, [pending], true)?.confirm).toBe('Remove your pending note “Glossary”? Learners never saw it.');
  });
});
