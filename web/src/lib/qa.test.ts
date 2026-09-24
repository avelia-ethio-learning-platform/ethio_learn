import { beforeEach, describe, expect, it } from 'vitest';
import {
  actionsForKind,
  approveGate,
  claimState,
  CLAIM_TTL_MS,
  decisionNotesError,
  diffChips,
  formatClock,
  itemKind,
  markAssessmentsUnavailable,
  markVideoOpened,
  parseVideosRecord,
  readVideosRecord,
  slaCountdown,
  structureTree,
  syncVideosRecord,
  videosReviewedKey,
  videosReviewedProgress,
  videosToReview,
  VIDEOS_RECORD_TTL_MS,
  wordDiff,
  writeVideosRecord,
  type RevisionDiff,
  type RevisionDiffSummary,
} from './qa';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-24T12:00:00Z');

function summary(overrides: Partial<RevisionDiffSummary> = {}): RevisionDiffSummary {
  return {
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
    ...overrides,
  };
}

function diff(overrides: Partial<Pick<RevisionDiff, 'sections' | 'lessons'>> = {}): Pick<RevisionDiff, 'sections' | 'lessons'> {
  return {
    sections: { added: [], removed: [], changed: [], ...overrides.sections },
    lessons: { added: [], removed: [], changed: [], ...overrides.lessons },
  };
}

function changedLesson(overrides: Partial<RevisionDiff['lessons']['changed'][number]> = {}) {
  return {
    id: 'l-changed',
    section_title: 'Basics',
    title_before: 'Intro',
    title_after: 'Intro',
    summary_before: null,
    summary_after: null,
    duration_before: 60,
    duration_after: 60,
    video_replaced: false,
    ...overrides,
  };
}

describe('actionsForKind', () => {
  it('offers approve / request changes / reject for revisions — never flag', () => {
    const actions = actionsForKind('revision');
    expect(actions.map((a) => a.action)).toEqual(['approve', 'coach', 'reject']);
    expect(actions[0].label).toBe('Approve → changes go live');
    expect(actions[1].label).toBe('Request changes');
    expect(actions[2].label).toBe('Reject changes');
  });

  it.each(['new_course', 'appeal', 'post_publish'] as const)('offers approve / coach / flag for %s — never reject', (kind) => {
    expect(actionsForKind(kind).map((a) => a.action)).toEqual(['approve', 'coach', 'flag']);
  });

  it('requires notes exactly for coach and reject', () => {
    for (const kind of ['revision', 'new_course', 'appeal', 'post_publish'] as const) {
      for (const a of actionsForKind(kind)) expect(a.notesRequired).toBe(a.action === 'coach' || a.action === 'reject');
    }
  });

  it('asks for confirmation before destructive actions only', () => {
    const confirmed = (kind: Parameters<typeof actionsForKind>[0]) =>
      actionsForKind(kind)
        .filter((a) => a.confirm)
        .map((a) => a.action);
    expect(confirmed('revision')).toEqual(['reject']);
    expect(confirmed('new_course')).toEqual(['flag']);
  });

  it('does not describe coaching a live course as sending it back to draft', () => {
    const coach = actionsForKind('post_publish').find((a) => a.action === 'coach')!;
    expect(coach.label).not.toMatch(/draft/i);
  });
});

describe('itemKind', () => {
  it('defaults rows without a (known) kind to new_course', () => {
    expect(itemKind({})).toBe('new_course');
    expect(itemKind({ kind: 'bogus' })).toBe('new_course');
    expect(itemKind({ kind: 'revision' })).toBe('revision');
  });
});

