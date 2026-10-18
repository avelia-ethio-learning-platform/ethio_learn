import { DataSource } from 'typeorm';
import { JobLease, runJob, startJob } from './job-lease';

/**
 * The lease SQL against a real Postgres. Opt-in: runs only when TEST_DATABASE_URL
 * names a scratch database (CI creates one); it uses a schema of its own.
 */
const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;
const SCHEMA = 'job_lease_spec';

describeWithDb('job leases on Postgres (TEST_DATABASE_URL)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    const bootstrap = new DataSource({ type: 'postgres', url });
    await bootstrap.initialize();
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await bootstrap.query(`CREATE SCHEMA "${SCHEMA}"`);
    await bootstrap.destroy();
    dataSource = new DataSource({ type: 'postgres', url, schema: SCHEMA, entities: [JobLease], synchronize: true, logging: false });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await dataSource.destroy();
  });

  const lease = (name: string) => dataSource.getRepository(JobLease).findOneByOrFail({ name });

  it('of two concurrent runs of a new job, exactly one runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Each run waits until both lease attempts are done, so a quick first run can't free the lease for the second.
    const fn = jest.fn(async () => (await gate, { done: 1 }));
    const starts = await Promise.all([startJob(dataSource, 'fresh', 60_000, fn), startJob(dataSource, 'fresh', 60_000, fn)]);
    release();
    expect(starts.map((s) => s.started).sort()).toEqual([false, true]);
    await Promise.all(starts.map((s) => (s.started ? s.finished : null)));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await runJob(dataSource, 'fresh', 60_000, async () => ({ done: 1 }))).toEqual({ done: 1 });
    expect(await lease('fresh')).toMatchObject({ locked_until: null, last_result: { done: 1 }, last_finished_at: expect.any(Date) });
  });

  it('an expired lease is taken over, and the late original run does not clear the new holder', async () => {
    let finishFirst!: () => void;
    const first = await startJob(dataSource, 'takeover', 50, () => new Promise<{ n: number }>((r) => (finishFirst = () => r({ n: 1 }))));
    expect(first.started).toBe(true);
    await new Promise((r) => setTimeout(r, 150)); // the first run's 50 ms lease expires
    let finishSecond!: () => void;
    const second = await startJob(dataSource, 'takeover', 60_000, () => new Promise<{ n: number }>((r) => (finishSecond = () => r({ n: 2 }))));
    expect(second.started).toBe(true);
    const holder = (await lease('takeover')).holder;

    finishFirst();
    await (first as { finished: Promise<unknown> }).finished;
    const during = await lease('takeover');
    expect(during.holder).toBe(holder);
    expect(during.locked_until!.getTime()).toBeGreaterThan(Date.now());
    expect(during.last_result).toBeNull();
    expect((await startJob(dataSource, 'takeover', 60_000, async () => null)).started).toBe(false);

    finishSecond();
    await (second as { finished: Promise<unknown> }).finished;
    expect(await lease('takeover')).toMatchObject({ locked_until: null, last_result: { n: 2 } });
  });
});
