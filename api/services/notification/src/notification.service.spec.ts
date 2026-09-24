import { QaDecisionAction, Role } from '@ethiopialearn/contracts';
import { NotificationService } from './notification.service';

type Handler = (payload: unknown) => unknown;

function setup(opts: { courseStatus?: string; userEmail?: string; userName?: string; followers?: object[] } = {}) {
  const inboxRows: Array<Record<string, unknown>> = [];
  const inboxRepo = {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn(async (row: Record<string, unknown>) => {
      inboxRows.push(row);
      return row;
    }),
  };
  const log = { create: jest.fn((row: object) => row), save: jest.fn(async (row: object) => row) };
  const followerQuery: Record<string, jest.Mock> = {};
  Object.assign(followerQuery, { where: jest.fn(() => followerQuery), limit: jest.fn(() => followerQuery), getMany: jest.fn(async () => opts.followers ?? []) });
  const prefs = { findOne: jest.fn().mockResolvedValue(null), createQueryBuilder: jest.fn(() => followerQuery) };
  const email = { send: jest.fn().mockResolvedValue({ message_id: 'm1' }) };
  const bus = { subscribe: jest.fn(), publish: jest.fn().mockResolvedValue(undefined) };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.endsWith('/learners')) return { learner_ids: ['learner-1'] };
      if (path.startsWith('/api/v1/internal/courses/')) {
        if (!opts.courseStatus) throw new Error('down');
        return { status: opts.courseStatus };
      }
      if (path.startsWith('/api/v1/internal/users/')) return { name: opts.userName ?? 'Edu', email: opts.userEmail ?? '' };
      throw new Error(`unexpected GET ${path}`);
    }),
  };
  const service = new NotificationService(log as never, inboxRepo as never, prefs as never, email as never, bus as never, internal as never);
  service.onModuleInit();
  const handlers = new Map<string, Handler>(bus.subscribe.mock.calls.map(([type, fn]) => [type as string, fn as Handler]));
  const emit = async (type: string, payload: unknown) => {
    await handlers.get(type)!(payload);
    // Some handlers fire the inbox write / email without awaiting them.
    await new Promise((resolve) => setImmediate(resolve));
  };
  const emails = () => email.send.mock.calls.map(([m]) => m as { to: string; subject: string; html: string });
  const subscribedTypes = () => [...handlers.keys()];
  return { emit, inboxRows, emails, prefs, internal, subscribedTypes };
}

const diffSummary = {
  fields_changed: ['title'],
  sections_added: 0,
  sections_removed: 0,
  sections_changed: 0,
  lessons_added: 2,
  lessons_removed: 0,
  lessons_changed: 1,
  videos_replaced: 1,
  price_from: null,
  price_to: null,
  pricing_type_from: null,
  pricing_type_to: null,
  new_free_preview_section: false,
  knowledge_added: 0,
  assessments_added: 0,
};

const reviewed = (action: 'approve' | 'coach' | 'reject', patch: Record<string, unknown> = {}) => ({
  course_id: 'c1',
  revision_id: 'r1',
  review_item_id: 'i1',
  action,
  notes: action === 'approve' ? null : 'Fix the audio in lesson 2',
  qo_id: 'qo1',
  owner_user_id: 'edu-1',
  owner_email: 'edu@e.et',
  course_title: 'Intro to Amharic',
  ...patch,
});

/** Nothing about a revision may look like a first publish. */
function expectNoPublishMessages(t: ReturnType<typeof setup>) {
  for (const row of t.inboxRows) {
    expect(String(row.title)).not.toMatch(/course is live/i);
    expect(['course_approved', 'course_published', 'new_course']).not.toContain(row.type);
  }
  for (const m of t.emails()) expect(`${m.subject} ${m.html}`).not.toMatch(/course is live|🎉/i);
  expect(t.prefs.createQueryBuilder).not.toHaveBeenCalled(); // follower fan-out
}

describe('NotificationService: revision submitted', () => {
  it('puts a "Course update to review" item in the quality officers’ inbox, without email', async () => {
    const t = setup();
    await t.emit('CourseRevisionSubmitted', {
      course_id: 'c1',
      revision_id: 'r1',
      course_title: 'Intro to Amharic',
      diff_summary: diffSummary,
      changed_text: 'New title',
      changelog_summary: null,
      major: false,
    });
    expect(t.inboxRows).toEqual([
      expect.objectContaining({
        user_id: null,
        target_role: Role.QUALITY_OFFICER,
        title: 'Course update to review',
        body: 'Intro to Amharic: 4 changes — +2 lessons · 1 lesson edited · 1 video replaced · title edited',
        link: '/qa',
      }),
    ]);
    expect(t.emails()).toHaveLength(0);
  });
});

