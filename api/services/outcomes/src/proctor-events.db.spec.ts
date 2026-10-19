import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { buildTypeOrmOptions } from '@ethiopialearn/common';
import { Role } from '@ethiopialearn/contracts';
import { AssessmentService, PROCTOR_EVENTS_MAX, PROCTOR_WARNING_LIMIT } from './assessment.service';
import { entities, migrations, SCHEMA } from './database';
import { AssessmentAttempt } from './entities';

/**
 * Proctor events under concurrency, against a real Postgres: parallel posts
 * neither lose each other's events nor pass the per-attempt cap, and only the
 * events that made it into the log store a screenshot.
 *
 * Opt-in: runs only when TEST_DATABASE_URL names a scratch database (the CI e2e
 * job creates one), so `pnpm -C api test` stays database-free. It runs the
 * outcomes migrations there and deletes only the rows it created.
 */
const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;

describeWithDb('proctor events on Postgres (TEST_DATABASE_URL)', () => {
  let dataSource: DataSource;
  const created: string[] = [];

  beforeAll(async () => {
    dataSource = new DataSource({ ...buildTypeOrmOptions(SCHEMA, entities, migrations), url, migrationsRun: false, logging: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await dataSource.runMigrations({ transaction: 'each' });
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    if (created.length) await dataSource.getRepository(AssessmentAttempt).delete({ id: In(created) });
    await dataSource.destroy();
  });

  async function setup(priorEvents = 0) {
    const attempts = dataSource.getRepository(AssessmentAttempt);
    const learner = { id: randomUUID(), role: Role.LEARNER, email: 'l@x.et' };
    const at = new Date().toISOString();
    const row = await attempts.save(
      attempts.create({
        assessment_id: randomUUID(),
        learner_id: learner.id,
        enrollment_id: randomUUID(),
        proctor_log: Array.from({ length: priorEvents }, () => ({ type: 'other', description: 'earlier', at, screenshot_key: null })),
      }),
    );
    created.push(row.id);
    const storage = { putObject: jest.fn(async () => undefined) };
    const svc = new AssessmentService({} as never, attempts, {} as never, {} as never, storage as never, {} as never);
    const post = (type: string) => svc.recordProctorEvent(learner, row.id, { type, description: 'x', screenshot_base64: 'aGVsbG8=' });
    const reload = () => attempts.findOneByOrFail({ id: row.id });
    return { post, storage, reload };
  }

  it(`${PROCTOR_EVENTS_MAX + 10} parallel posts: exactly ${PROCTOR_EVENTS_MAX} are logged and stored, the rest are 429`, async () => {
    const t = await setup();
    const results = await Promise.allSettled(Array.from({ length: PROCTOR_EVENTS_MAX + 10 }, () => t.post('other')));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(PROCTOR_EVENTS_MAX);
    expect(refused).toHaveLength(10);
    for (const r of refused) expect((r.reason as HttpException).getStatus()).toBe(429);

    const row = await t.reload();
    expect(row.proctor_log).toHaveLength(PROCTOR_EVENTS_MAX);
    expect(t.storage.putObject).toHaveBeenCalledTimes(PROCTOR_EVENTS_MAX);
    const stored = (t.storage.putObject.mock.calls as unknown as [string][]).map(([key]) => key).sort();
    expect(stored).toEqual(row.proctor_log.map((e) => e.screenshot_key).sort());
    expect(new Set(stored).size).toBe(PROCTOR_EVENTS_MAX);
  });

  it('parallel strikes of one type all count, and the attempt is terminated', async () => {
    const t = await setup();
    const results = await Promise.all(Array.from({ length: PROCTOR_WARNING_LIMIT }, () => t.post('tab_switch')));
    expect(results.map((r) => r.count).sort()).toEqual([1, 2, 3]);
    expect(results.filter((r) => r.terminate)).toHaveLength(1);
    const row = await t.reload();
    expect(row).toMatchObject({ flagged: true, terminated: true });
    expect(row.proctor_log).toHaveLength(PROCTOR_WARNING_LIMIT);
  });

  it('a post against a full log changes nothing', async () => {
    const t = await setup(PROCTOR_EVENTS_MAX);
    await expect(t.post('no_face')).rejects.toBeInstanceOf(HttpException);
    expect(t.storage.putObject).not.toHaveBeenCalled();
    expect((await t.reload()).proctor_log).toHaveLength(PROCTOR_EVENTS_MAX);
  });
});