describe('decisionNotesError', () => {
  it('blocks coach and reject without notes', () => {
    expect(decisionNotesError('coach', '  ')).toMatch(/what needs to change/);
    expect(decisionNotesError('reject', '')).toMatch(/can't go live/);
  });

  it('allows approve and flag without notes, and anything with notes', () => {
    expect(decisionNotesError('approve', '')).toBeNull();
    expect(decisionNotesError('flag', '')).toBeNull();
    expect(decisionNotesError('reject', 'Wrong answer key in quiz 2')).toBeNull();
  });
});

describe('diffChips', () => {
  const texts = (s: Partial<RevisionDiffSummary> | null, priority?: number) => diffChips(s, priority).map((c) => c.text);

  it('renders counts with sign and plural', () => {
    expect(texts(summary({ lessons_added: 2, sections_added: 1, lessons_removed: 1, lessons_changed: 3 }))).toEqual([
      '+1 section',
      '+2 lessons',
      '3 lessons edited',
      '−1 lesson',
    ]);
  });

  it('renders replaced videos, price and pricing changes as warnings', () => {
    const chips = diffChips(
      summary({
        videos_replaced: 1,
        price_from: 400,
        price_to: 500,
        pricing_type_from: 'free',
        pricing_type_to: 'paid',
        fields_changed: ['price_etb', 'pricing_type'],
      }),
    );
    expect(chips).toEqual([
      { text: '1 video replaced', tone: 'warn' },
      { text: 'price 400→500 ETB', tone: 'warn' },
      { text: 'pricing free→paid', tone: 'warn' },
    ]);
  });

  it('describes a price being set or removed', () => {
    expect(texts(summary({ price_from: null, price_to: 1500 }))).toEqual(['price set: 1,500 ETB']);
    expect(texts(summary({ price_from: 250, price_to: null }))).toEqual(['price removed (was 250 ETB)']);
  });

  it('flags a new free-preview section and lists other changed fields', () => {
    expect(texts(summary({ new_free_preview_section: true, fields_changed: ['title', 'thumbnail_url'] }))).toEqual([
      'free preview added',
      'title changed',
      'thumbnail changed',
    ]);
  });

  it('counts assessments and tutor notes', () => {
    expect(texts(summary({ assessments_added: 1, knowledge_added: 2 }))).toEqual(['+1 assessment', '+2 tutor notes']);
  });

  it("adds 'low risk' only for priority 1", () => {
    expect(texts(summary({ lessons_changed: 1 }), 1)).toEqual(['1 lesson edited', 'low risk']);
    expect(diffChips(summary(), 1)).toEqual([{ text: 'low risk', tone: 'success' }]);
    expect(texts(summary({ lessons_changed: 1 }), 0)).toEqual(['1 lesson edited']);
  });

  it('tolerates a missing or partial summary (non-revision rows store {})', () => {
    expect(diffChips(null)).toEqual([]);
    expect(diffChips({})).toEqual([]);
    expect(texts({ lessons_added: 1 })).toEqual(['+1 lesson']);
  });
});

describe('slaCountdown', () => {
  it('counts down in days/hours/minutes', () => {
    expect(slaCountdown(new Date(NOW + 30 * HOUR), NOW)).toEqual({ text: '1d 6h left', tone: 'warn', overdue: false });
    expect(slaCountdown(new Date(NOW + 5 * HOUR + 15 * 60_000).toISOString(), NOW)).toEqual({ text: '5h 15m left', tone: 'danger', overdue: false });
    expect(slaCountdown(new Date(NOW + 20 * 60_000), NOW).text).toBe('20m left');
    expect(slaCountdown(new Date(NOW + 10_000), NOW).text).toBe('<1m left');
  });

  it('reports overdue items', () => {
    expect(slaCountdown(new Date(NOW - 2 * HOUR - 5 * 60_000), NOW)).toEqual({ text: 'Overdue by 2h 5m', tone: 'danger', overdue: true });
  });

  it('handles a missing deadline', () => {
    expect(slaCountdown(null, NOW)).toEqual({ text: 'No deadline', tone: 'neutral', overdue: false });
    expect(slaCountdown('not a date', NOW).tone).toBe('neutral');
  });
});

describe('claimState', () => {
  const claimedAt = new Date(NOW - 10 * 60_000).toISOString();

  it('is unclaimed without a claimant', () => {
    expect(claimState({ claimed_by: null, claimed_at: null }, 'me', NOW)).toEqual({ state: 'unclaimed' });
  });

  it('distinguishes my claim from another officer', () => {
    expect(claimState({ claimed_by: 'me', claimed_at: claimedAt }, 'me', NOW)).toEqual({ state: 'mine', expiresIn: '20m' });
    expect(claimState({ claimed_by: 'other', claimed_at: claimedAt }, 'me', NOW)).toEqual({ state: 'other' });
  });

  it('treats a claim older than 30 minutes as lapsed even if the polled row says active', () => {
    const old = new Date(NOW - CLAIM_TTL_MS - 1000).toISOString();
    expect(claimState({ claimed_by: 'other', claimed_at: old, claim_active: true }, 'me', NOW)).toEqual({ state: 'unclaimed' });
  });
});

describe('videosToReview', () => {
  it('lists new lessons with video (in new and live sections) and replaced videos', () => {
    const d = diff({
      sections: {
        added: [
          {
            id: 's-new',
            title: 'Advanced',
            is_free_preview: false,
            lessons: [
              { id: 'l1', title: 'A1', summary: null, has_video: true },
              { id: 'l2', title: 'A2', summary: null, has_video: false },
            ],
          },
        ],
        removed: [],
        changed: [],
      },
      lessons: {
        added: [{ id: 'l3', section_id: 's-live', section_title: 'Basics', title: 'B3', summary: null, has_video: true }],
        removed: [],
        changed: [changedLesson({ id: 'l4', title_after: 'Intro v2', video_replaced: true }), changedLesson({ id: 'l5' })],
      },
    });
    expect(videosToReview(d)).toEqual([
      { lesson_id: 'l1', title: 'A1', section_title: 'Advanced', change: 'new' },
      { lesson_id: 'l3', title: 'B3', section_title: 'Basics', change: 'new' },
      { lesson_id: 'l4', title: 'Intro v2', section_title: 'Basics', change: 'replaced' },
    ]);
  });
});

describe('videos-reviewed record', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('counts only required videos that were opened', () => {
    let rec = syncVideosRecord(null, 'item-1', ['a', 'b']);
    expect(videosReviewedProgress(rec)).toEqual({ opened: 0, total: 2, complete: false });
    rec = markVideoOpened(rec, 'a');
    rec = markVideoOpened(rec, 'a');
    rec = markVideoOpened(rec, 'stray');
    expect(videosReviewedProgress(rec)).toEqual({ opened: 1, total: 2, complete: false });
    rec = markVideoOpened(rec, 'b');
    expect(videosReviewedProgress(rec).complete).toBe(true);
  });

  it('is complete when the revision has no videos', () => {
    expect(videosReviewedProgress(syncVideosRecord(null, 'item-1', []))).toEqual({ opened: 0, total: 0, complete: true });
  });

  it('keeps progress for the same item and resets it for a resubmission (new item)', () => {
    const watched = markVideoOpened(syncVideosRecord(null, 'item-1', ['a']), 'a');
    expect(syncVideosRecord(watched, 'item-1', ['a', 'b']).opened).toEqual(['a']);
    expect(syncVideosRecord(watched, 'item-2', ['a'])).toEqual({ item_id: 'item-2', required: ['a'], opened: [] });
    // Opened without an item (e.g. the link was shared): keep what this tab already watched.
    expect(syncVideosRecord(watched, null, ['a'])).toEqual({ item_id: 'item-1', required: ['a'], opened: ['a'] });
  });

  it('round-trips through localStorage keyed by revision id, so a preview opened in another tab counts', () => {
    const rec = markVideoOpened(syncVideosRecord(null, 'item-1', ['a']), 'a');
    writeVideosRecord('rev-1', rec, NOW);
    // Not per-tab sessionStorage: the QA queue tab never saw what a new "Review changes" tab recorded.
    expect(sessionStorage.getItem(videosReviewedKey('rev-1'))).toBeNull();
    expect(localStorage.getItem(videosReviewedKey('rev-1'))).not.toBeNull();
    expect(readVideosRecord('rev-1')).toEqual({ ...rec, saved_at: NOW });
    expect(readVideosRecord('rev-2')).toBeNull();
  });

  it('prunes records not written for a week, and leaves other keys alone', () => {
    writeVideosRecord('rev-old', syncVideosRecord(null, 'item-0', []), NOW - VIDEOS_RECORD_TTL_MS - 1);
    writeVideosRecord('rev-recent', syncVideosRecord(null, 'item-1', []), NOW - HOUR);
    localStorage.setItem('el_auth', '{}');
    writeVideosRecord('rev-new', syncVideosRecord(null, 'item-2', []), NOW);
    expect(readVideosRecord('rev-old')).toBeNull();
    expect(readVideosRecord('rev-recent')).not.toBeNull();
    expect(readVideosRecord('rev-new')).not.toBeNull();
    expect(localStorage.getItem('el_auth')).toBe('{}');
  });

  it('keeps an assessments load failure until the diff loads completely', () => {
    const watched = markVideoOpened(syncVideosRecord(null, 'item-1', ['a']), 'a');
    const failed = markAssessmentsUnavailable(watched, 'item-1');
    expect(failed).toEqual({ item_id: 'item-1', required: ['a'], opened: ['a'], assessments_unavailable: true });
    writeVideosRecord('rev-1', failed, NOW);
    expect(readVideosRecord('rev-1')?.assessments_unavailable).toBe(true);
    // A successful load re-syncs the record, which clears the failure and keeps the videos watched.
    expect(syncVideosRecord(readVideosRecord('rev-1'), 'item-1', ['a'])).toEqual({ item_id: 'item-1', required: ['a'], opened: ['a'] });
    // A failure before any load still locks this item.
    expect(markAssessmentsUnavailable(null, 'item-1')).toEqual({ item_id: 'item-1', required: [], opened: [], assessments_unavailable: true });
  });

  it('rejects malformed stored values', () => {
    expect(parseVideosRecord('{not json')).toBeNull();
    expect(parseVideosRecord(JSON.stringify({ required: 'a', opened: [] }))).toBeNull();
    expect(parseVideosRecord(null)).toBeNull();
  });
});