describe('NotificationService: revision reviewed', () => {
  it('approve: sends the educator nothing yet (the course service may not be able to apply it)', async () => {
    const t = setup({ userEmail: 'looked-up@e.et' });
    await t.emit('CourseRevisionReviewed', reviewed('approve'));
    expect(t.inboxRows).toEqual([]);
    expect(t.emails()).toEqual([]);
  });

  it('coach: says the update needs another look, includes the notes and says the staged changes are kept', async () => {
    const t = setup();
    await t.emit('CourseRevisionReviewed', reviewed('coach'));
    const [row] = t.inboxRows;
    expect(row).toEqual(expect.objectContaining({ user_id: 'edu-1', type: 'revision_coached', title: "Your update to 'Intro to Amharic' needs another look" }));
    expect(row.body).toContain('Fix the audio in lesson 2');
    expect(row.body).toMatch(/changes are kept/);
    const [mail] = t.emails();
    expect(mail.subject).toBe("Your update to 'Intro to Amharic' needs another look");
    expect(mail.html).toContain('Fix the audio in lesson 2');
    expect(mail.html).toMatch(/stays live/);
    expectNoPublishMessages(t);
  });

  it('coach sent by the course service for an approval it could not apply reads correctly', async () => {
    const t = setup();
    const notes = 'Your content changed while it was in review, so the approved version could not be applied. Check your changes and submit again.';
    await t.emit('CourseRevisionReviewed', reviewed('coach', { notes }));
    const [mail] = t.emails();
    expect(mail.html).toContain('were sent back to you before going live');
    expect(mail.html).toContain(notes);
    expect(mail.html).not.toMatch(/is live|asked for some edits/);
    expect(t.inboxRows).toHaveLength(1);
  });

  it('reject: says nothing until the course service has actually discarded the update', async () => {
    const t = setup();
    await t.emit('CourseRevisionReviewed', reviewed('reject'));
    expect(t.inboxRows).toEqual([]);
    expect(t.emails()).toEqual([]);
  });

  it('rejected (closed): says the update was not approved, with the notes, and that the live course is unchanged', async () => {
    const t = setup();
    await t.emit('CourseRevisionClosed', closed('rejected', { course_title: 'Intro to Amharic', notes: 'Fix the audio in lesson 2' }));
    const [row] = t.inboxRows;
    expect(row).toEqual(expect.objectContaining({ type: 'revision_rejected', title: "Your update to 'Intro to Amharic' was not approved" }));
    expect(row.body).toContain('Fix the audio in lesson 2');
    const [mail] = t.emails();
    expect(mail.subject).toBe("Your update to 'Intro to Amharic' was not approved");
    expect(mail.html).toMatch(/discarded/);
    expect(mail.html).toMatch(/stays live/);
    expectNoPublishMessages(t);
  });

  it('looks up the educator’s email when the event has none', async () => {
    const t = setup({ userEmail: 'looked-up@e.et' });
    await t.emit('CourseRevisionReviewed', reviewed('coach', { owner_email: '' }));
    expect(t.emails()).toEqual([expect.objectContaining({ to: 'looked-up@e.et' })]);
  });

  it('escapes the course title and reviewer notes in the email', async () => {
    const t = setup();
    await t.emit('CourseRevisionClosed', closed('rejected', { course_title: '<img src=x onerror=alert(1)>', notes: '<script>x</script>' }));
    const [mail] = t.emails();
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;script&gt;');
  });
});

const closed = (outcome: 'applied' | 'rejected' | 'discarded', patch: Record<string, unknown> = {}) => ({
  course_id: 'c1',
  revision_id: 'r1',
  outcome,
  submitted_at: '2026-09-01T00:00:00.000Z',
  added_lesson_ids: [],
  removed_lesson_ids: [],
  replaced_video_lesson_ids: [],
  changelog_summary: null,
  major: false,
  owner_user_id: 'edu-1',
  owner_email: 'edu@e.et',
  course_title: 'Amharic for Beginners',
  notes: null,
  assessment_ids: [],
  closed_at: '2026-09-02T00:00:00.000Z',
  ...patch,
});

