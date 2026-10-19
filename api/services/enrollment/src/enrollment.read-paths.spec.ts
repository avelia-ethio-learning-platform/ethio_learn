import { Logger } from '@nestjs/common';
import { PeerUnavailableError } from '@ethiopialearn/common';
import { EntitlementStatus, Role } from '@ethiopialearn/contracts';
import { EnrollmentService } from './enrollment.service';

/**
 * Phase 9e: list reads cost a fixed number of internal calls. The internal
 * client is mocked; the specs count its calls by path.
 */
const learner = { id: 'u1', role: Role.LEARNER, email: 'l@e.et' } as never;

const enrollment = (i: number, patch: Record<string, unknown> = {}) => ({
  id: `e${i}`,
  learner_id: 'u1',
  course_id: `c${i}`,
  entitlement_status: EntitlementStatus.ACTIVE,
  enrolled_at: new Date('2026-09-01'),
  completed_at: null,
  source: 'free',
  last_activity_at: null,
  ...patch,
});

function setup(rows: Array<ReturnType<typeof enrollment>>, opts: { lessonIdsFail?: boolean } = {}) {
  const enrollments = { find: jest.fn().mockResolvedValue(rows) };
  // Each course has 4 live lessons; each enrollment has done 1 of them.
  const progressQb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(async () => rows.map((r) => ({ enrollment_id: r.id, done: '1' }))),
  };
  const progress = { createQueryBuilder: jest.fn(() => progressQb) };
  const courseCache = { find: jest.fn(async () => rows.map((r) => ({ course_id: r.course_id, title: `Title ${r.course_id}` }))) };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (opts.lessonIdsFail) throw new PeerUnavailableError();
      const ids = decodeURIComponent(path.split('ids=')[1]).split(',');
      return Object.fromEntries(ids.map((id) => [id, ['a', 'b', 'c', 'd'].map((l) => `${id}-${l}`)]));
    }),
  };
  const service = new EnrollmentService(
    enrollments as never,
    progress as never,
    courseCache as never,
    {} as never,
    { subscribe: jest.fn(), publish: jest.fn() } as never,
    internal as never,
    {} as never,
  );
  return { service, enrollments, progress, progressQb, courseCache, internal };
}

describe('EnrollmentService.nudgeInactiveLearners (Phase 9e)', () => {
  it('course down: no nudge and no claim, so the next run sends the real percentage', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = setup([enrollment(1, { last_activity_at: new Date('2026-09-01'), nudge_level: 0 })], { lessonIdsFail: true });
    const enrollments = t.enrollments as unknown as { save: jest.Mock };
    enrollments.save = jest.fn();
    const bus = (t.service as unknown as { bus: { publish: jest.Mock } }).bus;
    await t.service.nudgeInactiveLearners();
    expect(enrollments.save).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });
});

describe('EnrollmentService.listForLearner (Phase 9e)', () => {
  it('30 enrollments: one titles query, one lesson-ids batch call and one grouped count', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => enrollment(i));
    const t = setup(rows);
    const list = await t.service.listForLearner(learner);

    expect(list).toHaveLength(30);
    expect(list[0]).toEqual(expect.objectContaining({ id: 'e0', course_title: 'Title c0', progress_percent: 25 }));
    expect(t.internal.get).toHaveBeenCalledTimes(1);
    expect(t.internal.get.mock.calls[0][0]).toMatch(/^\/api\/v1\/internal\/courses\/lesson-ids\?ids=/);
    expect(t.courseCache.find).toHaveBeenCalledTimes(1);
    expect(t.progressQb.getRawMany).toHaveBeenCalledTimes(1);
  });

  it('asks for the newest 200 at most', async () => {
    const t = setup([]);
    await expect(t.service.listForLearner(learner)).resolves.toEqual([]);
    expect(t.enrollments.find).toHaveBeenCalledWith(expect.objectContaining({ order: { enrolled_at: 'DESC' }, take: 200 }));
    expect(t.internal.get).not.toHaveBeenCalled();
  });

  it('course asleep: the list still answers, with progress null and one warn', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = setup([enrollment(1), enrollment(2)], { lessonIdsFail: true });
    const list = await t.service.listForLearner(learner);
    expect(list.map((e) => e.progress_percent)).toEqual([null, null]);
    expect(list[0].course_title).toBe('Title c1');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('EnrollmentService.progressForPairs (Phase 9e)', () => {
  it('answers each pair that has an enrollment from one query and one lesson-ids call', async () => {
    const rows = [enrollment(1), enrollment(2, { entitlement_status: EntitlementStatus.REFUNDED, completed_at: new Date() })];
    const t = setup(rows);
    const out = await t.service.progressForPairs(['u1:c1', 'U1:C2', 'u1:c9']);
    expect(t.enrollments.find).toHaveBeenCalledWith({
      where: [
        { learner_id: 'u1', course_id: 'c1' },
        { learner_id: 'u1', course_id: 'c2' },
        { learner_id: 'u1', course_id: 'c9' },
      ],
    });
    expect(out).toEqual([
      { learner_id: 'u1', course_id: 'c1', active: true, progress_percent: 25, lessons_complete: false },
      { learner_id: 'u1', course_id: 'c2', active: false, progress_percent: 25, lessons_complete: true },
    ]);
    expect(t.internal.get).toHaveBeenCalledTimes(1);
  });

  it('progress_percent is null, not 0, when course is asleep', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = setup([enrollment(1)], { lessonIdsFail: true });
    expect(await t.service.progressForPairs(['u1:c1'])).toEqual([
      { learner_id: 'u1', course_id: 'c1', active: true, progress_percent: null, lessons_complete: false },
    ]);
  });
});