describe('approveGate', () => {
  const revision = { id: 'item-1', kind: 'revision' as const, diff_summary: summary({ videos_replaced: 1 }) };

  it('never gates non-revision items', () => {
    expect(approveGate({ id: 'x', kind: 'new_course', diff_summary: {} }, null)).toEqual({ allowed: true });
  });

  it('locks a revision with possible videos until the diff has been opened', () => {
    const gate = approveGate(revision, null);
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.reason).toMatch(/Review changes/);
    expect(approveGate({ ...revision, diff_summary: summary({ lessons_added: 1 }) }, null).allowed).toBe(false);
  });

  it('allows a revision without new lessons or replaced videos', () => {
    expect(approveGate({ ...revision, diff_summary: summary({ lessons_changed: 2 }) }, null)).toEqual({ allowed: true });
  });

  it('shows k/n until every video was opened for this item', () => {
    const rec = syncVideosRecord(null, 'item-1', ['a', 'b']);
    const gate = approveGate(revision, markVideoOpened(rec, 'a'));
    expect(gate.allowed === false && gate.reason).toMatch(/1\/2 opened/);
    expect(approveGate(revision, markVideoOpened(markVideoOpened(rec, 'a'), 'b'))).toEqual({ allowed: true });
  });

  it('ignores a checklist from an earlier submission of the same revision', () => {
    const old = markVideoOpened(syncVideosRecord(null, 'item-0', ['a']), 'a');
    expect(approveGate(revision, old).allowed).toBe(false);
  });

  it('allows a revision whose added lessons turned out to have no video', () => {
    expect(approveGate({ ...revision, diff_summary: summary({ lessons_added: 2 }) }, syncVideosRecord(null, 'item-1', []))).toEqual({ allowed: true });
  });

  it('refuses Approve while the new assessments could not be loaded, even with every video watched', () => {
    const watched = markVideoOpened(syncVideosRecord(null, 'item-1', ['a']), 'a');
    const gate = approveGate(revision, markAssessmentsUnavailable(watched, 'item-1'));
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.reason).toMatch(/assessments in this update could not be loaded/);
    // Once "Review changes" loads with the assessments, the re-synced record unlocks it.
    expect(approveGate(revision, syncVideosRecord(markAssessmentsUnavailable(watched, 'item-1'), 'item-1', ['a']))).toEqual({ allowed: true });
  });

  it('locks a revision that adds assessments until the diff has been opened', () => {
    const withQuiz = { ...revision, diff_summary: summary({ assessments_added: 1 }) };
    const gate = approveGate(withQuiz, null);
    expect(gate.allowed === false && gate.reason).toMatch(/new assessments and their answer keys/);
    expect(approveGate(withQuiz, syncVideosRecord(null, 'item-1', []))).toEqual({ allowed: true });
  });
});