describe('NotificationService: revision closed', () => {
  it('applied: tells the educator the update is live under the post-apply title, in the inbox and by email', async () => {
    const t = setup();
    await t.emit('CourseRevisionClosed', closed('applied', { notes: 'Nice captions' }));
    expect(t.inboxRows).toEqual([
      expect.objectContaining({ user_id: 'edu-1', type: 'revision_approved', title: "Your update to 'Amharic for Beginners' is live", link: '/teach/courses/c1' }),
    ]);
    expect(t.inboxRows[0].body).toContain('Nice captions');
    expect(t.emails()).toEqual([expect.objectContaining({ to: 'edu@e.et', subject: "Your update to 'Amharic for Beginners' is live" })]);
    expect(t.emails()[0].html).toContain('/teach/courses/c1');
    expect(t.emails()[0].html).toContain('Nice captions');
    expectNoPublishMessages(t);
  });

  it('applied: looks up the educator’s email when the event has none', async () => {
    const t = setup({ userEmail: 'looked-up@e.et' });
    await t.emit('CourseRevisionClosed', closed('applied', { owner_email: '' }));
    expect(t.emails()).toEqual([expect.objectContaining({ to: 'looked-up@e.et' })]);
  });

  it('discarded: sends nothing (the educator discarded it themselves)', async () => {
    const t = setup({ userEmail: 'looked-up@e.et' });
    await t.emit('CourseRevisionClosed', closed('discarded', { notes: 'Off topic' }));
    expect(t.inboxRows).toEqual([]);
    expect(t.emails()).toEqual([]);
  });

  it('a QO reject followed by the course service closing the revision reaches the educator once', async () => {
    const t = setup();
    await t.emit('CourseRevisionReviewed', reviewed('reject'));
    await t.emit('CourseRevisionClosed', closed('rejected', { notes: 'Fix the audio in lesson 2' }));
    expect(t.inboxRows).toHaveLength(1);
    expect(t.emails()).toHaveLength(1);
  });

  it('a QO approve followed by the apply reaches the educator once, from the apply', async () => {
    const t = setup();
    await t.emit('CourseRevisionReviewed', reviewed('approve'));
    await t.emit('CourseRevisionClosed', closed('applied'));
    expect(t.inboxRows.map((r) => r.type)).toEqual(['revision_approved']);
    expect(t.emails()).toHaveLength(1);
  });
});

describe('NotificationService: institution review of a revision', () => {
  it('asks the institution admin to review an instructor update', async () => {
    const t = setup();
    await t.emit('CourseSubmittedToInstitution', {
      course_id: 'c1',
      course_title: 'Intro to Amharic',
      institution_admin_user_id: 'inst-admin',
      instructor_name: 'Abebe',
      revision_id: 'r1',
    });
    expect(t.inboxRows).toEqual([
      expect.objectContaining({ user_id: 'inst-admin', title: 'Instructor update to review', link: '/institution/review' }),
    ]);
  });

  it('keeps the first-submission wording when there is no revision', async () => {
    const t = setup();
    await t.emit('CourseSubmittedToInstitution', {
      course_id: 'c1',
      course_title: 'Intro to Amharic',
      institution_admin_user_id: 'inst-admin',
      instructor_name: 'Abebe',
    });
    expect(t.inboxRows).toEqual([expect.objectContaining({ title: 'Instructor course to review' })]);
  });

  it('tells the instructor their update, not their course, was sent back', async () => {
    const t = setup();
    await t.emit('CourseInstitutionReviewed', {
      course_id: 'c1',
      course_title: 'Intro to Amharic',
      owner_user_id: 'edu-1',
      action: 'reject',
      notes: 'Add captions',
      revision_id: 'r1',
    });
    const [row] = t.inboxRows;
    expect(row.title).toBe('Institution sent your update back');
    expect(row.body).toContain('Add captions');
    expect(row.body).toMatch(/live course is unchanged/);
  });
});

