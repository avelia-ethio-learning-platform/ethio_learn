import { RevisionDiffSummary } from '@ethiopialearn/contracts';
import { revisionChangeCount, revisionChips, revisionSubmittedBody } from './revision-messages';

const none: RevisionDiffSummary = {
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
const summary = (patch: Partial<RevisionDiffSummary>): RevisionDiffSummary => ({ ...none, ...patch });

describe('revision message helpers', () => {
  it('labels structure, video and price changes for QA triage', () => {
    const s = summary({
      fields_changed: ['title', 'price_etb', 'thumbnail_url'],
      lessons_added: 2,
      lessons_removed: 1,
      lessons_changed: 3,
      videos_replaced: 1,
      price_from: 400,
      price_to: 500,
      new_free_preview_section: true,
      assessments_added: 1,
      knowledge_added: 2,
    });
    expect(revisionChips(s)).toEqual([
      '+2 lessons',
      '−1 lesson',
      '3 lessons edited',
      '1 video replaced',
      'price 400→500',
      'free preview added',
      '+1 assessment',
      '+2 tutor notes',
      'title, thumbnail edited',
    ]);
  });

  it('shows a pricing-type switch and a price that was cleared', () => {
    const s = summary({ fields_changed: ['pricing_type', 'price_etb'], pricing_type_from: 'paid', pricing_type_to: 'free', price_from: 300, price_to: null });
    expect(revisionChips(s)).toEqual(['pricing paid→free', 'price 300→—']);
  });

  it('counts each change once (a replaced video is already a changed lesson)', () => {
    const s = summary({ fields_changed: ['description'], sections_added: 1, lessons_added: 3, lessons_changed: 2, videos_replaced: 2, assessments_added: 1 });
    expect(revisionChangeCount(s)).toBe(1 + 1 + 3 + 2 + 1);
  });

  it('builds the QO inbox body as "<title>: <n> change(s) — <chips>"', () => {
    expect(revisionSubmittedBody('Intro to Amharic', summary({ lessons_added: 1 }))).toBe('Intro to Amharic: 1 change — +1 lesson');
    expect(revisionSubmittedBody('Intro to Amharic', summary({ lessons_changed: 2, videos_replaced: 1 }))).toBe(
      'Intro to Amharic: 2 changes — 2 lessons edited · 1 video replaced',
    );
  });

  it('still builds a body when the summary is missing or partial', () => {
    expect(revisionSubmittedBody('Course', undefined)).toBe('Course: 0 changes');
    expect(revisionSubmittedBody('Course', { lessons_added: 2 })).toBe('Course: 2 changes — +2 lessons');
  });
});