describe('structureTree', () => {
  it('marks added, removed and edited sections and lessons', () => {
    const tree = structureTree(
      diff({
        sections: {
          added: [{ id: 's-new', title: 'Bonus', is_free_preview: true, lessons: [{ id: 'n1', title: 'Extra', summary: 'Deep dive', has_video: true }] }],
          removed: [{ id: 's-old', title: 'Legacy' }],
          changed: [{ id: 's-live', before: { title: 'Basics', is_free_preview: false }, after: { title: 'Foundations', is_free_preview: true } }],
        },
        lessons: {
          added: [{ id: 'la', section_id: 's-live', section_title: 'Foundations', title: 'New one', summary: null, has_video: false }],
          removed: [
            { id: 'lr', section_title: 'Basics', title: 'Gone' },
            { id: 'lo', section_title: 'Legacy', title: 'Old lesson' },
          ],
          changed: [
            changedLesson({ id: 'lc', section_title: 'Foundations', title_before: 'Intro', title_after: 'Welcome', summary_after: 'Hi', video_replaced: true }),
            changedLesson({ id: 'lx', section_title: 'Untouched', duration_after: 90 }),
          ],
        },
      }),
    );

    expect(tree.map((s) => [s.marker, s.title])).toEqual([
      ['~', 'Foundations'],
      ['', 'Untouched'],
      ['+', 'Bonus'],
      ['−', 'Legacy'],
    ]);
    const [changed, context, added, removed] = tree;
    expect(changed).toMatchObject({ titleBefore: 'Basics', note: 'now free preview' });
    expect(changed.lessons).toEqual([
      { id: 'la', marker: '+', title: 'New one', note: 'no video' },
      { id: 'lr', marker: '−', title: 'Gone' },
      { id: 'lc', marker: '~', title: 'Welcome', titleBefore: 'Intro', note: 'title, summary, new video' },
    ]);
    expect(context.lessons).toEqual([{ id: 'lx', marker: '~', title: 'Intro', titleBefore: undefined, note: 'duration' }]);
    expect(added).toMatchObject({ note: 'free preview', lessons: [{ id: 'n1', marker: '+', title: 'Extra', note: 'video', summary: 'Deep dive' }] });
    expect(removed.lessons).toEqual([{ id: 'lo', marker: '−', title: 'Old lesson' }]);
  });

  it('groups lesson additions inside an unchanged section under a context node', () => {
    const tree = structureTree(
      diff({ lessons: { added: [{ id: 'la', section_id: 's1', section_title: 'Week 1', title: 'Quiz prep', summary: null, has_video: true }], removed: [], changed: [] } }),
    );
    expect(tree).toEqual([{ key: 'ctx:s1', marker: '', title: 'Week 1', lessons: [{ id: 'la', marker: '+', title: 'Quiz prep', note: 'video' }] }]);
  });
});

