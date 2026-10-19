import { Logger } from '@nestjs/common';
import { PeerAsleepError } from '@ethiopialearn/common';
import { CourseService } from './course.service';
import { CourseInternalController } from './internal.controller';

/** Phase 9e: catalog names come from one auth batch call, and a sleeping auth never fails the catalog. */
const course = (i: number) => ({
  id: `c${i}`,
  title: `Course ${i}`,
  status: 'published',
  owner_id: `edu${i % 3}`,
  owner_type: 'educator',
  created_by: `edu${i % 3}`,
  rating_count: 0,
  enrolled_count: 0,
});

function setup(opts: { authDown?: boolean } = {}) {
  const items = Array.from({ length: 12 }, (_, i) => course(i));
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['where', 'andWhere', 'orderBy', 'addOrderBy', 'take', 'skip', 'select', 'addSelect', 'groupBy', 'limit']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getManyAndCount = jest.fn(async () => [items, items.length]);
  qb.getRawMany = jest.fn(async () => [0, 1, 2].map((i) => ({ educator_id: `edu${i}`, course_count: '4', total_points: '10', rating_count: '2', learner_count: '5' })));
  const courses = { createQueryBuilder: jest.fn(() => qb) };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (opts.authDown) throw new PeerAsleepError();
      const ids = decodeURIComponent(path.split('ids=')[1].split('&')[0]).split(',');
      return ids.filter((id) => id !== 'edu2').map((id) => ({ id, name: `Name ${id}`, role: 'educator' }));
    }),
  };
  const service = new CourseService(
    courses as never,
    {} as never,
    {} as never,
    { subscribe: jest.fn(), publish: jest.fn() } as never,
    internal as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, internal, qb };
}

const params = { page: 1, limit: 12 };

describe('CourseService.search educator names (Phase 9e)', () => {
  it('adds educator_name from one users batch call per page, null for an unknown educator', async () => {
    const t = setup();
    const page = await t.service.search(params);
    expect(t.internal.get).toHaveBeenCalledTimes(1);
    expect(t.internal.get.mock.calls[0][0]).toBe('/api/v1/internal/users?ids=edu0,edu1,edu2');
    expect(page.items[0]).toEqual(expect.objectContaining({ id: 'c0', educator_name: 'Name edu0' }));
    expect(page.items[2]).toEqual(expect.objectContaining({ id: 'c2', educator_name: null }));
    // Cached with the names: the next identical search asks no one.
    await t.service.search(params);
    expect(t.internal.get).toHaveBeenCalledTimes(1);
  });

  it('auth down: 200 with items and no educator_name, and the page is not cached', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = setup({ authDown: true });
    const page = await t.service.search(params);
    expect(page.items).toHaveLength(12);
    expect(page.items[0]).not.toHaveProperty('educator_name');
    await t.service.search(params);
    expect(t.internal.get).toHaveBeenCalledTimes(2);
    expect(t.qb.getManyAndCount).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('CourseService.topEducators (Phase 9e)', () => {
  it('names every educator from one users call', async () => {
    const t = setup();
    const top = await t.service.topEducators();
    expect(t.internal.get).toHaveBeenCalledTimes(1);
    expect(top.map((e) => e.name)).toEqual(['Name edu0', 'Name edu1', 'Educator']);
  });

  it('auth down: the placeholder name, never an error', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = setup({ authDown: true });
    expect((await t.service.topEducators()).map((e) => e.name)).toEqual(['Educator', 'Educator', 'Educator']);
  });
});

describe('CourseInternalController route order', () => {
  it('declares courses/lesson-ids before courses/:id, so "lesson-ids" is never taken as an id', () => {
    const methods = Object.getOwnPropertyNames(CourseInternalController.prototype);
    expect(methods.indexOf('lessonIdsMany')).toBeGreaterThan(-1);
    expect(methods.indexOf('lessonIdsMany')).toBeLessThan(methods.indexOf('course'));
  });
});
