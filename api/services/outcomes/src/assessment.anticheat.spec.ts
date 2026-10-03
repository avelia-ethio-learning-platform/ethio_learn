import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { AssessmentType, Role } from '@ethiopialearn/contracts';
import { AssessmentService } from './assessment.service';

/**
 * Anti-cheat behaviour of quizzes: per-attempt paper (subset + shuffle) that
 * still grades correctly, attempt limits, resume-not-restart, server clock.
 */
const learner = { id: 'l1', role: Role.LEARNER, email: 'l@x.et' };

function bankOf(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'mcq',
    prompt: `Q${i}`,
    options: [`A${i}`, `B${i}`, `C${i}`, `D${i}`],
    correct_index: i % 4,
    points: 1,
  }));
}

function harness(config: Record<string, unknown>, priorAttempts: Record<string, unknown>[] = [], storage: Record<string, unknown> = {}) {
  const assessment = { id: 'as1', course_id: 'c1', type: AssessmentType.QUIZ, pass_score: 50, config, is_required: true };
  const saved: Record<string, any>[] = [];
  const updates: Record<string, any>[] = [];
  const stored = () => [...saved, ...priorAttempts.filter((p) => !saved.includes(p))];
  const attempts = {
    // Copies, like a real read: a concurrent submit has its own object.
    findOne: jest.fn(async ({ where }: any) => {
      if (where.submitted_at) return priorAttempts.find((a) => !a.submitted_at) ?? null;
      const row = where.id ? saved.find((a) => a.id === where.id) ?? priorAttempts.find((a) => a.id === where.id) : null;
      return row ? { ...row } : null;
    }),
    count: jest.fn(async () => stored().filter((a) => a.submitted_at).length), // finished attempts of this learner and assessment
    find: jest.fn(async () => priorAttempts.filter((a) => a.submitted_at)), // startAttempt asks for finished attempts only
    save: jest.fn(async (a: any) => {
      if (!a.id) a.id = `att-${saved.length + 1}`;
      if (!a.created_at) a.created_at = new Date();
      if (!saved.includes(a)) saved.push(a);
      return a;
    }),
    create: jest.fn((a: any) => ({ proctor_log: [], flagged: false, terminated: false, ...a })),
    // The conditional update that records a result: it only hits a row whose predicate holds.
    createQueryBuilder: jest.fn(() => {
      const wheres: string[] = [];
      const params: Record<string, any> = {};
      let patch: Record<string, any> = {};
      const qb = {
        update: () => qb,
        set: (p: Record<string, any>) => ((patch = p), qb),
        where: (sql: string, p: Record<string, any> = {}) => (wheres.push(sql), Object.assign(params, p), qb),
        andWhere: (sql: string, p: Record<string, any> = {}) => (wheres.push(sql), Object.assign(params, p), qb),
        execute: async () => {
          updates.push(patch);
          const guarded = wheres.some((w) => /submitted_at\s+IS\s+NULL/i.test(w));
          const hit = stored().filter((r) => r.id === params.id && (!guarded || !r.submitted_at));
          hit.forEach((r) => Object.assign(r, patch));
          return { affected: hit.length };
        },
      };
      return qb;
    }),
    // startAttempt runs in one transaction (the lock is exercised in assessment.start.spec.ts).
    manager: { transaction: jest.fn(async (work: (m: unknown) => unknown) => work({ query: jest.fn(async () => []), getRepository: () => attempts })) },
  };
  const assessments = { findOne: jest.fn(async () => assessment), find: jest.fn(async () => [assessment]), save: jest.fn(), create: jest.fn() };
  const bus = { publish: jest.fn() };
  const internal = { get: jest.fn(async () => ({ entitlement_status: 'active', enrollment_id: 'en1', title: 'Course' })) };
  const svc = new AssessmentService(assessments as never, attempts as never, bus as never, internal as never, storage as never);
  return { svc, attempts, saved, bus, updates };
}