describe('NotificationService: coaching a live course (post-publish re-review)', () => {
  const coach = {
    course_id: 'c1',
    action: QaDecisionAction.COACH,
    notes: 'Ratings mention poor audio',
    qo_id: 'qo1',
    owner_user_id: 'edu-1',
    owner_email: 'edu@e.et',
    course_title: 'Intro to Amharic',
  };

  it('does not tell the educator a live course went back to draft', async () => {
    const t = setup({ courseStatus: 'published' });
    await t.emit('CourseReviewed', coach);
    expect(t.inboxRows).toEqual([expect.objectContaining({ title: 'Feedback on your live course' })]);
    const [mail] = t.emails();
    expect(mail.html).toContain('Ratings mention poor audio');
    expect(mail.html).not.toMatch(/back in draft/);
  });

  it('keeps the back-to-draft wording for a first submission', async () => {
    const t = setup({ courseStatus: 'submitted' });
    await t.emit('CourseReviewed', coach);
    expect(t.inboxRows).toEqual([expect.objectContaining({ title: 'Feedback on your course' })]);
    expect(t.emails()[0].html).toMatch(/back in draft/);
  });

  it('falls back to the first-submission wording when the course service is unreachable', async () => {
    const t = setup();
    await t.emit('CourseReviewed', coach);
    expect(t.inboxRows).toEqual([expect.objectContaining({ title: 'Feedback on your course' })]);
  });
});

