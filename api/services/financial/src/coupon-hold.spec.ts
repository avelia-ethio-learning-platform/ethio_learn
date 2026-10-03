import { createHmac } from 'crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PaymentMethod, PaymentPurpose, PaymentStatus } from '@ethiopialearn/contracts';
import { BulkPurchase, Coupon, Payment, Referral, ReferralCode, Sponsorship, Wallet, WalletTransaction } from './entities';
import { GrowthService } from './growth.service';
import { PaymentService, SessionInput } from './payment.service';
import { SponsorshipService } from './sponsorship.service';
import { fakeDb, Row } from './testing/fake-db';

const FULLY_USED = 'This coupon has been fully used.';
const ALREADY_USED = "You've already used this coupon.";
const REPLACED = 'A newer checkout for this purchase replaced this one.';
const HELD_BY_YOU = /^This coupon is held by another checkout you started\. Finish paying it, or try again after \d{2}:\d{2}\.$/;

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
/** HH:MM in Addis Ababa (UTC+3 all year) of the moment a hold created at `d` lapses, for a window of `minutes`. */
const holdEnds = (d: Date, minutes = 60) => new Date(d.getTime() + minutes * 60_000 + 3 * 3_600_000).toISOString().slice(11, 16);

const ME = { id: 'u1', role: 'learner', email: 'u1@x.et' } as never;
const SOMEONE = { id: 'u2', role: 'learner', email: 'u2@x.et' } as never;

function setup() {
  const db = fakeDb();
  const course = { id: 'c1', title: 'Course', owner_id: 'edu-1', owner_type: 'educator', price_etb: 500, pricing_type: 'paid', status: 'published' };
  const bus = {
    publish: jest.fn().mockResolvedValue(undefined),
    publishConfirmed: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn(),
  };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.includes('/by-email/')) throw new Error('404');
      if (path.includes('/internal/users/')) return { email: 'u1@x.et', name: 'Learner' };
      if (path.includes('/internal/courses/')) return { ...course };
      if (path.includes('/entitlements')) return { entitlement_status: 'none' };
      throw new Error(`unexpected internal call ${path}`);
    }),
  };
  let refs = 0;
  const chapa = {
    generateTxRef: jest.fn(async () => `TX-${++refs}`),
    initialize: jest.fn(async (o: { tx_ref: string }) => ({ checkout_url: `https://checkout.example/${o.tx_ref}` })),
    verify: jest.fn().mockResolvedValue({ status: 'success', amount: 250, currency: 'ETB' }),
  };
  const growth = new GrowthService(
    db.repo(Coupon) as never,
    db.repo(Wallet) as never,
    db.repo(WalletTransaction) as never,
    db.repo(ReferralCode) as never,
    db.repo(Referral) as never,
    db.dataSource as never,
    bus as never,
    internal as never,
  );
  const service = new PaymentService(db.repo(Payment) as never, chapa as never, bus as never, internal as never, growth, db.dataSource as never);
  const sponsorships = new SponsorshipService(db.repo(Sponsorship) as never, db.repo(BulkPurchase) as never, service, bus as never, internal as never);
  const coupons = db.repo(Coupon);
  const payments = db.repo(Payment);

  const coupon = (over: Row = {}) => {
    const c = { id: 'cp-1', code: 'HALF', kind: 'percent', value: '50', active: true, uses: 0, max_uses: 1, max_uses_per_user: null, expires_at: null, course_id: null, ...over };
    coupons.rows.push(c);
    return c;
  };
  /** An open checkout with the coupon (someone else's, unless `learner_id` says otherwise). */
  const hold = (over: Row = {}) => {
    const p = {
      id: `held-${payments.rows.length + 1}`,
      learner_id: 'u9',
      course_id: 'c1',
      amount_etb: '250.00',
      method: PaymentMethod.CHAPA,
      status: PaymentStatus.PENDING,
      chapa_tx_ref: `TX-HELD-${payments.rows.length + 1}`,
      chapa_checkout_url: 'https://checkout.example/held',
      payee_id: 'edu-1',
      payee_type: 'educator',
      course_title: 'Course',
      purpose: PaymentPurpose.COURSE,
      meta: null,
      coupon_code: 'HALF',
      webhook_received_at: null,
      effects_completed_at: null,
      created_at: minutesAgo(10),
      ...over,
    };
    payments.rows.push(p);
    return p;
  };
  const buy = (ctx: never = ME, opts: { coupon_code?: string; use_wallet?: boolean } = {}) => service.initiate(ctx, 'c1', { coupon_code: 'half', ...opts });
  const session = (over: Partial<SessionInput> = {}) =>
    service.createSession({
      payer: ME,
      purpose: PaymentPurpose.COURSE,
      courseId: 'c1',
      courseTitle: 'Course',
      listPriceEtb: 500,
      payee: { id: 'edu-1', type: 'educator' as never },
      couponCode: 'HALF',
      ...over,
    });
  const row = (id: string) => payments.rows.find((p) => p.id === id)!;
  const published = (type: string) => [...bus.publish.mock.calls, ...bus.publishConfirmed.mock.calls].filter(([t]) => t === type);
  const refusal = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => {
        throw new Error('expected the checkout to be refused');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as { statusCode: number; message: string; error: string; checkout_url?: string };
  };
  return { db, bus, chapa, internal, course, growth, service, sponsorships, coupons, payments, coupon, hold, buy, session, row, published, refusal };
}