describe('quiz anti-cheat: per-attempt paper', () => {
  it('serves pool_size questions from the bank, shuffled, without any answer key', async () => {
    const { svc, saved } = harness({ questions: bankOf(10), pool_size: 4, shuffle: true });
    const paper: any = await svc.startAttempt(learner, 'as1');
    expect(paper.questions).toHaveLength(4);
    for (const q of paper.questions) {
      expect(q).not.toHaveProperty('correct_index');
      expect(q).not.toHaveProperty('guidance');
      expect(q.options).toHaveLength(4);
    }
    const order: number[] = saved[0].detail.order;
    expect(new Set(order).size).toBe(4);
    expect(order.every((i) => i >= 0 && i < 10)).toBe(true);
  });

  it('grades positional answers on a shuffled paper back against the bank correctly', async () => {
    const { svc, saved } = harness({ questions: bankOf(6), shuffle: true });
    const paper: any = await svc.startAttempt(learner, 'as1');
    const attempt = saved[0];
    // Answer every question correctly USING THE SERVED PAPER: find where the
    // bank's correct option landed after shuffling and pick that position.
    const responses = paper.questions.map((q: any, pos: number) => {
      const bankIndex: number = attempt.detail.order[pos];
      const correctLabel = `${['A', 'B', 'C', 'D'][bankIndex % 4]}${bankIndex}`;
      return { index: pos, selected_index: q.options.indexOf(correctLabel) };
    });
    const result = await svc.submitAttempt(learner, attempt.id, { responses });
    expect(result.score).toBe(100);
    expect(result.passed).toBe(true);
  });

  it('a wrong positional pick is graded wrong (no accidental credit from shuffling)', async () => {
    const { svc, saved } = harness({ questions: bankOf(4), shuffle: true });
    const paper: any = await svc.startAttempt(learner, 'as1');
    const attempt = saved[0];
    const responses = paper.questions.map((q: any, pos: number) => {
      const bankIndex: number = attempt.detail.order[pos];
      const correctLabel = `${['A', 'B', 'C', 'D'][bankIndex % 4]}${bankIndex}`;
      const wrong = q.options.findIndex((o: string) => o !== correctLabel);
      return { index: pos, selected_index: wrong };
    });
    const result = await svc.submitAttempt(learner, attempt.id, { responses });
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });
});

