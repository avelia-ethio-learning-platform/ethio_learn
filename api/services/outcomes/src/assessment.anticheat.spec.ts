import { BadRequestException, ForbiddenException } from '@nestjs/common';
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

function harness(config: Record<string, unknown>, priorAttempts: Record<string, unknown>[] = []) {
  const assessment = { id: 'as1', course_id: 'c1', type: AssessmentType.QUIZ, pass_score: 50, config, is_required: true };
  const saved: Record<string, any>[] = [];
  const attempts = {
    findOne: jest.fn(async ({ where }: any) => {
      if (where.submitted_at) return priorAttempts.find((a) => !a.submitted_at) ?? null;
      if (where.id) return saved.find((a) => a.id === where.id) ?? priorAttempts.find((a) => a.id === where.id) ?? null;
      return null;
    }),
    find: jest.fn(async () => priorAttempts),
    save: jest.fn(async (a: any) => {
      if (!a.id) a.id = `att-${saved.length + 1}`;
      if (!a.created_at) a.created_at = new Date();
      if (!saved.includes(a)) saved.push(a);
      return a;
    }),
    create: jest.fn((a: any) => ({ proctor_log: [], flagged: false, terminated: false, ...a })),
    createQueryBuilder: jest.fn(),
  };
  const assessments = { findOne: jest.fn(async () => assessment), find: jest.fn(async () => [assessment]), save: jest.fn(), create: jest.fn() };
  const bus = { publish: jest.fn() };
  const internal = { get: jest.fn(async () => ({ entitlement_status: 'active', enrollment_id: 'en1', title: 'Course' })) };
  const storage = {};
  const svc = new AssessmentService(assessments as never, attempts as never, bus as never, internal as never, storage as never);
  return { svc, attempts, saved, bus };
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
