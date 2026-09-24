import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { AssessmentType, CourseRevisionClosedPayload, EventEnvelope, Role } from '@ethiopialearn/contracts';
import { AssessmentService } from './assessment.service';
import { CertificateService } from './certificate.service';

/**
 * Assessments on an approved course are staged ('pending') until the course's
 * revision is reviewed: hidden from learners, not startable, never counted for
 * certificates, then made live or dropped by CourseRevisionClosed. Also covers
 * the institution-admin authz fix and project-submission key hardening.
 */
type Row = Record<string, any>;

/** Equality match, plus the FindOperators the service uses. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value instanceof FindOperator) {
      if (value.type === 'lessThanOrEqual') return row[key] <= value.value;
      if (value.type === 'in') return (value.value as unknown as unknown[]).includes(row[key]);
      throw new Error(`fake repo: unsupported operator ${value.type}`);
    }
    return row[key] === value;
  });
}

function fakeRepo(rows: Row[]) {
  return {
    rows,
    find: jest.fn(async ({ where }: { where: Row }) => rows.filter((r) => matches(r, where))),
    findOne: jest.fn(async ({ where }: { where: Row }) => rows.find((r) => matches(r, where)) ?? null),
    create: jest.fn((r: Row) => ({ ...r })),
    save: jest.fn(async (r: Row) => {
      if (!r.id) {
        Object.assign(r, { id: `as-${rows.length + 1}`, created_at: new Date() });
        rows.push(r);
      }
      return r;
    }),
    update: jest.fn(async (where: Row, patch: Row) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, patch));
      return { affected: hit.length };
    }),
    delete: jest.fn(async (where: Row) => {
      const keep = rows.filter((r) => !matches(r, where));
      const affected = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { affected };
    }),
  };
}

const INSTITUTION_COURSE = {
  id: 'c1',
  title: 'Soil Science',
  owner_id: 'inst1',
  owner_type: 'institution',
  created_by: 'edu1',
  institution_id: 'inst1',
  status: 'published',
};

/** institutions: institution-admin user id → the institution they own (absent = 404). */
function internalFor(course: Row, institutions: Record<string, string> = {}) {
  return {
    get: jest.fn(async (path: string) => {
      const byOwner = path.match(/\/internal\/institutions\/by-owner\/(.+)$/);
      if (byOwner) {
        const id = institutions[byOwner[1]];
        if (!id) throw new Error(`Internal request failed: GET ${path} -> 404`);
        return { id, name: 'Institution' };
      }
      if (path.startsWith('/api/v1/internal/entitlements')) return { entitlement_status: 'active', enrollment_id: 'en1' };
      if (path.startsWith('/api/v1/internal/courses/')) return course;
      throw new Error(`unexpected internal GET ${path}`);
    }),
  };
}

function harness(opts: { course?: Row; rows?: Row[]; attempts?: Row[]; institutions?: Record<string, string> } = {}) {
  const assessments = fakeRepo(opts.rows ?? []);
  const attempts = fakeRepo(opts.attempts ?? []);
  const internal = internalFor(opts.course ?? INSTITUTION_COURSE, opts.institutions ?? { ia1: 'inst1', ia2: 'inst2' });
  const bus = { publish: jest.fn(), subscribe: jest.fn() };
  const storage = { getSignedUploadUrl: jest.fn(async () => ({ url: 'https://r2/put' })) };
  const svc = new AssessmentService(assessments as never, attempts as never, bus as never, internal as never, storage as never);
  return { svc, assessments, attempts, internal, bus };
}

const user = (id: string, role: Role) => ({ id, role, email: `${id}@x.et` });
const instructor = user('edu1', Role.EDUCATOR);
const otherEducator = user('edu9', Role.EDUCATOR);
const institutionAdmin = user('ia1', Role.INSTITUTION_ADMIN);
const otherInstitutionAdmin = user('ia2', Role.INSTITUTION_ADMIN);
const adminWithoutInstitution = user('ia3', Role.INSTITUTION_ADMIN);
const qualityOfficer = user('qo1', Role.QUALITY_OFFICER);
const learner = user('l1', Role.LEARNER);

const quizDto = {
  course_id: 'c1',
  type: AssessmentType.QUIZ,
  config: { questions: [{ prompt: 'Best pH for teff?', options: ['4', '6.5'], correct_index: 1 }] },
};

describe('create(): staging on approved courses', () => {
  it.each([
    ['published', 'pending'],
    ['unlisted', 'pending'],
    ['draft', 'live'],
  ])('a course that is %s gets a %s assessment', async (status, state) => {
    const { svc, assessments } = harness({ course: { ...INSTITUTION_COURSE, status } });
    const saved: any = await svc.create(instructor, quizDto);
    expect(saved.state).toBe(state);
    expect(assessments.rows).toHaveLength(1);
  });
});