describe('quiz anti-cheat: attempts and clock', () => {
  it('resumes an open attempt instead of issuing a fresh paper', async () => {
    const open = { id: 'open-1', assessment_id: 'as1', learner_id: 'l1', submitted_at: null, created_at: new Date(), detail: { order: [2, 0, 1], option_orders: [null, null, null] }, proctor_log: [] };
    const { svc, attempts } = harness({ questions: bankOf(3), shuffle: true, time_limit_minutes: 30 }, [open]);
    const paper: any = await svc.startAttempt(learner, 'as1');
    expect(paper.attempt_id).toBe('open-1');
    expect(paper.questions.map((q: any) => q.prompt)).toEqual(['Q2', 'Q0', 'Q1']);
    expect(attempts.create).not.toHaveBeenCalled();
  });

  it('refuses a new attempt once max_attempts is used, or after a pass', async () => {
    const done = (id: string, passed: boolean) => ({ id, assessment_id: 'as1', learner_id: 'l1', submitted_at: new Date(), passed, created_at: new Date(), detail: {} });
    const { svc } = harness({ questions: bankOf(3), max_attempts: 2 }, [done('a', false), done('b', false)]);
    await expect(svc.startAttempt(learner, 'as1')).rejects.toBeInstanceOf(ForbiddenException);
    const { svc: svc2 } = harness({ questions: bankOf(3), max_attempts: 5 }, [done('a', true)]);
    await expect(svc2.startAttempt(learner, 'as1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a submission past the time limit (plus grace) is recorded as late and cannot pass', async () => {
    const late = { id: 'late-1', assessment_id: 'as1', learner_id: 'l1', submitted_at: null, created_at: new Date(Date.now() - 40 * 60_000), detail: { order: [0, 1, 2], option_orders: [null, null, null] }, proctor_log: [] };
    const { svc } = harness({ questions: bankOf(3), time_limit_minutes: 30 }, [late]);
    const result = await svc.submitAttempt(learner, 'late-1', { responses: [0, 1, 2].map((i) => ({ index: i, selected_index: i % 4 })) });
    expect(result.terminated).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.termination_reason).toMatch(/time limit/i);
  });

  it('exposes the server deadline so the client counts down to it, not to now+limit', async () => {
    const { svc } = harness({ questions: bankOf(3), time_limit_minutes: 10 });
    const paper: any = await svc.startAttempt(learner, 'as1');
    expect(paper.deadline_at).toBeInstanceOf(Date);
    expect(paper.seconds_left).toBeGreaterThan(590);
    expect(paper.seconds_left).toBeLessThanOrEqual(600);
  });
});

describe('submitting an attempt', () => {
  const open = (extra: Record<string, unknown> = {}) => ({
    id: 'open-1', assessment_id: 'as1', learner_id: 'l1', enrollment_id: 'en1', submitted_at: null, passed: null, score: null, created_at: new Date(),
    detail: { order: [0, 1], option_orders: [null, null] }, proctor_log: [], flagged: false, terminated: false, ...extra,
  });
  const done = (id: string, passed = false) => ({ id, assessment_id: 'as1', learner_id: 'l1', submitted_at: new Date(), passed, created_at: new Date(), detail: {} });
  const wrong = { responses: [{ index: 0, selected_index: 3 }, { index: 1, selected_index: 3 }] }; // bank answers are 0 and 1
  const right = { responses: [{ index: 0, selected_index: 0 }, { index: 1, selected_index: 1 }] };

  it('two concurrent submits of one attempt record and publish once, the loser gets 409', async () => {
    const { svc, bus, saved } = harness({ questions: bankOf(2), shuffle: false }, [open()]);
    const results = await Promise.allSettled([svc.submitAttempt(learner, 'open-1', right), svc.submitAttempt(learner, 'open-1', right)]);
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(ConflictException);
    expect(lost[0].reason.message).toBe('Attempt already submitted.');
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(0); // recorded by the claim, not by a blind save
  });

  it('an attempt that is already submitted is a 409 and publishes nothing', async () => {
    const { svc, bus } = harness({ questions: bankOf(2) }, [open({ submitted_at: new Date(), passed: true, score: 100 })]);
    await expect(svc.submitAttempt(learner, 'open-1', right)).rejects.toThrow(new ConflictException('Attempt already submitted.'));
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('the claim writes everything grading changed, with the time it reports', async () => {
    const late = open({ created_at: new Date(Date.now() - 40 * 60_000) });
    const { svc, updates } = harness({ questions: bankOf(2), shuffle: false, time_limit_minutes: 30 }, [late]);
    const result: any = await svc.submitAttempt(learner, 'open-1', right);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ score: 100, passed: false, terminated: true });
    expect(updates[0].submitted_at).toBeInstanceOf(Date);
    expect(updates[0].detail).toMatchObject({ termination_reason: 'Submitted after the time limit' });
    expect(updates[0].detail.breakdown).toHaveLength(2);
    expect(result.terminated).toBe(true);
  });

  it('withholds breakdown on a failed attempt while retries remain', async () => {
    const { svc, updates } = harness({ questions: bankOf(2), shuffle: false, max_attempts: 3 }, [open(), done('a')]);
    const result: any = await svc.submitAttempt(learner, 'open-1', wrong);
    expect(result).toMatchObject({ score: 0, passed: false });
    expect(result).not.toHaveProperty('breakdown');
    expect(updates[0].detail.breakdown).toHaveLength(2); // stored for the study coach
  });

  it('returns breakdown on a pass', async () => {
    const { svc } = harness({ questions: bankOf(2), shuffle: false, max_attempts: 3 }, [open()]);
    const result: any = await svc.submitAttempt(learner, 'open-1', right);
    expect(result.passed).toBe(true);
    expect(result.breakdown).toHaveLength(2);
  });

  it('returns breakdown on the last allowed failed attempt, counting this one', async () => {
    const { svc } = harness({ questions: bankOf(2), shuffle: false, max_attempts: 2 }, [open(), done('a')]);
    const result: any = await svc.submitAttempt(learner, 'open-1', wrong);
    expect(result.passed).toBe(false);
    expect(result.breakdown).toHaveLength(2);
  });

  it('applies the default of 3 attempts when the assessment sets none', async () => {
    const { svc } = harness({ questions: bankOf(2), shuffle: false }, [open(), done('a'), done('b')]);
    expect(await svc.submitAttempt(learner, 'open-1', wrong)).toHaveProperty('breakdown');
  });
});

describe('proctor report breakdown', () => {
  const scored = (extra: Record<string, unknown> = {}) => ({
    id: 'att-1', assessment_id: 'as1', learner_id: 'l1', submitted_at: new Date(), passed: false, score: 0, flagged: false, terminated: false,
    created_at: new Date(), proctor_log: [], detail: { breakdown: [{ index: 0, kind: 'mcq', correct: false }] }, ...extra,
  });
  const done = (id: string) => ({ id, assessment_id: 'as1', learner_id: 'l1', submitted_at: new Date(), passed: false, created_at: new Date(), detail: {} });
  const staff = { id: 'qo1', role: Role.QUALITY_OFFICER, email: 'q@x.et' };

  it('hides it from the learner while retries remain, but not from staff', async () => {
    const { svc } = harness({ questions: bankOf(2), max_attempts: 3 }, [scored()]);
    expect((await svc.proctorReport(learner, 'att-1')).breakdown).toBeNull();
    expect((await svc.proctorReport(staff, 'att-1')).breakdown).toHaveLength(1);
  });

  it('shows it to the learner once passed or out of attempts', async () => {
    const out = harness({ questions: bankOf(2), max_attempts: 2 }, [scored(), done('a')]);
    expect((await out.svc.proctorReport(learner, 'att-1')).breakdown).toHaveLength(1);
    const passed = harness({ questions: bankOf(2), max_attempts: 3 }, [scored({ passed: true, score: 100 })]);
    expect((await passed.svc.proctorReport(learner, 'att-1')).breakdown).toHaveLength(1);
  });
});

describe('proctor events on a finished attempt', () => {
  it('stays a 400 "Attempt already submitted"', async () => {
    const row = { id: 'att-1', assessment_id: 'as1', learner_id: 'l1', submitted_at: new Date(), detail: {}, proctor_log: [] };
    const { svc } = harness({ questions: bankOf(2) }, [row]);
    await expect(svc.recordProctorEvent(learner, 'att-1', { type: 'tab', description: 'x' })).rejects.toThrow(new BadRequestException('Attempt already submitted'));
  });

  it('a submit that lands during the screenshot upload wins: 400, and the result is left as the submit wrote it', async () => {
    const row: Record<string, any> = {
      id: 'att-1', assessment_id: 'as1', learner_id: 'l1', submitted_at: null, score: null, passed: null, detail: {}, proctor_log: [], flagged: false, terminated: false,
    };
    // The submit's claim lands between the proctor event's read and its write.
    const storage = { putObject: jest.fn(async () => void Object.assign(row, { submitted_at: new Date(), score: 80, passed: true })) };
    const { svc, attempts, updates } = harness({ questions: bankOf(2) }, [row], storage);
    await expect(
      svc.recordProctorEvent(learner, 'att-1', { type: 'tab_switch', description: 'x', screenshot_base64: 'aGVsbG8=' }),
    ).rejects.toThrow(new BadRequestException('Attempt already submitted'));
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    expect(attempts.save).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1); // the conditional write, which hit nothing
    expect(row.submitted_at).toBeInstanceOf(Date);
    expect(row).toMatchObject({ score: 80, passed: true, proctor_log: [], flagged: false, terminated: false });
  });
});

describe('proctor events on an open attempt', () => {
  const event = (type: string) => ({ type, description: 'earlier', at: new Date().toISOString(), screenshot_key: null });
  const openRow = (proctor_log: Record<string, unknown>[] = []): Record<string, any> => ({
    id: 'att-1', assessment_id: 'as1', learner_id: 'l1', submitted_at: null, score: null, passed: null, detail: {}, proctor_log, flagged: false, terminated: false,
  });

  it('appends to the log and flags the attempt, writing only those columns', async () => {
    const row = openRow();
    const { svc, attempts, updates } = harness({ questions: bankOf(2) }, [row]);
    const res = await svc.recordProctorEvent(learner, 'att-1', { type: 'tab_switch', description: 'left the tab' });
    expect(res).toEqual({ recorded: true, type: 'tab_switch', count: 1, remaining: 2, terminate: false });
    expect(attempts.save).not.toHaveBeenCalled();
    expect(updates).toEqual([{ proctor_log: [expect.objectContaining({ type: 'tab_switch', description: 'left the tab', screenshot_key: null })], flagged: true }]);
    expect(row.proctor_log).toHaveLength(1);
    expect(row).toMatchObject({ flagged: true, terminated: false, submitted_at: null });
  });

  it('terminates the attempt at the limit', async () => {
    const row = openRow([event('tab_switch'), event('no_face'), event('tab_switch')]);
    const { svc, updates } = harness({ questions: bankOf(2) }, [row]);
    const res = await svc.recordProctorEvent(learner, 'att-1', { type: 'tab_switch', description: 'left again' });
    expect(res).toEqual({ recorded: true, type: 'tab_switch', count: 3, remaining: 0, terminate: true });
    expect(Object.keys(updates[0]).sort()).toEqual(['flagged', 'proctor_log', 'terminated']);
    expect(row.proctor_log).toHaveLength(4);
    expect(row).toMatchObject({ flagged: true, terminated: true, submitted_at: null });
  });
});
