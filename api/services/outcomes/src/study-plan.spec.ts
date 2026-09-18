import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AssessmentType, Role } from '@ethiopialearn/contracts';
import { AssessmentService } from './assessment.service';

/**
 * AI study coach: builds a review plan from the questions a learner missed on a
 * submitted quiz attempt, grounded in the course outline. Ownership and state
 * are enforced; the AI failure path falls back to the offline coach.
 */
const learner = { id: 'l1', role: Role.LEARNER, email: 'l@x.et' };

function harness(attempt: Record<string, unknown> | null, opts: { aiThrows?: boolean } = {}) {
  const assessment = {
    id: 'as1',
    course_id: 'c1',
    type: AssessmentType.QUIZ,
    pass_score: 60,
    config: { questions: [{ prompt: 'What is X?' }, { prompt: 'What is Y?' }, { prompt: 'What is Z?' }] },
  };
  const attempts = { findOne: jest.fn(async () => attempt) };
  const assessments = { findOne: jest.fn(async () => assessment) };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.endsWith('/outline')) return { outline: ['Intro — X', 'Intro — Y', 'Advanced — Z'] };
      return { title: 'Test Course' };
    }),
  };
  const bus = { publish: jest.fn() };
  const svc = new AssessmentService(assessments as never, attempts as never, bus as never, internal as never, {} as never);
  if (opts.aiThrows) {
    (svc as unknown as { ai: { buildStudyPlan: () => Promise<never>; isLive: boolean } }).ai = {
      isLive: true,
      buildStudyPlan: async () => {
        throw new Error('groq down');
      },
    };
  }
  return { svc, internal };
}

const submitted = {
  id: 'att1',
  assessment_id: 'as1',
  learner_id: 'l1',
  submitted_at: new Date(),
  score: 33,
  passed: false,
  detail: {
    order: [0, 1, 2],
    breakdown: [
      { index: 0, earned: 1, points: 1 }, // correct
      { index: 1, earned: 0, points: 1 }, // missed
      { index: 2, earned: 0, points: 1 }, // missed
    ],
  },
};

describe('AssessmentService.studyPlan', () => {
  it('builds a plan from the missed questions and course outline', async () => {
    const { svc, internal } = harness(submitted);
    const res = await svc.studyPlan(learner, 'att1');
    expect(res.missed_count).toBe(2);
    expect(res.score).toBe(33);
    expect(res.passed).toBe(false);
    expect(Array.isArray(res.plan)).toBe(true);
    expect(res.plan.length).toBeGreaterThan(0);
    // Grounded in the outline the internal call returned.
    expect(internal.get).toHaveBeenCalledWith(expect.stringContaining('/outline'));
  });

  it('falls back to the offline coach when the AI call throws', async () => {
    const { svc } = harness(submitted, { aiThrows: true });
    const res = await svc.studyPlan(learner, 'att1');
    expect(res.ai_live).toBe(false);
    expect(res.summary).toContain('33%');
  });

  it('rejects another learner’s attempt', async () => {
    const { svc } = harness({ ...submitted, learner_id: 'someone-else' });
    await expect(svc.studyPlan(learner, 'att1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an unsubmitted attempt', async () => {
    const { svc } = harness({ ...submitted, submitted_at: null });
    await expect(svc.studyPlan(learner, 'att1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s an unknown attempt', async () => {
    const { svc } = harness(null);
    await expect(svc.studyPlan(learner, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