const SECRET = 'test-webhook-secret-0123456789';
const ENV_KEYS = ['COUPON_HOLD_MINUTES', 'CHAPA_MODE', 'CHAPA_SECRET_KEY', 'CHAPA_FALLBACK_EMAIL', 'CHAPA_WEBHOOK_SECRET'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  // A local api/.env is loaded on import: start every test from the defaults.
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.CHAPA_WEBHOOK_SECRET = SECRET;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('coupon checkout: the hold under the coupon lock (P1-13)', () => {
  it('locks the coupon row in a transaction and inserts the payment as its hold', async () => {
    const t = setup();
    t.coupon();
    const result = await t.buy();

    expect(t.coupons.findOne).toHaveBeenCalledWith({ where: { code: 'HALF' }, lock: { mode: 'pessimistic_write' } });
    expect(t.db.dataSource.transaction).toHaveBeenCalled();
    expect(t.row(result.payment_id)).toMatchObject({ status: PaymentStatus.PENDING, coupon_code: 'HALF', amount_etb: '250.00' });
    expect(result).toMatchObject({ confirmed: false, checkout_url: `https://checkout.example/${result.tx_ref}`, amount_etb: 250, discount_etb: 250 });
  });

  it('an open checkout by someone else holds the last use', async () => {
    const t = setup();
    t.coupon();
    t.hold();
    expect(await t.refusal(t.buy())).toMatchObject({ statusCode: 400, message: FULLY_USED });
    expect(t.payments.rows).toHaveLength(1);
    expect(t.chapa.initialize).not.toHaveBeenCalled();
  });

  it('a hold older than the window has lapsed and frees the use', async () => {
    const t = setup();
    t.coupon();
    t.hold({ created_at: minutesAgo(61) });
    await expect(t.buy()).resolves.toMatchObject({ confirmed: false, checkout_url: expect.any(String) });
  });

  it('COUPON_HOLD_MINUTES sets the window', async () => {
    process.env.COUPON_HOLD_MINUTES = '10';
    const t = setup();
    t.coupon({ max_uses: 2 });
    t.hold({ created_at: minutesAgo(15) });
    t.hold({ created_at: minutesAgo(5) });
    await expect(t.buy()).resolves.toMatchObject({ confirmed: false });
    expect((await t.refusal(t.buy(SOMEONE))).message).toBe(FULLY_USED);
  });

  it('confirmed uses and open holds add up to max_uses', async () => {
    const t = setup();
    t.coupon({ max_uses: 3, uses: 1 });
    t.hold({ status: PaymentStatus.CONFIRMED, created_at: minutesAgo(600) });
    t.hold();
    await expect(t.buy()).resolves.toMatchObject({ confirmed: false });
    expect((await t.refusal(t.buy(SOMEONE))).message).toBe(FULLY_USED);
  });

  it('a rolled-back uses + 1 still counts through the confirmed payments', async () => {
    const t = setup();
    t.coupon({ uses: 0 });
    t.hold({ status: PaymentStatus.CONFIRMED, created_at: minutesAgo(600) });
    expect((await t.refusal(t.buy())).message).toBe(FULLY_USED);
  });

  it('a failed payment with the coupon is no hold', async () => {
    const t = setup();
    t.coupon();
    t.hold({ status: PaymentStatus.FAILED });
    await expect(t.buy()).resolves.toMatchObject({ confirmed: false });
  });

  it('re-checks under the lock that the coupon is still active and unexpired', async () => {
    const t = setup();
    const c = t.coupon({ max_uses: null });
    const quote = t.growth.quote.bind(t.growth);
    jest.spyOn(t.growth, 'quote').mockImplementationOnce(async (...args) => {
      const q = await quote(...args);
      c.active = false; // deactivated between the quote and the lock
      return q;
    });
    expect((await t.refusal(t.buy())).message).toBe('This coupon code is not valid');
    expect(t.payments.rows).toHaveLength(0);
  });
});

describe('coupon checkout: the 100% path is counted before it settles', () => {
  it('an open hold refuses a 100% checkout, which settles nothing', async () => {
    const t = setup();
    t.coupon({ code: 'FREE', value: '100' });
    t.hold({ coupon_code: 'FREE', amount_etb: '0.00' });
    expect((await t.refusal(t.buy(ME, { coupon_code: 'free' }))).message).toBe(FULLY_USED);
    expect(t.payments.rows.filter((p) => p.status === PaymentStatus.CONFIRMED)).toHaveLength(0);
    expect(t.published('PaymentConfirmed')).toHaveLength(0);
    expect(t.coupons.rows[0].uses).toBe(0);
  });

  it('the first 100% checkout settles and counts, the next one is refused', async () => {
    const t = setup();
    t.coupon({ code: 'FREE', value: '100' });
    const first = await t.buy(ME, { coupon_code: 'free' });
    expect(first).toMatchObject({ confirmed: true, checkout_url: null, amount_etb: 0 });
    expect(t.row(first.payment_id)).toMatchObject({ status: PaymentStatus.CONFIRMED, method: PaymentMethod.COUPON });
    expect(t.coupons.rows[0].uses).toBe(1);
    expect((await t.refusal(t.buy(SOMEONE, { coupon_code: 'free' }))).message).toBe(FULLY_USED);
  });

  it('a 100% checkout superseded by a concurrent retry before it settles is refused, so the purchase settles once', async () => {
    const t = setup();
    t.coupon({ code: 'FREE', value: '100' });
    const confirm = (t.service as any).confirmPayment.bind(t.service);
    jest.spyOn(t.service as any, 'confirmPayment').mockImplementationOnce(async (payment: any, source: unknown) => {
      // The retry took the coupon lock first and superseded this row.
      await t.payments.update({ id: payment.id, status: PaymentStatus.PENDING }, { status: PaymentStatus.FAILED });
      return confirm(payment, source);
    });
    await expect(t.buy(ME, { coupon_code: 'free' })).rejects.toBeInstanceOf(ConflictException);
    expect(t.payments.rows[0].status).toBe(PaymentStatus.FAILED);
    expect(t.coupons.rows[0].uses).toBe(0);
    expect(t.published('PaymentConfirmed')).toHaveLength(0);
  });
});

describe('coupon checkout: the per-user limit', () => {
  it("refuses a payer who has used the coupon up to the limit, and lets another payer use it", async () => {
    const t = setup();
    t.coupon({ max_uses: null, max_uses_per_user: 1 });
    t.hold({ learner_id: 'u1', status: PaymentStatus.CONFIRMED, created_at: minutesAgo(600) });
    expect(await t.refusal(t.buy())).toMatchObject({ statusCode: 400, message: ALREADY_USED });
    await expect(t.buy(SOMEONE)).resolves.toMatchObject({ confirmed: false });
  });

  it('allows uses up to the limit', async () => {
    const t = setup();
    t.coupon({ max_uses: null, max_uses_per_user: 2 });
    t.hold({ learner_id: 'u1', status: PaymentStatus.CONFIRMED, created_at: minutesAgo(600) });
    await expect(t.buy()).resolves.toMatchObject({ confirmed: false });
  });

  it("counts the payer's open checkout for another purchase, and says it is theirs", async () => {
    const t = setup();
    t.coupon({ max_uses: null, max_uses_per_user: 1 });
    const gift = t.hold({ learner_id: 'u1', purpose: PaymentPurpose.GIFT, meta: { sponsorship_id: 's-1' }, chapa_checkout_url: 'https://checkout.example/gift' });
    const body = await t.refusal(t.buy());
    expect(body.message).toMatch(HELD_BY_YOU);
    expect(body.message).toContain(`try again after ${holdEnds(gift.created_at)}.`);
    expect(body.checkout_url).toBe('https://checkout.example/gift');
  });
});

describe('coupon checkout: every failure after the insert releases the hold', () => {
  it('a failed Chapa open fails the row and frees the use, with no failure notice', async () => {
    const t = setup();
    t.coupon();
    t.chapa.initialize.mockRejectedValueOnce(new Error('Chapa could not start this checkout. Please try again.'));
    await expect(t.buy()).rejects.toThrow('Chapa could not start this checkout. Please try again.');
    expect(t.payments.rows[0].status).toBe(PaymentStatus.FAILED);
    expect(t.published('PaymentFailed')).toHaveLength(0);

    await expect(t.buy(SOMEONE)).resolves.toMatchObject({ confirmed: false, checkout_url: expect.any(String) });
  });

  it('a too-low wallet balance fails the row with no failure notice, and switching to Chapa then works', async () => {
    const t = setup();
    t.coupon();
    await t.growth.credit('u1', 100, 'topup', 'pay-0', 'Wallet top-up');
    await expect(t.buy(ME, { use_wallet: true })).rejects.toThrow('Wallet balance (100.00 ETB) is not enough for 250.00 ETB');
    expect(t.payments.rows[0].status).toBe(PaymentStatus.FAILED);
    expect(t.published('PaymentFailed')).toHaveLength(0);

    const retry = await t.buy();
    expect(retry).toMatchObject({ confirmed: false, checkout_url: expect.any(String) });
    expect(retry.payment_id).not.toBe(t.payments.rows[0].id);
  });

  it('any other throw before the checkout is returned fails the row and rethrows', async () => {
    const t = setup();
    t.coupon();
    const update = t.payments.update.getMockImplementation()!;
    t.payments.update.mockImplementation(async (where: Row, patch: Row) => {
      if ('chapa_checkout_url' in patch) throw new Error('connection reset');
      return update(where, patch);
    });
    await expect(t.buy()).rejects.toThrow('connection reset');
    expect(t.payments.rows[0].status).toBe(PaymentStatus.FAILED);
    expect(t.published('PaymentFailed')).toEqual([['PaymentFailed', expect.objectContaining({ reason: 'error' })]]);
  });
});

describe('coupon checkout: retries of the same purchase', () => {
  it('an abandoned course checkout retried with Chapa gets the same checkout back', async () => {
    const t = setup();
    t.coupon();
    const first = await t.buy();
    const retry = await t.buy();
    expect(retry).toEqual(first);
    expect(t.payments.rows).toHaveLength(1);
    expect(t.chapa.initialize).toHaveBeenCalledTimes(1);
  });

  it('the same retry after a price change supersedes the old checkout and opens a new one', async () => {
    const t = setup();
    t.coupon();
    const first = await t.buy();
    t.course.price_etb = 600;
    const retry = await t.buy();
    expect(retry).toMatchObject({ amount_etb: 300, checkout_url: `https://checkout.example/${retry.tx_ref}` });
    expect(retry.payment_id).not.toBe(first.payment_id);
    expect(t.row(first.payment_id).status).toBe(PaymentStatus.FAILED);
    expect(t.row(retry.payment_id).status).toBe(PaymentStatus.PENDING);
    expect(t.published('PaymentFailed')).toHaveLength(0);
  });

  it('a retry with the wallet supersedes the open checkout and settles', async () => {
    const t = setup();
    t.coupon();
    await t.growth.credit('u1', 600, 'topup', 'pay-0', 'Wallet top-up');
    const first = await t.buy();
    const retry = await t.buy(ME, { use_wallet: true });
    expect(retry).toMatchObject({ confirmed: true, checkout_url: null });
    expect(t.row(first.payment_id).status).toBe(PaymentStatus.FAILED);
    expect(t.row(retry.payment_id)).toMatchObject({ status: PaymentStatus.CONFIRMED, method: PaymentMethod.WALLET });
    expect(t.coupons.rows[0].uses).toBe(1);
    expect(t.published('PaymentFailed')).toHaveLength(0);
  });

  it("a superseded checkout paid late still confirms through Chapa's webhook and verify", async () => {
    const t = setup();
    t.coupon({ max_uses: null });
    const first = await t.buy();
    t.course.price_etb = 600;
    await t.buy();
    expect(t.row(first.payment_id).status).toBe(PaymentStatus.FAILED);

    const raw = Buffer.from(JSON.stringify({ tx_ref: first.tx_ref, status: 'success' }));
    const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
    await expect(t.service.handleWebhook(raw, { 'x-chapa-signature': signature })).resolves.toEqual({ processed: true, reason: 'confirmed' });
    expect(t.row(first.payment_id).status).toBe(PaymentStatus.CONFIRMED);
    expect(t.coupons.rows[0].uses).toBe(1);
  });

  it('a Chapa checkout superseded by a double-click while Chapa answers is refused with a 409 and its URL is never handed out', async () => {
    const t = setup();
    t.coupon();
    let second: Awaited<ReturnType<typeof t.buy>> | undefined;
    t.chapa.initialize.mockImplementationOnce(async (o: { tx_ref: string }) => {
      // The second click takes the coupon lock while Chapa is still answering
      // the first: the first row has no URL yet, so the second supersedes it.
      second = await t.buy();
      return { checkout_url: `https://checkout.example/${o.tx_ref}` };
    });

    const err = await t.buy().then(
      () => {
        throw new Error('expected the superseded checkout to be refused');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toBe(REPLACED);
    const first = t.payments.rows.find((p) => p.id !== second!.payment_id)!;
    expect(first.status).toBe(PaymentStatus.FAILED);
    expect(first.chapa_checkout_url ?? null).toBeNull();
    expect(t.row(second!.payment_id)).toMatchObject({ status: PaymentStatus.PENDING, chapa_checkout_url: second!.checkout_url });
    expect(t.published('PaymentFailed')).toHaveLength(0);
  });

  it('a confirmation takes the coupon lock before it claims the payment, the order a checkout uses', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    t.coupon({ max_uses: null });
    const first = await t.buy();
    t.coupons.findOne.mockClear();
    t.payments.update.mockClear();

    await t.service.reconcile(ME, first.tx_ref);
    expect(t.coupons.findOne).toHaveBeenCalledWith({ where: { code: 'HALF' }, lock: { mode: 'pessimistic_write' } });
    const claim = t.payments.update.mock.calls.findIndex(([, patch]) => patch.status === PaymentStatus.CONFIRMED);
    expect(t.coupons.findOne.mock.invocationCallOrder[0]).toBeLessThan(t.payments.update.mock.invocationCallOrder[claim]);
  });
});

describe('coupon checkout: a superseded checkout paid late, checked from the return page', () => {
  /** A course checkout with a live Chapa URL, then superseded by a retry after a price change. */
  const superseded = async (t: ReturnType<typeof setup>) => {
    const first = await t.buy();
    t.course.price_etb = 600;
    await t.buy();
    expect(t.row(first.payment_id)).toMatchObject({ status: PaymentStatus.FAILED, chapa_checkout_url: first.checkout_url });
    return first;
  };

  it('reconcile verifies it and confirms it when Chapa says paid, counting the use once', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    t.coupon({ max_uses: null });
    const first = await superseded(t);

    await expect(t.service.reconcile(ME, first.tx_ref)).resolves.toMatchObject({ id: first.payment_id, status: PaymentStatus.CONFIRMED });
    expect(t.chapa.verify).toHaveBeenCalledWith(first.tx_ref);
    expect(t.row(first.payment_id).status).toBe(PaymentStatus.CONFIRMED);
    expect(t.coupons.rows[0].uses).toBe(1);

    // The return page checks again: already confirmed, nothing happens twice.
    await expect(t.service.reconcile(ME, first.tx_ref)).resolves.toMatchObject({ status: PaymentStatus.CONFIRMED });
    expect(t.chapa.verify).toHaveBeenCalledTimes(1);
    expect(t.coupons.rows[0].uses).toBe(1);
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
  });

  it.each([
    ['failed', { status: 'failed', amount: null, currency: null }],
    ['still pending', { status: 'pending', amount: null, currency: null }],
    ['paid a different amount', { status: 'success', amount: 1, currency: 'ETB' }],
  ])('reconcile verifies it and leaves it failed, with no notice, when Chapa says it %s', async (_, verification) => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    t.coupon({ max_uses: null });
    const first = await superseded(t);
    t.chapa.verify.mockResolvedValue(verification);

    await expect(t.service.reconcile(ME, first.tx_ref)).resolves.toMatchObject({ id: first.payment_id, status: PaymentStatus.FAILED });
    expect(t.chapa.verify).toHaveBeenCalledWith(first.tx_ref);
    expect(t.row(first.payment_id).status).toBe(PaymentStatus.FAILED);
    expect(t.coupons.rows[0].uses).toBe(0);
    expect(t.published('PaymentFailed')).toHaveLength(0);
    expect(t.published('PaymentConfirmed')).toHaveLength(0);
  });

  it.each([
    ['a checkout that failed before Chapa opened it', { method: PaymentMethod.CHAPA }],
    ['a wallet attempt', { method: PaymentMethod.WALLET }],
    ['a 100% coupon attempt', { method: PaymentMethod.COUPON, amount_etb: '0.00' }],
  ])('reconcile never asks Chapa about a failed row without a checkout URL: %s', async (_, over) => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    t.coupon({ max_uses: null });
    const p = t.hold({ learner_id: 'u1', status: PaymentStatus.FAILED, chapa_checkout_url: null, ...over });

    await expect(t.service.reconcile(ME, p.chapa_tx_ref)).resolves.toMatchObject({ id: p.id, status: PaymentStatus.FAILED });
    expect(t.chapa.verify).not.toHaveBeenCalled();
  });
});