describe('create()/generateQuiz(): who may manage a course’s assessments', () => {
  it('allows the admin of the institution that owns the course', async () => {
    const { svc } = harness();
    await expect(svc.create(institutionAdmin, quizDto)).resolves.toMatchObject({ course_id: 'c1' });
  });

  it('matches the institution through owner_id when institution_id is not provided', async () => {
    const { svc } = harness({ course: { ...INSTITUTION_COURSE, institution_id: undefined } });
    await expect(svc.create(institutionAdmin, quizDto)).resolves.toMatchObject({ course_id: 'c1' });
  });

  it('allows the instructor who created an institution course', async () => {
    const { svc } = harness();
    await expect(svc.create(instructor, quizDto)).resolves.toMatchObject({ course_id: 'c1' });
  });

  it('refuses another institution’s admin, an admin without an institution and an unrelated educator', async () => {
    const { svc, assessments } = harness();
    for (const ctx of [otherInstitutionAdmin, adminWithoutInstitution, otherEducator]) {
      await expect(svc.create(ctx, quizDto)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(assessments.save).not.toHaveBeenCalled();
  });

  it('refuses another institution’s admin on AI quiz generation', async () => {
    const { svc } = harness();
    await expect(svc.generateQuiz(otherInstitutionAdmin, 'c1', 'soil', 3)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses another institution’s admin on the exam-results view; quality officers keep access', async () => {
    const { svc } = harness();
    await expect(svc.courseAttempts(otherInstitutionAdmin, 'c1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.courseAttempts(qualityOfficer, 'c1')).resolves.toEqual([]);
  });
});

describe('listForCourse(): pending assessments stay out of learner views', () => {
  const rows = () => [
    { id: 'live1', course_id: 'c1', type: AssessmentType.QUIZ, is_required: true, pass_score: 60, config: { questions: [{}] }, state: 'live' },
    { id: 'pend1', course_id: 'c1', type: AssessmentType.QUIZ, is_required: true, pass_score: 60, config: { questions: [{}, {}] }, state: 'pending' },
  ];
  const ids = (list: { id: string }[]) => list.map((a) => a.id);

  it('learners see live assessments only, even when they ask for pending ones', async () => {
    const { svc } = harness({ rows: rows() });
    expect(ids(await svc.listForCourse(learner, 'c1'))).toEqual(['live1']);
    expect(ids(await svc.listForCourse(learner, 'c1', true))).toEqual(['live1']);
  });

  it('the instructor sees pending ones only with include_pending, each row carrying its state', async () => {
    const { svc } = harness({ rows: rows() });
    expect(ids(await svc.listForCourse(instructor, 'c1'))).toEqual(['live1']);
    const all = await svc.listForCourse(instructor, 'c1', true);
    expect(all.map((a) => [a.id, a.state])).toEqual([
      ['live1', 'live'],
      ['pend1', 'pending'],
    ]);
  });

  it('quality officers see pending ones without a course lookup; other institutions’ admins do not', async () => {
    const qo = harness({ rows: rows() });
    expect(ids(await qo.svc.listForCourse(qualityOfficer, 'c1', true))).toEqual(['live1', 'pend1']);
    expect(qo.internal.get).not.toHaveBeenCalled();

    const other = harness({ rows: rows() });
    expect(ids(await other.svc.listForCourse(otherInstitutionAdmin, 'c1', true))).toEqual(['live1']);
  });

  it('skips the authz lookup when nothing is pending, and requires course_id', async () => {
    const { svc, internal } = harness({ rows: [rows()[0]] });
    expect(ids(await svc.listForCourse(learner, 'c1', true))).toEqual(['live1']);
    expect(internal.get).not.toHaveBeenCalled();
    await expect(svc.listForCourse(learner, '')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('startAttempt(): a pending assessment cannot be started', () => {
  it('404s before any entitlement lookup or attempt is created', async () => {
    const { svc, internal, attempts } = harness({
      rows: [{ id: 'pend1', course_id: 'c1', type: AssessmentType.QUIZ, config: { questions: [] }, state: 'pending' }],
    });
    const err = await svc.startAttempt(learner, 'pend1').catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe('Assessment not available yet');
    expect(internal.get).not.toHaveBeenCalled();
    expect(attempts.save).not.toHaveBeenCalled();
  });
});

describe('certificates ignore pending assessments', () => {
  function certificates(rows: Row[], attempts: Row[]) {
    const repo = fakeRepo(rows);
    const attemptRepo = fakeRepo(attempts);
    const noop = { findOne: jest.fn(), find: jest.fn() };
    return new CertificateService(noop as never, repo as never, attemptRepo as never, noop as never, { subscribe: jest.fn() } as never, {} as never, {} as never);
  }

  it('a required pending assessment does not block the certificate; a required live one still does', async () => {
    const rows = [
      { id: 'live1', course_id: 'c1', type: AssessmentType.QUIZ, is_required: true, state: 'live' },
      { id: 'pend1', course_id: 'c1', type: AssessmentType.PROJECT, is_required: true, state: 'pending' },
    ];
    const passedLive = [{ id: 't1', assessment_id: 'live1', learner_id: 'l1', passed: true }];
    expect(await certificates(rows, passedLive).allRequiredAssessmentsPassed('c1', 'l1')).toBe(true);
    expect(await certificates(rows, []).allRequiredAssessmentsPassed('c1', 'l1')).toBe(false);
  });

  it('badges only count live assessments', async () => {
    const rows = [
      { id: 'live1', course_id: 'c1', type: AssessmentType.QUIZ, is_required: true, state: 'live' },
      { id: 'pend1', course_id: 'c1', type: AssessmentType.AI_VIVA, is_required: false, state: 'pending' },
    ];
    const passed = [
      { id: 't1', assessment_id: 'live1', learner_id: 'l1', passed: true },
      { id: 't2', assessment_id: 'pend1', learner_id: 'l1', passed: true },
    ];
    const svc = certificates(rows, passed) as unknown as { passedAssessmentTypes: (c: string, l: string) => Promise<string[]> };
    expect(await svc.passedAssessmentTypes('c1', 'l1')).toEqual([AssessmentType.QUIZ]);
  });
});

describe('CourseRevisionClosed', () => {
  /** Assessment ids are uuids in production; the handler skips anything else. */
  const ID = {
    liveOld: '00000000-0000-4000-8000-000000000001',
    reviewed: '00000000-0000-4000-8000-000000000002',
    unseen: '00000000-0000-4000-8000-000000000003',
    afterSubmit: '00000000-0000-4000-8000-000000000004',
    afterDiscard: '00000000-0000-4000-8000-000000000005',
    otherCourse: '00000000-0000-4000-8000-000000000006',
  };
  const SUBMITTED = '2026-09-02T00:00:00.000Z';
  const CLOSED = '2026-09-04T00:00:00.000Z';
  const closed = (
    outcome: CourseRevisionClosedPayload['outcome'],
    extra: Partial<CourseRevisionClosedPayload> = {},
  ): CourseRevisionClosedPayload => ({
    course_id: 'c1',
    revision_id: 'r1',
    outcome,
    submitted_at: outcome === 'discarded' ? null : SUBMITTED,
    added_lesson_ids: [],
    removed_lesson_ids: [],
    replaced_video_lesson_ids: [],
    changelog_summary: null,
    major: false,
    owner_user_id: 'edu1',
    owner_email: 'edu1@x.et',
    course_title: 'Soil Science',
    notes: null,
    // What the quality officer was shown at submit.
    assessment_ids: outcome === 'discarded' ? [] : [ID.reviewed],
    closed_at: CLOSED,
    ...extra,
  });
  /** An event from a course service deployed before assessment_ids / closed_at existed. */
  const legacy = (outcome: CourseRevisionClosedPayload['outcome'], submitted_at: string | null) => {
    const { assessment_ids: _ids, closed_at: _closedAt, ...rest } = closed(outcome, { submitted_at });
    return rest as CourseRevisionClosedPayload;
  };
  const envelope = (timestamp: string) =>
    ({ metadata: { event_id: 'e1', timestamp, producer_service: 'course', correlation_id: 'x' } }) as EventEnvelope<CourseRevisionClosedPayload>;
  const rows = () => [
    { id: ID.liveOld, name: 'live-old', course_id: 'c1', state: 'live', created_at: new Date('2026-08-01T00:00:00Z') },
    { id: ID.reviewed, name: 'reviewed', course_id: 'c1', state: 'pending', created_at: new Date('2026-09-01T00:00:00Z') },
    // Created before submit but missing from the reviewer's diff (outcomes was unreachable when it was built).
    { id: ID.unseen, name: 'unseen', course_id: 'c1', state: 'pending', created_at: new Date('2026-09-01T12:00:00Z') },
    { id: ID.afterSubmit, name: 'after-submit', course_id: 'c1', state: 'pending', created_at: new Date('2026-09-03T00:00:00Z') },
    { id: ID.afterDiscard, name: 'after-discard', course_id: 'c1', state: 'pending', created_at: new Date('2026-09-05T00:00:00Z') },
    { id: ID.otherCourse, name: 'other-course', course_id: 'c2', state: 'pending', created_at: new Date('2026-09-01T00:00:00Z') },
  ];
  const UNTOUCHED = {
    'live-old': 'live',
    reviewed: 'pending',
    unseen: 'pending',
    'after-submit': 'pending',
    'after-discard': 'pending',
    'other-course': 'pending',
  };
  const states = (repo: { rows: Row[] }) => Object.fromEntries(repo.rows.map((r) => [r.name, r.state]));

  it('is subscribed on module init and passes the envelope through', async () => {
    const { svc, bus, assessments } = harness({ rows: rows() });
    svc.onModuleInit();
    expect(bus.subscribe).toHaveBeenCalledWith('CourseRevisionClosed', expect.any(Function));
    const handler = bus.subscribe.mock.calls[0][1];
    await handler(closed('applied'), envelope(CLOSED));
    expect(states(assessments).reviewed).toBe('live');
    // A legacy discard falls back to the envelope time, so the envelope must reach the handler.
    await handler(legacy('discarded', null), envelope(CLOSED));
    expect(states(assessments)['after-discard']).toBe('pending');
    expect(states(assessments).unseen).toBeUndefined();
  });

  it('applied: activates exactly the assessments the reviewer was shown, never an unseen one', async () => {
    const { svc, assessments } = harness({ rows: rows() });
    await svc.onRevisionClosed(closed('applied'));
    expect(states(assessments)).toEqual({ ...UNTOUCHED, reviewed: 'live' });
    // Redelivery is harmless.
    await svc.onRevisionClosed(closed('applied'));
    expect(states(assessments)).toEqual({ ...UNTOUCHED, reviewed: 'live' });
  });

  it('applied with no reviewed assessments leaves every pending one pending (the diff showed none)', async () => {
    const { svc, assessments } = harness({ rows: rows() });
    await svc.onRevisionClosed(closed('applied', { assessment_ids: [] }));
    expect(states(assessments)).toEqual(UNTOUCHED);
    expect(assessments.update).not.toHaveBeenCalled();
  });

  it('only touches ids that are still pending on that course', async () => {
    const { svc, assessments } = harness({ rows: rows() });
    await svc.onRevisionClosed(closed('rejected', { assessment_ids: [ID.reviewed, ID.otherCourse, ID.liveOld] }));
    expect(states(assessments)).toEqual({ ...UNTOUCHED, reviewed: undefined });
    expect(assessments.rows.map((r) => r.name)).not.toContain('reviewed');
  });

  it('skips malformed ids instead of failing the whole batch', async () => {
    const { svc, assessments } = harness({ rows: rows() });
    await svc.onRevisionClosed(closed('applied', { assessment_ids: ['not-a-uuid', 42 as never, ID.reviewed, ID.reviewed] }));
    expect(states(assessments)).toEqual({ ...UNTOUCHED, reviewed: 'live' });
    expect(assessments.update).toHaveBeenCalledTimes(1);
  });

  it('rejected: deletes exactly the reviewed assessments and keeps every other pending one', async () => {
    const { svc, assessments } = harness({ rows: rows() });
    await svc.onRevisionClosed(closed('rejected'));
    const { reviewed: _gone, ...rest } = UNTOUCHED;
    expect(states(assessments)).toEqual(rest);
  });

  it('discarded: deletes pending assessments created up to the discard, never later ones or live ones', async () => {
    const { svc, assessments } = harness({ rows: rows() });
    await svc.onRevisionClosed(closed('discarded'));
    expect(states(assessments)).toEqual({ 'live-old': 'live', 'after-discard': 'pending', 'other-course': 'pending' });
  });

  it('discarded without closed_at (legacy event) uses the event publish time as the cutoff', async () => {
    const { svc, assessments } = harness({ rows: rows() });
    await svc.onRevisionClosed(legacy('discarded', null), envelope(CLOSED));
    expect(states(assessments)).toEqual({ 'live-old': 'live', 'after-discard': 'pending', 'other-course': 'pending' });
  });

  it('discarded with no usable time at all deletes nothing (cannot tell older from newer)', async () => {
    const { svc, assessments } = harness({ rows: rows() });
    await svc.onRevisionClosed(legacy('discarded', null));
    await svc.onRevisionClosed(closed('discarded', { closed_at: 'not-a-date' }));
    expect(states(assessments)).toEqual(UNTOUCHED);
    expect(assessments.delete).not.toHaveBeenCalled();
  });

  it('legacy applied/rejected (no assessment_ids) fall back to the submit-time cutoff', async () => {
    const applied = harness({ rows: rows() });
    await applied.svc.onRevisionClosed(legacy('applied', SUBMITTED));
    expect(states(applied.assessments)).toEqual({ ...UNTOUCHED, reviewed: 'live', unseen: 'live' });

    const rejected = harness({ rows: rows() });
    await rejected.svc.onRevisionClosed(legacy('rejected', SUBMITTED));
    expect(states(rejected.assessments)).toEqual({ 'live-old': 'live', 'after-submit': 'pending', 'after-discard': 'pending', 'other-course': 'pending' });
  });

  it('legacy applied/rejected without a submit time change nothing (cannot tell reviewed from unreviewed)', async () => {
    const { svc, assessments } = harness({ rows: rows() });
    await svc.onRevisionClosed(legacy('applied', null));
    await svc.onRevisionClosed(legacy('rejected', 'not-a-date'));
    expect(states(assessments)).toEqual(UNTOUCHED);
  });

  it('retries a transient database failure (the bus acks even when a handler throws)', async () => {
    jest.useFakeTimers();
    try {
      const { svc, assessments } = harness({ rows: rows() });
      const realUpdate = assessments.update.getMockImplementation()!;
      assessments.update.mockRejectedValueOnce(new Error('connection reset')).mockImplementation(realUpdate);
      const done = svc.onRevisionClosed(closed('applied'));
      await jest.advanceTimersByTimeAsync(1_000);
      await done;
      expect(assessments.update).toHaveBeenCalledTimes(2);
      expect(states(assessments).reviewed).toBe('live');
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives up after three failed tries', async () => {
    jest.useFakeTimers();
    try {
      const { svc, assessments } = harness({ rows: rows() });
      assessments.delete.mockRejectedValue(new Error('db down'));
      const done = svc.onRevisionClosed(closed('discarded')).catch((e) => e);
      await jest.advanceTimersByTimeAsync(4_000);
      expect((await done).message).toBe('db down');
      expect(assessments.delete).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('pendingForReview() (internal, for the quality officer’s revision diff)', () => {
  it('returns only the course’s pending assessments, with answer keys and marking guidance', async () => {
    const { svc } = harness({
      rows: [
        {
          id: 'pend1',
          course_id: 'c1',
          type: AssessmentType.QUIZ,
          is_required: true,
          pass_score: 70,
          state: 'pending',
          created_at: new Date('2026-09-01T00:00:00Z'),
          config: {
            questions: [
              { kind: 'mcq', prompt: 'Best pH?', options: ['4', '6.5'], correct_index: 1, points: 1 },
              { kind: 'written', prompt: 'Explain liming', guidance: 'Mentions calcium carbonate', points: 2 },
            ],
          },
        },
        { id: 'live1', course_id: 'c1', type: AssessmentType.QUIZ, state: 'live', config: { questions: [] } },
        { id: 'proj', course_id: 'c1', type: AssessmentType.PROJECT, is_required: false, pass_score: 60, state: 'pending', config: { instructions: 'Map a plot' } },
      ],
    });
    const out = await svc.pendingForReview('c1');
    expect(out.map((a) => a.id)).toEqual(['pend1', 'proj']);
    expect(out[0]).toMatchObject({ type: AssessmentType.QUIZ, is_required: true, pass_score: 70, question_count: 2 });
    expect(out[0].questions).toEqual([
      { prompt: 'Best pH?', kind: 'mcq', options: ['4', '6.5'], correct_index: 1, guidance: undefined },
      { prompt: 'Explain liming', kind: 'written', options: undefined, correct_index: undefined, guidance: 'Mentions calcium carbonate' },
    ]);
    expect(out[1]).toMatchObject({ question_count: 0, questions: [], instructions: 'Map a plot' });
  });
});

describe('project submission', () => {
  it('always keeps the upload key issued at start, ignoring a client-supplied file_key', async () => {
    const { svc, attempts } = harness({
      rows: [{ id: 'proj', course_id: 'c1', type: AssessmentType.PROJECT, pass_score: 60, config: {}, state: 'live' }],
      attempts: [{ id: 'att1', assessment_id: 'proj', learner_id: 'l1', submitted_at: null, detail: { file_key: 'projects/l1/own-upload' } }],
    });
    const res = await svc.submitAttempt(learner, 'att1', { file_key: 'projects/someone-else/secret' } as never);
    expect(res.pending_review).toBe(true);
    expect(attempts.rows[0].detail.file_key).toBe('projects/l1/own-upload');
  });
});
