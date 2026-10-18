import { Logger } from '@nestjs/common';
import { In } from 'typeorm';
import { PeerUnavailableError } from '@ethiopialearn/common';
import { Role } from '@ethiopialearn/contracts';
import { AssessmentService } from './assessment.service';

/** Phase 9e: attempt lists cost a fixed number of queries and internal calls. */
const officer = { id: 'qo1', role: Role.QUALITY_OFFICER, email: 'qo@e.et' } as never;
const learner = { id: 'u1', role: Role.LEARNER, email: 'u1@e.et' } as never;

const attempt = (i: number) => ({ id: `t${i}`, assessment_id: `a${i % 2}`, learner_id: `l${i % 4}`, detail: {}, proctor_log: [], created_at: new Date() });

function setup(opts: { authDown?: boolean } = {}) {
  const rows = Array.from({ length: 10 }, (_, i) => attempt(i));
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'addOrderBy', 'take', 'skip']) qb[m] = jest.fn(() => qb);
  qb.getMany = jest.fn(async () => rows);
  const assessments = { find: jest.fn(async () => [{ id: 'a0', course_id: 'c1', type: 'quiz', config: {} }, { id: 'a1', course_id: 'c1', type: 'project', config: {} }]) };
  const attempts = { createQueryBuilder: jest.fn(() => qb), find: jest.fn(async () => rows) };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (opts.authDown) throw new PeerUnavailableError();
      return decodeURIComponent(path.split('ids=')[1].split('&')[0])
        .split(',')
        .map((id) => ({ id, name: `Name ${id}`, role: 'learner', email: `${id}@e.et` }));
    }),
  };
  const service = new AssessmentService(assessments as never, attempts as never, {} as never, internal as never, {} as never, {} as never);
  return { service, qb, assessments, attempts, internal };
}

describe('AssessmentService.courseAttempts (Phase 9e)', () => {
  it('names a page of attempts from one users call, paged newest first', async () => {
    const t = setup();
    const rows = await t.service.courseAttempts(officer, 'c1', 2, 50);
    expect(t.internal.get).toHaveBeenCalledTimes(1);
    expect(rows[0]).toEqual(expect.objectContaining({ learner_name: 'Name l0', learner_email: 'l0@e.et' }));
    expect(t.qb.take).toHaveBeenCalledWith(50);
    expect(t.qb.skip).toHaveBeenCalledWith(50);
  });

  it('auth down: "Unknown learner", never an error', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const rows = await setup({ authDown: true }).service.courseAttempts(officer, 'c1');
    expect(rows[0]).toEqual(expect.objectContaining({ learner_name: 'Unknown learner', learner_email: '' }));
  });
});

describe('AssessmentService.myAttempts (Phase 9e)', () => {
  it('filters by course in the query: two queries, no per-attempt lookup', async () => {
    const t = setup();
    const rows = await t.service.myAttempts(learner, 'c1');
    expect(rows).toHaveLength(10);
    expect(t.assessments.find).toHaveBeenCalledTimes(1);
    expect(t.attempts.find).toHaveBeenCalledWith({
      where: { learner_id: 'u1', assessment_id: In(['a0', 'a1']) },
      order: { created_at: 'DESC' },
      take: 200,
    });
  });

  it('a course with no assessments answers [] without reading attempts', async () => {
    const t = setup();
    t.assessments.find.mockResolvedValueOnce([]);
    expect(await t.service.myAttempts(learner, 'c9')).toEqual([]);
    expect(t.attempts.find).not.toHaveBeenCalled();
  });
});
