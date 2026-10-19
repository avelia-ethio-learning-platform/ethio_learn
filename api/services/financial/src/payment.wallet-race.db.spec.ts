import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { buildTypeOrmOptions } from '@ethiopialearn/common';
import { PaymentStatus } from '@ethiopialearn/contracts';
import { entities, migrations, SCHEMA } from './database';
import { Coupon, Payment, Referral, ReferralCode, Wallet, WalletTransaction } from './entities';
import { GrowthService } from './growth.service';
import { PaymentService } from './payment.service';

/**
 * Two wallet purchases of one course against a real Postgres (9c review B1):
 * the guard's try-lock, check and insert share one transaction, so of two
 * parallel buys one is charged and the other is a 409, with one debit.
 *
 * Opt-in: runs only when TEST_DATABASE_URL names a scratch database (the CI
 * e2e job creates one), so `pnpm -C api test` stays database-free. It runs the
 * financial migrations there and deletes only the rows it created.
 */
const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;

describeWithDb('PaymentService wallet purchases on Postgres (TEST_DATABASE_URL)', () => {
  let dataSource: DataSource;
  let service: PaymentService;
  let growth: GrowthService;
  const learners: string[] = [];

  beforeAll(async () => {
    dataSource = new DataSource({ ...buildTypeOrmOptions(SCHEMA, entities, migrations), url, migrationsRun: false, logging: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await dataSource.runMigrations({ transaction: 'each' });

    const bus = { publish: jest.fn().mockResolvedValue(undefined), publishConfirmed: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    const internal = {
      get: jest.fn(async (path: string) => {
        const course = /\/internal\/courses\/([^/?]+)$/.exec(path);
        if (course) return { id: course[1], title: 'Course', owner_id: randomUUID(), owner_type: 'educator', price_etb: 500, pricing_type: 'paid', status: 'published' };
        if (path.includes('/internal/users/')) return { email: 'learner@test.invalid', name: 'Learner' };
        if (path.includes('/entitlements')) return { entitlement_status: 'none' };
        throw new Error(`unexpected internal call ${path}`);
      }),
    };
    const chapa = { generateTxRef: jest.fn(async () => `TX-RACE-${randomUUID()}`) };
    const repo = <T extends object>(e: new () => T) => dataSource.getRepository(e);
    growth = new GrowthService(
      repo(Coupon),
      repo(Wallet),
      repo(WalletTransaction),
      repo(ReferralCode),
      repo(Referral),
      dataSource,
      bus as never,
      internal as never,
      {} as never, // the outbox: no invite here
    );
    service = new PaymentService(repo(Payment), chapa as never, bus as never, internal as never, growth, dataSource);

    // Open the connections first, so pool growth doesn't stagger the parallel buys into a queue.
    await Promise.all(Array.from({ length: 10 }, () => dataSource.query('SELECT pg_sleep(0.05)')));
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    if (learners.length) {
      await dataSource.getRepository(WalletTransaction).delete({ user_id: In(learners) });
      await dataSource.getRepository(Wallet).delete({ user_id: In(learners) });
      await dataSource.getRepository(Payment).delete({ learner_id: In(learners) });
    }
    await dataSource.destroy();
  });

  const funded = async () => {
    const id = randomUUID();
    learners.push(id);
    await growth.credit(id, 2000, 'topup', `topup-${id}`, 'Wallet top-up');
    return { ctx: { id, role: 'learner', email: `${id}@test.invalid` } as never, id };
  };
  const debits = (userId: string) => dataSource.getRepository(WalletTransaction).count({ where: { user_id: userId, kind: 'purchase' } });
  const status = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 200 : (r.reason as HttpException).getStatus?.() ?? String(r.reason));

  it('a buy while another request holds the lock is a 409 with no row; once released it goes through', async () => {
    const { ctx, id } = await funded();
    const course = randomUUID();
    const holder = dataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    try {
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`course-purchase:${id}:${course}`]);
      await expect(service.initiate(ctx, course, { use_wallet: true })).rejects.toThrow('A payment for this course is in progress.');
      expect(await dataSource.getRepository(Payment).count({ where: { learner_id: id } })).toBe(0);
    } finally {
      await holder.commitTransaction();
      await holder.release();
    }
    await expect(service.initiate(ctx, course, { use_wallet: true })).resolves.toMatchObject({ confirmed: true });
    expect(await debits(id)).toBe(1);
  });

  it('5 rounds of two parallel buys: one confirmed, one 409, one debit each round', async () => {
    for (let round = 0; round < 5; round++) {
      const { ctx, id } = await funded();
      const course = randomUUID();
      const results = await Promise.allSettled([service.initiate(ctx, course, { use_wallet: true }), service.initiate(ctx, course, { use_wallet: true })]);
      expect(results.map(status).sort()).toEqual([200, 409]);
      expect(await debits(id)).toBe(1);
      expect(await dataSource.getRepository(Payment).count({ where: { learner_id: id, status: PaymentStatus.CONFIRMED } })).toBe(1);
    }
  });
});
