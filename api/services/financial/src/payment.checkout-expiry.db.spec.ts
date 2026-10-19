import { randomUUID } from 'crypto';
import { DataSource, In } from 'typeorm';
import { buildTypeOrmOptions } from '@ethiopialearn/common';
import { PaymentMethod, PaymentStatus } from '@ethiopialearn/contracts';
import { entities, migrations, SCHEMA } from './database';
import { Coupon, Payment, Referral, ReferralCode, Wallet, WalletTransaction } from './entities';
import { GrowthService } from './growth.service';
import { PaymentService } from './payment.service';

/**
 * P2-01 on a real Postgres: a repeat Buy gets the open checkout back (the
 * reuse query's IS NULL / IS NOT NULL / timestamptz filters), and the sweep
 * job expires an abandoned one after asking Chapa, least recently checked first.
 *
 * Opt-in: runs only when TEST_DATABASE_URL names a scratch database (the CI
 * e2e job creates one). It runs the financial migrations there and deletes
 * only the rows it created.
 */
const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;

describeWithDb('PaymentService abandoned checkouts on Postgres (TEST_DATABASE_URL)', () => {
  let dataSource: DataSource;
  let service: PaymentService;
  const learners: string[] = [];
  const course = { id: randomUUID(), owner_id: randomUUID() };
  const chapa = {
    generateTxRef: jest.fn(async () => `TX-EXP-${randomUUID()}`),
    initialize: jest.fn(async (o: { tx_ref: string }) => ({ checkout_url: `https://checkout.example/${o.tx_ref}` })),
    verify: jest.fn(async () => ({ status: 'pending' as const, amount: null, currency: null })),
  };
  const savedMode = process.env.CHAPA_MODE;

  beforeAll(async () => {
    process.env.CHAPA_MODE = 'live';
    dataSource = new DataSource({ ...buildTypeOrmOptions(SCHEMA, entities, migrations), url, migrationsRun: false, logging: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await dataSource.runMigrations({ transaction: 'each' });

    const bus = { publish: jest.fn().mockResolvedValue(undefined), publishConfirmed: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    const internal = {
      get: jest.fn(async (path: string) => {
        if (path.includes('/internal/courses/')) return { ...course, title: 'Course', owner_type: 'educator', price_etb: 500, pricing_type: 'paid', status: 'published' };
        if (path.includes('/internal/users/')) return { email: 'learner@test.invalid', name: 'Learner' };
        if (path.includes('/entitlements')) return { entitlement_status: 'none' };
        throw new Error(`unexpected internal call ${path}`);
      }),
    };
    const repo = <T extends object>(e: new () => T) => dataSource.getRepository(e);
    const growth = new GrowthService(
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
  });

  afterAll(async () => {
    if (savedMode === undefined) delete process.env.CHAPA_MODE;
    else process.env.CHAPA_MODE = savedMode;
    if (!dataSource?.isInitialized) return;
    if (learners.length) await dataSource.getRepository(Payment).delete({ learner_id: In(learners) });
    await dataSource.destroy();
  });

  const learner = () => {
    const id = randomUUID();
    learners.push(id);
    return { ctx: { id, role: 'learner', email: `${id}@test.invalid` } as never, id };
  };
  const age = (id: string, hours: number) => dataSource.query(`UPDATE "${SCHEMA}".payments SET created_at = now() - make_interval(hours => $2) WHERE id = $1`, [id, hours]);
  const statusOf = async (id: string) => (await dataSource.getRepository(Payment).findOneByOrFail({ id })).status;

  it('a repeat Buy gets the open checkout back; once that is past the window, a new one opens', async () => {
    const { ctx, id } = learner();
    const first = await service.initiate(ctx, course.id);
    const again = await service.initiate(ctx, course.id);
    expect(again).toEqual(first);
    expect(await dataSource.getRepository(Payment).count({ where: { learner_id: id } })).toBe(1);

    await age(first.payment_id, 2);
    const later = await service.initiate(ctx, course.id);
    expect(later.payment_id).not.toBe(first.payment_id);
    expect(await statusOf(first.payment_id)).toBe(PaymentStatus.PENDING);
  });

  it('expires a 49 h old checkout Chapa reports unpaid, never-checked first, and leaves a 47 h old one pending', async () => {
    const { ctx } = learner();
    const old = await service.initiate(ctx, course.id);
    await age(old.payment_id, 49);
    const checked = await service.initiate(ctx, course.id);
    await age(checked.payment_id, 50);
    await dataSource.getRepository(Payment).update({ id: checked.payment_id }, { verify_checked_at: new Date() });
    const young = await service.initiate(ctx, course.id);
    await age(young.payment_id, 47);
    chapa.verify.mockClear();

    const { expired } = await service.expireAbandonedCheckouts();

    expect(expired).toBeGreaterThanOrEqual(2);
    const asked = (chapa.verify.mock.calls as unknown as string[][]).map(([ref]) => ref);
    expect(asked.indexOf(old.tx_ref)).toBeLessThan(asked.indexOf(checked.tx_ref));
    expect(asked).not.toContain(young.tx_ref);
    expect(await statusOf(old.payment_id)).toBe(PaymentStatus.FAILED);
    expect(await statusOf(checked.payment_id)).toBe(PaymentStatus.FAILED);
    expect(await statusOf(young.payment_id)).toBe(PaymentStatus.PENDING);
    expect((await dataSource.getRepository(Payment).findOneByOrFail({ id: old.payment_id })).method).toBe(PaymentMethod.CHAPA);
  });
});
