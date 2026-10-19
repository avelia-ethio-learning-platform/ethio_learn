import { randomUUID } from 'crypto';
import { DataSource, In, Not, Repository } from 'typeorm';
import { buildTypeOrmOptions } from '@ethiopialearn/common';
import { OwnerType, PaymentMethod, PaymentPurpose, PaymentStatus } from '@ethiopialearn/contracts';
import { entities, migrations, SCHEMA } from './database';
import { Payment, PLATFORM_PAYEE_ID } from './entities';
import { PaymentService } from './payment.service';

/**
 * Phase 9e oracle: the SQL analytics answer the same JSON as the in-memory
 * code they replaced (kept below, in the spec only), on fixtures with whole
 * and half birr amounts, a payee with 12 courses, the admin top-8 cut, and a
 * row just before a UTC month end read over a connection in Addis time.
 *
 * Opt-in: runs only when TEST_DATABASE_URL names a scratch database (the CI
 * e2e job creates one). It runs the financial migrations there and deletes
 * only the rows it created.
 */
const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;

/** The pre-9e `summarize`, verbatim apart from the signature. */
function oldSummarize(rows: Payment[]) {
  const gross = rows.reduce((s, r) => s + Number(r.amount_etb), 0);
  const months: Record<string, { gross_etb: number; count: number }> = {};
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - 11);
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    months[d.toISOString().slice(0, 7)] = { gross_etb: 0, count: 0 };
  }
  const byCourse: Record<string, { course_id: string; course_title: string; count: number; gross_etb: number }> = {};
  for (const r of rows) {
    const key = r.created_at.toISOString().slice(0, 7);
    if (months[key]) {
      months[key].gross_etb = Number((months[key].gross_etb + Number(r.amount_etb)).toFixed(2));
      months[key].count += 1;
    }
    const c = (byCourse[r.course_id] ??= { course_id: r.course_id, course_title: r.course_title, count: 0, gross_etb: 0 });
    c.count += 1;
    c.gross_etb = Number((c.gross_etb + Number(r.amount_etb)).toFixed(2));
  }
  return {
    total_gross_etb: Number(gross.toFixed(2)),
    total_net_etb: Number((gross * 0.8).toFixed(2)),
    payment_count: rows.length,
    by_month: Object.entries(months).map(([month, v]) => ({ month, ...v })),
    by_course: Object.values(byCourse).sort((a, b) => b.gross_etb - a.gross_etb),
  };
}

/** The pre-9e `adminAnalytics` body, minus the wallet stats. */
async function oldAdmin(payments: Repository<Payment>) {
  const rows = await payments.find({ where: { status: PaymentStatus.CONFIRMED }, order: { created_at: 'ASC' } });
  const revenue = rows.filter((r) => r.purpose !== PaymentPurpose.WALLET_TOPUP);
  const summary = oldSummarize(revenue);
  const pending = await payments.count({ where: { status: PaymentStatus.PENDING } });
  const failed = await payments.count({ where: { status: PaymentStatus.FAILED } });
  const byPurpose: Record<string, { count: number; gross_etb: number }> = {};
  for (const r of rows) {
    const b = (byPurpose[r.purpose] ??= { count: 0, gross_etb: 0 });
    b.count += 1;
    b.gross_etb = Number((b.gross_etb + Number(r.amount_etb)).toFixed(2));
  }
  const byMethod: Record<string, number> = {};
  for (const r of revenue) byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
  return {
    ...summary,
    pending_count: pending,
    failed_count: failed,
    by_purpose: byPurpose,
    by_method: byMethod,
    coupon_discount_total_etb: Number(revenue.reduce((s, r) => s + Number(r.discount_etb), 0).toFixed(2)),
  };
}