describe('coupon checkout: the supersede log', () => {
  /** Captures the service's log lines, each with whether a transaction was open when it was written. */
  const watchLogs = (t: ReturnType<typeof setup>) => {
    const transaction = t.db.dataSource.transaction as jest.Mock;
    const run = transaction.getMockImplementation()!;
    let open = 0;
    transaction.mockImplementation(async (fn: unknown) => {
      open += 1;
      try {
        return await run(fn);
      } finally {
        open -= 1;
      }
    });
    const lines: Array<{ message: string; inTransaction: boolean }> = [];
    jest.spyOn((t.service as any).logger, 'log').mockImplementation((message: unknown) => {
      lines.push({ message: String(message), inTransaction: open > 0 });
    });
    return lines;
  };

  it('logs a superseded checkout only after the transaction commits, naming the checkout that replaced it', async () => {
    const t = setup();
    t.coupon();
    const first = await t.buy();
    t.course.price_etb = 600;
    const lines = watchLogs(t);
    const retry = await t.buy();

    expect(lines.filter((l) => l.message.startsWith(`payment ${first.payment_id} `))).toEqual([
      { message: expect.stringContaining(`superseded by payment ${retry.payment_id}`), inTransaction: false },
    ]);
  });

  it('logs nothing about a supersede that a later refusal in the same transaction rolls back', async () => {
    const t = setup();
    // uses + 1 rolled back on a confirmed payment: the quote passes, the count under the lock refuses.
    t.coupon({ max_uses: 1, uses: 0 });
    t.hold({ status: PaymentStatus.CONFIRMED, created_at: minutesAgo(600) });
    const mine = t.hold({ learner_id: 'u1' });
    t.course.price_etb = 600;
    const lines = watchLogs(t);

    expect((await t.refusal(t.buy())).message).toBe(FULLY_USED);
    expect(t.row(mine.id).status).toBe(PaymentStatus.PENDING);
    expect(lines.filter((l) => l.message.startsWith(`payment ${mine.id} `))).toEqual([]);
  });

  it('a fail outside a transaction still logs itself', async () => {
    const t = setup();
    t.coupon();
    const lines = watchLogs(t);
    t.chapa.initialize.mockRejectedValueOnce(new Error('Chapa could not start this checkout. Please try again.'));
    await expect(t.buy()).rejects.toThrow('Chapa could not start this checkout.');

    const [p] = t.payments.rows;
    expect(lines).toContainEqual({ message: `payment ${p.id} (${p.chapa_tx_ref}) marked failed via checkout (checkout_open_failed)`, inTransaction: false });
  });
});