describe('wordDiff', () => {
  const render = (segs: ReturnType<typeof wordDiff>) => segs!.map((s) => (s.op === 'same' ? s.text : `[${s.op}:${s.text}]`)).join('');

  it('marks inserted and deleted words', () => {
    const segs = wordDiff('Learn Python basics fast', 'Learn modern Python basics');
    expect(render(segs)).toBe('Learn [add:modern ]Python basics[del: fast]');
  });

  it('keeps the before text from same+del and the after text from same+add', () => {
    const before = 'one two three';
    const after = 'one 2 three four';
    const segs = wordDiff(before, after)!;
    const side = (keep: 'add' | 'del') =>
      segs
        .filter((s) => s.op === 'same' || s.op === keep)
        .map((s) => s.text)
        .join('');
    expect(side('del')).toBe(before);
    expect(side('add')).toBe(after);
  });

  it('does not report a changed line break as a change', () => {
    expect(wordDiff('Intro to\nalgebra', 'Intro to algebra')).toEqual([{ text: 'Intro to algebra', op: 'same' }]);
  });

  it('returns null when the texts are too long to diff cheaply', () => {
    expect(wordDiff('a b c', 'a b d', 4)).toBeNull();
  });

  it('handles empty sides', () => {
    expect(wordDiff('', 'new title')).toEqual([{ text: 'new title', op: 'add' }]);
    expect(wordDiff('old', '')).toEqual([{ text: 'old', op: 'del' }]);
  });
});

describe('formatClock', () => {
  it('formats lesson durations', () => {
    expect(formatClock(0)).toBe('not set');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(3725)).toBe('1:02:05');
  });
});