describeWithDb('Payment analytics in SQL match the in-memory oracle (TEST_DATABASE_URL)', () => {
  let dataSource: DataSource;
  let payments: Repository<Payment>;
  let service: PaymentService;
  const payeeA = randomUUID();
  const payeeB = randomUUID();
  const created: string[] = [];
  const now = new Date();
  /** `monthsAgo` months back, on `day` at `hour` UTC. */
  const at = (monthsAgo: number, day = 10, hour = 12, minute = 0) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, day, hour, minute));
  /** 22:30 UTC on the last day of last month: already next month in Addis (UTC+3). */
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 22, 30));

  async function pay(p: Partial<Payment> & { created_at: Date }) {
    const row = await payments.save(
      payments.create({
        learner_id: randomUUID(),
        course_id: randomUUID(),
        amount_etb: '100',
        method: PaymentMethod.CHAPA,
        status: PaymentStatus.CONFIRMED,
        chapa_tx_ref: `el9e-${randomUUID()}`,
        payee_id: payeeA,
        payee_type: OwnerType.EDUCATOR,
        course_title: 'Course',
        purpose: PaymentPurpose.COURSE,
        discount_etb: '0',
        ...p,
      }),
    );
    created.push(row.id);
    // created_at is a CreateDateColumn: set the fixture time explicitly.
    await payments.update({ id: row.id }, { created_at: p.created_at });
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      ...buildTypeOrmOptions(SCHEMA, entities, migrations),
      url,
      migrationsRun: false,
      logging: false,
      // Every pooled connection in Addis time: month buckets must not follow it.
      extra: { options: '-c TimeZone=Africa/Addis_Ababa' },
    });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await dataSource.runMigrations({ transaction: 'each' });
    payments = dataSource.getRepository(Payment);
    service = new PaymentService(payments, {} as never, {} as never, {} as never, { adminWalletStats: async () => ({}) } as never, dataSource);

    // Payee A: 12 courses, distinct totals, over 13 months (one outside the window).
    for (let c = 0; c < 12; c++) {
      const courseId = randomUUID();
      for (let k = 0; k <= c % 3; k++) {
        await pay({ course_id: courseId, course_title: `A course ${c}`, amount_etb: String(50 * (c + 1) + 0.5 * k), created_at: at((c + k) % 13, 5 + k) });
      }
    }
    await pay({ amount_etb: '333.50', created_at: monthEnd, discount_etb: '25.50', coupon_code: 'HALF', method: PaymentMethod.WALLET });
    // Payee B: a bulk order (its title differs from the course's) and a gift, plus rows the summaries must skip.
    const bulkCourse = randomUUID();
    await pay({ payee_id: payeeB, course_id: bulkCourse, course_title: 'B course × 5 seats', purpose: PaymentPurpose.BULK, amount_etb: '2500', created_at: at(2) });
    await pay({ payee_id: payeeB, course_id: bulkCourse, course_title: 'B course', amount_etb: '500', created_at: at(1) });
    await pay({ payee_id: payeeB, purpose: PaymentPurpose.GIFT, method: PaymentMethod.BANK_TRANSFER, amount_etb: '120.50', created_at: at(0, 1) });
    await pay({ payee_id: PLATFORM_PAYEE_ID, purpose: PaymentPurpose.WALLET_TOPUP, amount_etb: '1000', created_at: at(3) });
    await pay({ status: PaymentStatus.PENDING, amount_etb: '99', created_at: at(0) });
    await pay({ status: PaymentStatus.FAILED, amount_etb: '98', created_at: at(0) });
    await pay({ status: PaymentStatus.REFUNDED, amount_etb: '97', created_at: at(0) });
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    if (created.length) await payments.delete({ id: In(created) });
    await dataSource.destroy();
  });

  it('payeeAnalytics: the same JSON, with all 12 of a payee’s courses', async () => {
    const rows = await payments.find({
      where: { payee_id: In([payeeA]), status: PaymentStatus.CONFIRMED, purpose: Not(PaymentPurpose.WALLET_TOPUP) },
      order: { created_at: 'ASC' },
    });
    const expected = oldSummarize(rows);
    expect(expected.by_course).toHaveLength(13); // the 12 courses and the month-end row's course
    expect(await service.payeeAnalytics([payeeA])).toEqual(expected);
    expect(await service.payeeAnalytics([payeeA, payeeB])).toEqual(
      oldSummarize(
        await payments.find({
          where: { payee_id: In([payeeA, payeeB]), status: PaymentStatus.CONFIRMED, purpose: Not(PaymentPurpose.WALLET_TOPUP) },
          order: { created_at: 'ASC' },
        }),
      ),
    );
  });

  it('buckets by UTC month over an Addis connection: the month-end row stays in last month', async () => {
    const lastMonth = monthEnd.toISOString().slice(0, 7);
    const summary = await service.payeeAnalytics([payeeA]);
    const bucket = summary.by_month.find((m) => m.month === lastMonth)!;
    const [{ tz }] = await dataSource.query(`SELECT current_setting('TimeZone') AS tz`);
    expect(tz).toBe('Africa/Addis_Ababa');
    expect(bucket.count).toBeGreaterThanOrEqual(1);
    expect(summary.by_month).toEqual(oldSummarize(await payments.find({ where: { payee_id: payeeA, status: PaymentStatus.CONFIRMED }, order: { created_at: 'ASC' } })).by_month);
  });

  it('adminAnalytics: the same JSON, with by_course cut to the top 8', async () => {
    const expected = await oldAdmin(payments);
    const { wallet, ...actual } = await service.adminAnalytics();
    expect(wallet).toEqual({});
    expect(actual).toEqual({ ...expected, by_course: expected.by_course.slice(0, 8) });
  });
});