describe('NotificationService: approving a course that was already reviewed', () => {
  const approve = (kind?: string) => ({
    course_id: 'c1',
    action: QaDecisionAction.APPROVE,
    notes: null,
    qo_id: 'qo1',
    owner_user_id: 'edu-1',
    owner_email: 'edu@e.et',
    course_title: 'Intro to Amharic',
    ...(kind ? { kind } : {}),
  });

  it('post-publish re-check: says the course passed, not that it just went live', async () => {
    const t = setup({ courseStatus: 'unlisted' });
    await t.emit('CourseReviewed', approve('post_publish'));
    expect(t.inboxRows).toEqual([expect.objectContaining({ user_id: 'edu-1', type: 'course_recheck_passed', title: 'Your course passed its quality re-check' })]);
    const [mail] = t.emails();
    expect(mail.subject).toBe('Your course passed its quality re-check');
    expect(mail.html).not.toMatch(/discoverable|course is live|🎉/);
    expectNoPublishMessages(t);
  });

  it('appeal: says the appeal was accepted, without the first-publish celebration', async () => {
    const t = setup({ courseStatus: 'published' });
    await t.emit('CourseReviewed', approve('appeal'));
    expect(t.inboxRows).toEqual([expect.objectContaining({ type: 'course_appeal_accepted', title: 'Your appeal was accepted' })]);
    expect(t.emails()).toEqual([expect.objectContaining({ subject: 'Your appeal was accepted' })]);
    expectNoPublishMessages(t);
  });

  it.each([['new_course'], [undefined]])('first submission (kind %s): keeps "Your course is live! 🎉"', async (kind) => {
    const t = setup();
    await t.emit('CourseReviewed', approve(kind));
    expect(t.inboxRows).toEqual([expect.objectContaining({ type: 'course_approved', title: 'Your course is live! 🎉' })]);
    expect(t.emails()).toEqual([expect.objectContaining({ subject: 'Your course is live!' })]);
    // Follower fan-out belongs to CoursePublished, never to the review decision.
    expect(t.prefs.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('coach on a post-publish item uses the live wording without asking the course service', async () => {
    const t = setup(); // course service unreachable
    await t.emit('CourseReviewed', { ...approve('post_publish'), action: QaDecisionAction.COACH, notes: 'Audio is quiet' });
    expect(t.inboxRows).toEqual([expect.objectContaining({ title: 'Feedback on your live course' })]);
    expect(t.internal.get).not.toHaveBeenCalled();
  });

  it('coach on a first submission says "back in draft" even if the course status read races the decision', async () => {
    const t = setup({ courseStatus: 'published' });
    await t.emit('CourseReviewed', { ...approve('new_course'), action: QaDecisionAction.COACH, notes: 'Add a summary' });
    expect(t.inboxRows).toEqual([expect.objectContaining({ title: 'Feedback on your course' })]);
    expect(t.emails()[0].html).toMatch(/back in draft/);
  });
});

/**
 * Every email body is HTML and nearly every value in it is user text. Feed each
 * subscribed event a payload whose every field is markup, and check that no
 * email contains it unescaped. The proxy answers any field name, so a new
 * template is covered without changing this test.
 */
describe('NotificationService: user text is escaped in every email', () => {
  const EVIL = '<script>alert(1)</script><img src=x onerror=alert(2)><a href="https://evil.example">x</a>';

  /** A payload whose every field is EVIL, except the ones given (to reach specific branches). */
  const poisoned = (overrides: Record<string, unknown> = {}) =>
    new Proxy(overrides, {
      get: (target, key) => (typeof key !== 'string' ? undefined : key in target ? target[key] : EVIL),
      has: () => true,
    });

  // Branches that a field value selects; every other handler runs with the plain poisoned payload.
  const variants: Record<string, Array<Record<string, unknown>>> = {
    CourseReviewed: [
      { action: 'approve' },
      { action: 'approve', kind: 'post_publish' },
      { action: 'approve', kind: 'appeal' },
      { action: 'coach', kind: 'post_publish' },
      { action: 'coach', kind: 'new_course' },
      { action: 'flag' },
    ],
    CourseRevisionReviewed: [{ action: 'coach' }],
    CourseRevisionClosed: [{ outcome: 'applied' }, { outcome: 'rejected' }],
    InstructorLinked: [{ upgraded_from_learner: true }, { upgraded_from_learner: false }],
    SponsorshipGranted: [{ source: 'bulk' }, { source: 'gift' }],
    SponsorshipInvited: [{ source: 'bulk' }],
    ReferralInviteSent: [{ existing_user: true }, { existing_user: false }],
    CourseProgressMilestone: [{ percent: 50 }, { percent: 75 }],
    LearnerInactive: [{ channel: 'email' }],
    EnrollmentCreated: [{ educator_name: EVIL }, { educator_name: '' }],
  };

  it('never puts user text into an email as markup', async () => {
    const t = setup({
      courseStatus: 'published',
      userEmail: 'someone@e.et',
      userName: EVIL,
      followers: [{ user_id: 'follower-1', new_course_categories: [], new_course_instructor_ids: [EVIL] }],
    });
    const covered: string[] = [];
    for (const type of t.subscribedTypes()) {
      for (const overrides of variants[type] ?? [{}]) {
        const before = t.emails().length;
        await t.emit(type, poisoned(overrides));
        const sent = t.emails().slice(before);
        if (sent.length) covered.push(type);
        for (const mail of sent) {
          expect([type, mail.html]).not.toEqual([type, expect.stringMatching(/<script|<img|<a href="https:\/\/evil/)]);
          // The text is still there, escaped, so the recipient sees what was written.
          expect([type, mail.html]).toEqual([type, expect.stringContaining('&lt;script&gt;')]);
        }
      }
    }
    // Guard against the sweep silently testing nothing.
    expect(new Set(covered)).toEqual(
      new Set([
        'UserRegistered', 'PasswordResetRequested', 'StaffInvited', 'InstructorLinked', 'CourseReviewed', 'CourseRevisionReviewed',
        'CourseRevisionClosed', 'CoursePublished', 'PaymentConfirmed', 'PaymentFailed', 'EnrollmentCreated', 'CertificateIssued',
        'PayoutCompleted', 'FraudFlagRaised', 'FraudFlagResolved', 'RefundRequested', 'RefundApproved', 'RefundDenied',
        'CourseCompleted', 'AssessmentFailed', 'SponsorshipGranted', 'SponsorshipInvited', 'PayRequestCreated', 'ReferralInviteSent',
        'PaymentAbandoned', 'BulkPurchaseActivated', 'CourseUpdated', 'CourseProgressMilestone', 'LearnerInactive', 'CourseUnlisted',
      ]),
    );
  });

  it('escapes the learner "course updated" email built from the educator’s change summary', async () => {
    const t = setup({ userEmail: 'learner@e.et', userName: 'Abebe' });
    await t.emit('CourseUpdated', {
      course_id: 'c1',
      course_title: 'Intro <b>Go</b>',
      owner_user_id: 'edu-1',
      summary: 'New lessons! <a href="https://evil.example/claim">Claim your certificate</a><img src="https://tracker.example/p.gif">',
      changelog_id: 'cl1',
    });
    const [mail] = t.emails();
    expect(mail.html).not.toMatch(/<a href="https:\/\/evil|<img|<b>Go/);
    expect(mail.html).toContain('&lt;a href=&quot;https://evil.example/claim&quot;&gt;Claim your certificate&lt;/a&gt;');
    // The platform's own button is still a real link.
    expect(mail.html).toMatch(/<a href="http:\/\/localhost:3000\/learn\/c1\?changelog=1"/);
  });
});