describe('coupon checkout: different purchases by the same payer', () => {
  it('a second gift of the course to another recipient is refused as held by your own checkout, and the first is untouched', async () => {
    const t = setup();
    t.coupon();
    const first = await t.sponsorships.createGift(ME, { course_id: 'c1', recipient_email: 'a@x.et', coupon_code: 'HALF' });
    const before = { ...t.row(first.payment_id) };

    const body = await t.refusal(t.sponsorships.createGift(ME, { course_id: 'c1', recipient_email: 'b@x.et', coupon_code: 'HALF' }));
    expect(body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: `This coupon is held by another checkout you started. Finish paying it, or try again after ${holdEnds(before.created_at)}.`,
      checkout_url: first.checkout_url,
    });
    expect(t.row(first.payment_id)).toEqual(before);
    expect(t.payments.rows).toHaveLength(1);
    expect(t.chapa.initialize).toHaveBeenCalledTimes(1);
  });

  it('leaves checkout_url out of the refusal when the blocking checkout has none', async () => {
    const t = setup();
    t.coupon();
    t.hold({ learner_id: 'u1', purpose: PaymentPurpose.GIFT, meta: { sponsorship_id: 's-1' }, chapa_checkout_url: null });
    const body = await t.refusal(t.buy());
    expect(body.message).toMatch(HELD_BY_YOU);
    expect(body).not.toHaveProperty('checkout_url');
  });

  it('a new bulk order while an earlier one is open gets its own row, never the old checkout', async () => {
    const t = setup();
    t.coupon({ max_uses: null });
    const bulk = (id: string) => t.session({ purpose: PaymentPurpose.BULK, meta: { bulk_purchase_id: id, seats: 5 } });
    const first = await bulk('b-1');
    const second = await bulk('b-2');
    expect(second.payment_id).not.toBe(first.payment_id);
    expect(second.checkout_url).not.toBe(first.checkout_url);
    expect(t.row(first.payment_id).status).toBe(PaymentStatus.PENDING);
    expect(t.row(second.payment_id).status).toBe(PaymentStatus.PENDING);
    // The same order retried is the same purchase.
    expect(await bulk('b-1')).toEqual(first);
  });

  it('a course bought for oneself is a different purchase from a gift of it', async () => {
    const t = setup();
    t.coupon({ max_uses: null });
    const gift = t.hold({ learner_id: 'u1', purpose: PaymentPurpose.GIFT, meta: { sponsorship_id: 's-1' } });
    await expect(t.buy()).resolves.toMatchObject({ confirmed: false });
    expect(t.row(gift.id).status).toBe(PaymentStatus.PENDING);
  });
});

describe('coupon checkout: no failure notice for the internal reasons', () => {
  it('a gateway failure of a course payment still notifies the learner', async () => {
    const t = setup();
    t.coupon({ max_uses: null });
    t.hold({ learner_id: 'u1', chapa_tx_ref: 'TX-TEST' });
    t.chapa.verify.mockResolvedValue({ status: 'failed', amount: null, currency: null });
    process.env.CHAPA_MODE = 'live';
    await t.service.reconcile(ME, 'TX-TEST');
    expect(t.published('PaymentFailed')).toEqual([['PaymentFailed', expect.objectContaining({ reason: 'failed' })]]);
  });
});
