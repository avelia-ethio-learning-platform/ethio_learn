import { createHmac } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { BrokerPublishError } from '@ethiopialearn/common';
import { PaymentMethod, PaymentPurpose, PaymentStatus } from '@ethiopialearn/contracts';
import { MockChapaProvider } from './chapa.provider';
import { Coupon, Payment, Referral, ReferralCode, Wallet, WalletTransaction } from './entities';
import { GrowthService } from './growth.service';
import { PaymentService } from './payment.service';
import { fakeDb, Row, uniqueViolation } from './testing/fake-db';

const SECRET = 'test-webhook-secret-0123456789';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Purchase credits are held for the 7-day refund window plus an hour. */
const HOLD_MS = 7 * DAY_MS + 60 * 60 * 1000;

function sign(raw: Buffer | string, secret = SECRET): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function setup(opts: { chapa?: unknown } = {}) {
  const db = fakeDb();
  const bus = {
    publish: jest.fn().mockResolvedValue(undefined),
    publishConfirmed: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn(),
  };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.includes('/internal/users/')) return { email: 'learner@x.et', name: 'Learner' };
      if (path.includes('/internal/courses/')) return { id: 'c1', title: 'Course', owner_id: 'edu-1', owner_type: 'educator', price_etb: 500, pricing_type: 'paid', status: 'published' };
      if (path.includes('/entitlements')) return { entitlement_status: 'none' };
      throw new Error(`unexpected internal call ${path}`);
    }),
  };
  const chapa = (opts.chapa as never) ?? {
    verify: jest.fn().mockResolvedValue({ status: 'success', amount: 500, currency: 'ETB' }),
    initialize: jest.fn().mockResolvedValue({ checkout_url: 'https://checkout.example/x' }),
    generateTxRef: jest.fn().mockResolvedValue('TX-NEW'),
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
  const payments = db.repo(Payment);
  const row = (id = 'pay-1') => payments.rows.find((p) => p.id === id)!;
  const seed = (over: Row = {}) => {
    const p = {
      id: 'pay-1',
      learner_id: 'u1',
      course_id: 'c1',
      amount_etb: '500.00',
      method: PaymentMethod.CHAPA,
      status: PaymentStatus.PENDING,
      chapa_tx_ref: 'TX-TEST',
      payee_id: 'edu-1',
      payee_type: 'educator',
      course_title: 'Course',
      purpose: PaymentPurpose.COURSE,
      meta: null,
      coupon_code: null,
      webhook_received_at: null,
      effects_completed_at: null,
      created_at: new Date(Date.now() - 10 * 60_000),
      ...over,
    };
    payments.rows.push(p);
    return p;
  };
  const published = (type: string) => [...bus.publish.mock.calls, ...bus.publishConfirmed.mock.calls].filter(([t]) => t === type);
  const walletRows = (kind: string) => db.repo(WalletTransaction).rows.filter((t) => t.kind === kind);
  const balance = (userId: string) => Number(db.repo(Wallet).rows.find((w) => w.user_id === userId)?.balance_etb ?? 0);
  return { db, bus, chapa: chapa as any, internal, growth, service, payments, row, seed, published, walletRows, balance };
}

const successBody = Buffer.from(JSON.stringify({ tx_ref: 'TX-TEST', status: 'success' }));
const failedBody = Buffer.from(JSON.stringify({ tx_ref: 'TX-TEST', status: 'failed' }));
const signed = (raw: Buffer) => ({ 'x-chapa-signature': sign(raw) });

beforeEach(() => {
  process.env.CHAPA_WEBHOOK_SECRET = SECRET;
  delete process.env.CHAPA_MODE;
  delete process.env.CHAPA_SECRET_KEY;
});

afterAll(() => {
  delete process.env.CHAPA_WEBHOOK_SECRET;
});

describe('PaymentService.handleWebhook: signature (x-chapa-signature only)', () => {
  it('rejects a missing or wrong signature without touching the DB', async () => {
    const t = setup();
    t.seed();
    expect(await t.service.handleWebhook(successBody, {})).toEqual({ processed: false, reason: 'invalid signature' });
    expect(await t.service.handleWebhook(successBody, { 'x-chapa-signature': 'a'.repeat(64) })).toEqual({ processed: false, reason: 'invalid signature' });
    expect(t.payments.findOne).not.toHaveBeenCalled();
  });

  it('rejects a signed body whose payload was tampered with', async () => {
    const t = setup();
    t.seed();
    const tampered = Buffer.from(JSON.stringify({ tx_ref: 'TX-TEST', status: 'success', extra: 1 }));
    expect(await t.service.handleWebhook(tampered, signed(successBody))).toEqual({ processed: false, reason: 'invalid signature' });
  });

  it('accepts the signature in upper case and with surrounding spaces', async () => {
    const t = setup();
    t.seed();
    const result = await t.service.handleWebhook(successBody, { 'x-chapa-signature': ` ${sign(successBody).toUpperCase()} ` });
    expect(result).toEqual({ processed: true, reason: 'confirmed' });
  });

  it('ignores chapa-signature, the same constant on every webhook, so it cannot be replayed with another body', async () => {
    const t = setup();
    t.seed();
    const constant = sign(SECRET); // HMAC(secret, secret)
    expect(await t.service.handleWebhook(successBody, { 'chapa-signature': constant })).toEqual({ processed: false, reason: 'invalid signature' });
  });

  it('processes a genuine Chapa request carrying both headers', async () => {
    const t = setup();
    t.seed();
    const result = await t.service.handleWebhook(successBody, { 'chapa-signature': sign(SECRET), 'x-chapa-signature': sign(successBody) });
    expect(result).toEqual({ processed: true, reason: 'confirmed' });
  });

  it('accepts a signature over the re-serialized JSON payload (as Chapa sample code signs it)', async () => {
    const t = setup();
    t.seed();
    const pretty = Buffer.from(JSON.stringify({ tx_ref: 'TX-TEST', status: 'success' }, null, 2));
    const result = await t.service.handleWebhook(pretty, { 'x-chapa-signature': sign(JSON.stringify(JSON.parse(pretty.toString()))) });
    expect(result).toEqual({ processed: true, reason: 'confirmed' });
  });

  it('rejects a signature of the wrong length or alphabet', async () => {
    const t = setup();
    t.seed();
    expect(await t.service.handleWebhook(successBody, { 'x-chapa-signature': sign(successBody).slice(0, 63) })).toMatchObject({ reason: 'invalid signature' });
    expect(await t.service.handleWebhook(successBody, { 'x-chapa-signature': `${sign(successBody).slice(0, 63)}z` })).toMatchObject({ reason: 'invalid signature' });
  });

  it('rejects everything when CHAPA_WEBHOOK_SECRET is not set (no built-in fallback)', async () => {
    const t = setup();
    t.seed();
    delete process.env.CHAPA_WEBHOOK_SECRET;
    expect(await t.service.handleWebhook(successBody, signed(successBody))).toEqual({ processed: false, reason: 'invalid signature' });
  });
});

describe('PaymentService.handleWebhook: confirming and failing', () => {
  it('never trusts the webhook alone: verifies with Chapa, confirms, and publishes PaymentConfirmed with broker confirms', async () => {
    const t = setup();
    t.seed();
    const result = await t.service.handleWebhook(successBody, signed(successBody));

    expect(result).toEqual({ processed: true, reason: 'confirmed' });
    expect(t.chapa.verify).toHaveBeenCalledWith('TX-TEST');
    expect(t.row().status).toBe(PaymentStatus.CONFIRMED);
    expect(t.bus.publishConfirmed).toHaveBeenCalledWith(
      'PaymentConfirmed',
      expect.objectContaining({ payment_id: 'pay-1', tx_ref: 'TX-TEST', amount_etb: 500, learner_email: 'learner@x.et' }),
      { correlationId: 'pay-1' },
    );
    expect(t.row().effects_completed_at).toBeInstanceOf(Date);
  });

  it('marks the payment failed when the verified amount differs from the ledger (tamper guard)', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    t.seed();
    t.chapa.verify.mockResolvedValue({ status: 'success', amount: 5, currency: 'ETB' });
    expect(await t.service.handleWebhook(successBody, signed(successBody))).toEqual({ processed: false, reason: 'amount mismatch' });
    expect(t.row().status).toBe(PaymentStatus.FAILED);
    expect(t.published('PaymentConfirmed')).toHaveLength(0);
  });

  it('marks a non-ETB verification failed', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    t.seed();
    t.chapa.verify.mockResolvedValue({ status: 'success', amount: 500, currency: 'USD' });
    expect(await t.service.handleWebhook(successBody, signed(successBody))).toEqual({ processed: false, reason: 'currency mismatch' });
    expect(t.row().status).toBe(PaymentStatus.FAILED);
  });

  it('in live mode, does not confirm a success that reports no amount (it stays pending for the sweep)', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    t.seed();
    t.chapa.verify.mockResolvedValue({ status: 'success', amount: null, currency: 'ETB' });
    expect(await t.service.handleWebhook(successBody, signed(successBody))).toEqual({ processed: false, reason: 'amount not verified' });
    expect(t.row().status).toBe(PaymentStatus.PENDING);
    expect(t.published('PaymentConfirmed')).toHaveLength(0);
  });

  it('is idempotent: a duplicate webhook on a confirmed tx_ref is a no-op', async () => {
    const t = setup();
    t.seed({ status: PaymentStatus.CONFIRMED });
    expect(await t.service.handleWebhook(successBody, signed(successBody))).toEqual({ processed: true, reason: 'duplicate — already confirmed' });
    expect(t.chapa.verify).not.toHaveBeenCalled();
    expect(t.bus.publishConfirmed).not.toHaveBeenCalled();
  });

  it('never confirms a refunded payment again', async () => {
    const t = setup();
    t.seed({ status: PaymentStatus.REFUNDED });
    await t.service.handleWebhook(successBody, signed(successBody));
    expect(t.row().status).toBe(PaymentStatus.REFUNDED);
    expect(t.published('PaymentConfirmed')).toHaveLength(0);
  });

  it('ignores an unknown tx_ref', async () => {
    const t = setup();
    expect(await t.service.handleWebhook(successBody, signed(successBody))).toEqual({ processed: false, reason: 'unknown tx_ref' });
  });

  it('checks a signed failure webhook with verify(), and fails the payment when Chapa agrees', async () => {
    const t = setup();
    t.seed();
    t.chapa.verify.mockResolvedValue({ status: 'failed', amount: null, currency: null });
    expect(await t.service.handleWebhook(failedBody, signed(failedBody))).toEqual({ processed: true, reason: 'failed' });
    expect(t.chapa.verify).toHaveBeenCalledWith('TX-TEST');
    expect(t.row().status).toBe(PaymentStatus.FAILED);
    expect(t.published('PaymentFailed')).toHaveLength(1);
    expect(t.published('PaymentConfirmed')).toHaveLength(0);
  });

  it('confirms instead when a failure webhook arrives but Chapa says the payment succeeded', async () => {
    const t = setup();
    t.seed();
    expect(await t.service.handleWebhook(failedBody, signed(failedBody))).toEqual({ processed: true, reason: 'confirmed' });
    expect(t.row().status).toBe(PaymentStatus.CONFIRMED);
  });

  it('fails a pending payment once, however many failure signals arrive', async () => {
    const t = setup();
    t.seed();
    t.chapa.verify.mockResolvedValue({ status: 'failed', amount: null, currency: null });
    await Promise.all([t.service.handleWebhook(failedBody, signed(failedBody)), t.service.handleWebhook(failedBody, signed(failedBody))]);
    expect(t.published('PaymentFailed')).toHaveLength(1);
  });

  it('confirms a payment that was marked failed when Chapa later verifies it as paid', async () => {
    const t = setup();
    t.seed({ status: PaymentStatus.FAILED });
    expect(await t.service.handleWebhook(successBody, signed(successBody))).toEqual({ processed: true, reason: 'confirmed' });
    expect(t.row().status).toBe(PaymentStatus.CONFIRMED);
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
  });

  it('answers the webhook even when PaymentFailed cannot be published', async () => {
    const t = setup();
    t.seed();
    t.chapa.verify.mockResolvedValue({ status: 'failed', amount: null, currency: null });
    t.bus.publish.mockRejectedValue(new Error('broker down'));
    await expect(t.service.handleWebhook(failedBody, signed(failedBody))).resolves.toEqual({ processed: true, reason: 'failed' });
  });
});

describe('PaymentService: exactly-once confirmation under races (P0-04)', () => {
  it('webhook and reconcile racing on one top-up credit the wallet once', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    t.seed({ purpose: PaymentPurpose.WALLET_TOPUP, course_id: '00000000-0000-0000-0000-000000000000', payee_id: '00000000-0000-0000-0000-000000000000' });

    const results = await Promise.all([
      t.service.handleWebhook(successBody, signed(successBody)),
      t.service.reconcile({ id: 'u1' } as never, 'TX-TEST'),
      t.service.handleWebhook(successBody, signed(successBody)),
    ]);

    expect(t.walletRows('topup')).toHaveLength(1);
    expect(t.balance('u1')).toBe(500);
    expect(t.published('WalletCredited')).toHaveLength(1);
    // Whichever caller won, the webhooks report confirmed or duplicate, never two confirmations.
    const webhookReasons = [results[0], results[2]].map((r) => (r as { reason: string }).reason);
    expect(webhookReasons.filter((r) => r === 'confirmed').length).toBeLessThanOrEqual(1);
    expect(webhookReasons.every((r) => r === 'confirmed' || r === 'duplicate — already confirmed')).toBe(true);
    expect(results[1]).toMatchObject({ status: PaymentStatus.CONFIRMED }); // reconcile reports the current status
  });

  it('a top-up has no access event to wait for: it is marked done at confirmation', async () => {
    const t = setup();
    t.seed({ purpose: PaymentPurpose.WALLET_TOPUP });
    await t.service.handleWebhook(successBody, signed(successBody));
    expect(t.row().effects_completed_at).toBeInstanceOf(Date);
    expect(t.bus.publishConfirmed).not.toHaveBeenCalled();
  });

  it('a course purchase confirmed twice at once publishes one PaymentConfirmed, one cashback and one coupon use', async () => {
    const t = setup();
    t.db.repo(Coupon).rows.push({ id: 'cp-1', code: 'TEN', uses: 0 });
    t.seed({ coupon_code: 'TEN' });

    await Promise.all([t.service.handleWebhook(successBody, signed(successBody)), t.service.handleWebhook(successBody, signed(successBody))]);

    expect(t.published('PaymentConfirmed')).toHaveLength(1);
    expect(t.walletRows('cashback')).toEqual([expect.objectContaining({ amount_etb: '25.00', state: 'pending', payment_id: 'pay-1' })]);
    expect(t.balance('u1')).toBe(0); // pending until the refund window has passed
    expect(t.db.repo(Coupon).rows[0].uses).toBe(1);
  });

  it('rewards the referrer once on the first confirmed purchase', async () => {
    const t = setup();
    t.db.repo(Referral).rows.push({ id: 'ref-1', referrer_id: 'friend', referred_user_id: 'u1', status: 'signed_up', reward_etb: '0' });
    t.seed();
    await Promise.all([t.service.handleWebhook(successBody, signed(successBody)), t.service.handleWebhook(successBody, signed(successBody))]);
    expect(t.walletRows('referral_reward')).toHaveLength(1);
    expect(t.walletRows('referral_reward')[0].note).toContain('Learner made their first purchase');
  });
});

describe('PaymentService: purchase credits are held until the refund window has passed', () => {
  const learner = { id: 'u1', role: 'learner', email: 'u1@x.et' } as never;
  /** An earlier Chapa purchase by u1 and its 25 ETB cashback, confirmed at confirmedAt. */
  const earnCashback = async (t: ReturnType<typeof setup>, confirmedAt: Date) => {
    const earlier = t.seed({ id: 'pay-0', chapa_tx_ref: 'TX-0', course_id: 'c0', status: PaymentStatus.CONFIRMED, webhook_received_at: confirmedAt });
    await t.db.dataSource.transaction((m) => t.growth.creditCashback(m as never, earlier as Payment, confirmedAt));
  };

  it('holds cashback and the referral reward from the confirmation, not from an earlier failure', async () => {
    const t = setup();
    t.db.repo(Referral).rows.push({ id: 'ref-1', referrer_id: 'friend', referred_user_id: 'u1', status: 'signed_up', reward_etb: '0' });
    const failedAt = new Date(Date.now() - 3 * DAY_MS);
    t.seed({ status: PaymentStatus.FAILED, webhook_received_at: failedAt });

    expect(await t.service.handleWebhook(successBody, signed(successBody))).toEqual({ processed: true, reason: 'confirmed' });

    const confirmedAt: Date = t.row().webhook_received_at;
    expect(confirmedAt.getTime()).toBeGreaterThan(failedAt.getTime());
    const availableAt = new Date(confirmedAt.getTime() + HOLD_MS);
    expect(t.walletRows('cashback')).toEqual([expect.objectContaining({ user_id: 'u1', state: 'pending', available_at: availableAt, payment_id: 'pay-1' })]);
    expect(t.walletRows('referral_reward')).toEqual([
      expect.objectContaining({ user_id: 'friend', reference: 'ref-1', state: 'pending', available_at: availableAt, payment_id: 'pay-1' }),
    ]);
    expect(t.balance('u1')).toBe(0);
    expect(t.balance('friend')).toBe(0);
  });

  it('a wallet purchase can spend cashback once it has matured', async () => {
    const t = setup();
    await t.growth.credit('u1', 480, 'topup', 'pay-top', 'Wallet top-up');
    await earnCashback(t, new Date(Date.now() - 8 * DAY_MS));

    const result = await t.service.initiate(learner, 'c1', { use_wallet: true });

    expect(result).toMatchObject({ confirmed: true, amount_etb: 500 });
    expect(t.balance('u1')).toBe(5);
    expect(t.walletRows('cashback')).toEqual([expect.objectContaining({ state: 'available' })]);
  });

  it('a wallet purchase cannot spend cashback that is still pending', async () => {
    const t = setup();
    await t.growth.credit('u1', 480, 'topup', 'pay-top', 'Wallet top-up');
    await earnCashback(t, new Date());

    await expect(t.service.initiate(learner, 'c1', { use_wallet: true })).rejects.toThrow('Wallet balance (480.00 ETB) is not enough for 500.00 ETB');
    expect(t.balance('u1')).toBe(480);
    expect(t.walletRows('cashback')).toEqual([expect.objectContaining({ state: 'pending' })]);
    expect(t.walletRows('purchase')).toHaveLength(0);
  });

  it('a top-up still lands in the balance at confirmation, with no hold', async () => {
    const t = setup();
    t.seed({ purpose: PaymentPurpose.WALLET_TOPUP });
    await t.service.handleWebhook(successBody, signed(successBody));

    expect(t.balance('u1')).toBe(500);
    expect(t.walletRows('topup')).toEqual([expect.objectContaining({ amount_etb: '500.00', state: 'available', available_at: null, payment_id: null })]);
  });
});

describe('PaymentService: secondary effects never block the confirmation (savepoints)', () => {
  it('a throwing cashback rolls back only its own savepoint: confirmed, coupon counted, access published, error logged', async () => {
    const t = setup();
    t.db.repo(Coupon).rows.push({ id: 'cp-1', code: 'TEN', uses: 0 });
    t.seed({ coupon_code: 'TEN' });
    jest.spyOn(t.growth, 'creditCashback').mockImplementation(async (m, payment) => {
      await t.growth.creditWith(m, payment.learner_id, 25, 'cashback', payment.id, 'half-written');
      throw new Error('cashback bug');
    });
    const error = jest.spyOn((t.service as any).logger, 'error').mockImplementation(() => undefined);

    expect(await t.service.handleWebhook(successBody, signed(successBody))).toEqual({ processed: true, reason: 'confirmed' });

    expect(t.row().status).toBe(PaymentStatus.CONFIRMED);
    expect(t.walletRows('cashback')).toHaveLength(0);
    expect(t.balance('u1')).toBe(0);
    expect(t.db.repo(Coupon).rows[0].uses).toBe(1);
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('payment pay-1: cashback failed'));
  });

  it('a throwing coupon count still lets the top-up credit and the confirmation commit', async () => {
    const t = setup();
    t.seed({ purpose: PaymentPurpose.WALLET_TOPUP, coupon_code: 'GONE' });
    jest.spyOn(t.growth, 'recordCouponUse').mockRejectedValue(new Error('coupon table locked'));
    jest.spyOn((t.service as any).logger, 'error').mockImplementation(() => undefined);

    await t.service.handleWebhook(successBody, signed(successBody));

    expect(t.row().status).toBe(PaymentStatus.CONFIRMED);
    expect(t.balance('u1')).toBe(500);
  });

  it('a failing top-up credit is the purchase itself: the confirmation rolls back and the payment stays pending', async () => {
    const t = setup();
    t.seed({ purpose: PaymentPurpose.WALLET_TOPUP });
    jest.spyOn(t.growth, 'creditWith').mockRejectedValue(new Error('wallet table gone'));
    await expect(t.service.handleWebhook(successBody, signed(successBody))).rejects.toThrow('wallet table gone');
    expect(t.row().status).toBe(PaymentStatus.PENDING);
  });
});

describe('PaymentService: instant settlements go through the same confirmation', () => {
  it('a wallet purchase debits inside the confirmation, once, and pays no cashback', async () => {
    const t = setup();
    await t.growth.credit('u1', 600, 'topup', 'pay-0', 'Wallet top-up');
    const result = await t.service.initiate({ id: 'u1', role: 'learner', email: 'u1@x.et' } as never, 'c1', { use_wallet: true });

    expect(result).toMatchObject({ confirmed: true, checkout_url: null, amount_etb: 500 });
    const payment = t.row(result.payment_id);
    expect(payment).toMatchObject({ status: PaymentStatus.CONFIRMED, method: PaymentMethod.WALLET });
    expect(t.walletRows('purchase')).toEqual([expect.objectContaining({ reference: payment.id, amount_etb: '-500.00' })]);
    expect(t.balance('u1')).toBe(100);
    expect(t.walletRows('cashback')).toHaveLength(0);
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
  });

  it('a wallet purchase the balance cannot cover leaves no debit and no confirmation', async () => {
    const t = setup();
    await t.growth.credit('u1', 100, 'topup', 'pay-0', 'Wallet top-up');
    await expect(t.service.initiate({ id: 'u1', role: 'learner', email: 'u1@x.et' } as never, 'c1', { use_wallet: true })).rejects.toThrow(
      'Wallet balance (100.00 ETB) is not enough for 500.00 ETB',
    );
    expect(t.payments.rows.filter((p) => p.status === PaymentStatus.CONFIRMED)).toHaveLength(0);
    expect(t.walletRows('purchase')).toHaveLength(0);
    expect(t.balance('u1')).toBe(100);
    expect(t.published('PaymentConfirmed')).toHaveLength(0);
  });

  it('a 100% coupon settles as a coupon payment and counts the use once', async () => {
    const t = setup();
    t.db.repo(Coupon).rows.push({ id: 'cp-1', code: 'FREE', kind: 'percent', value: '100', active: true, uses: 0, max_uses: null, expires_at: null, course_id: null });
    const result = await t.service.initiate({ id: 'u1', role: 'learner', email: 'u1@x.et' } as never, 'c1', { coupon_code: 'free' });

    expect(t.row(result.payment_id)).toMatchObject({ status: PaymentStatus.CONFIRMED, method: PaymentMethod.COUPON });
    expect(t.db.repo(Coupon).rows[0].uses).toBe(1);
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
  });

  it('a bank transfer recorded by an admin is confirmed through the same path', async () => {
    const t = setup();
    const { payment, created } = await t.service.recordBankTransfer('adm', { learner_id: 'u1', course_id: 'c1', bank_reference: 'FT-001' });
    expect(created).toBe(true);
    expect(t.row(payment.id)).toMatchObject({ status: PaymentStatus.CONFIRMED, method: PaymentMethod.BANK_TRANSFER, chapa_tx_ref: 'bank-FT-001' });
    expect(t.internal.get).toHaveBeenCalledWith('/api/v1/internal/users/u1');
    expect(t.internal.get).toHaveBeenCalledWith('/api/v1/internal/entitlements?learner_id=u1&course_id=c1');
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
    expect(t.walletRows('cashback')).toHaveLength(1);
  });
});

describe('PaymentService.recordBankTransfer: the bank reference is the idempotency key, and an owned course is refused', () => {
  const transfer = (over: Partial<{ learner_id: string; course_id: string; bank_reference: string }> = {}) => ({
    learner_id: 'u1',
    course_id: 'c1',
    bank_reference: 'FT-001',
    ...over,
  });
  /** Answers the internal lookups whose path contains `match` with `reply`; the rest keep setup()'s answers. */
  const answer = (t: ReturnType<typeof setup>, match: string, reply: () => unknown) => {
    const get = t.internal.get as jest.Mock<Promise<unknown>, [string]>;
    const base = get.getMockImplementation()!;
    get.mockImplementation(async (path) => (path.includes(match) ? reply() : base(path)));
  };
  /** What InternalHttpClient throws: with the status for a non-2xx answer, without one for a network error. */
  const failure = (path: string, status?: number) => new Error(`Internal request failed: GET ${path}${status ? ` -> ${status}` : ''}`);
  const calls = (t: ReturnType<typeof setup>, match: string) => t.internal.get.mock.calls.filter(([path]) => path.includes(match));
  /** Holds every entitlements lookup until `n` submits have reached it, so they all pass checks 1-4 before any inserts. */
  const gateEntitlements = (t: ReturnType<typeof setup>, n: number) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    answer(t, '/entitlements', async () => {
      if (++waiting === n) release();
      await gate;
      return { entitlement_status: 'none' };
    });
  };

  it('a replay of the same reference, learner and course returns the same payment, with one confirmation and one cashback', async () => {
    const t = setup();
    const first = await t.service.recordBankTransfer('adm', transfer());
    // By now the grant has landed: the replay is still answered from the recorded payment.
    answer(t, '/entitlements', () => ({ entitlement_status: 'active' }));

    const again = await t.service.recordBankTransfer('adm', transfer());

    expect(first.created).toBe(true);
    expect(again).toEqual({ payment: expect.objectContaining({ id: first.payment.id, status: PaymentStatus.CONFIRMED }), created: false });
    expect(t.payments.rows).toHaveLength(1);
    expect(t.walletRows('cashback')).toEqual([expect.objectContaining({ payment_id: first.payment.id, state: 'pending' })]);
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
  });

  it.each([PaymentStatus.PENDING, PaymentStatus.FAILED])('a replay of a transfer left %s confirms it then, once', async (status) => {
    const t = setup();
    t.seed({ id: 'pay-b', chapa_tx_ref: 'bank-FT-001', method: PaymentMethod.BANK_TRANSFER, status });

    const replay = await t.service.recordBankTransfer('adm', transfer());
    await t.service.recordBankTransfer('adm', transfer());

    expect(replay).toEqual({ payment: expect.objectContaining({ id: 'pay-b', status: PaymentStatus.CONFIRMED }), created: false });
    expect(t.row('pay-b').status).toBe(PaymentStatus.CONFIRMED);
    expect(t.payments.rows).toHaveLength(1);
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
    expect(t.walletRows('cashback')).toHaveLength(1);
  });

  it('a replay of a refunded transfer returns it as it is', async () => {
    const t = setup();
    t.seed({ id: 'pay-b', chapa_tx_ref: 'bank-FT-001', method: PaymentMethod.BANK_TRANSFER, status: PaymentStatus.REFUNDED });
    expect(await t.service.recordBankTransfer('adm', transfer())).toEqual({ payment: expect.objectContaining({ id: 'pay-b', status: PaymentStatus.REFUNDED }), created: false });
    expect(t.published('PaymentConfirmed')).toHaveLength(0);
  });

  it('the same reference for another learner or another course is a 409', async () => {
    const t = setup();
    await t.service.recordBankTransfer('adm', transfer());
    for (const other of [transfer({ learner_id: 'u2' }), transfer({ course_id: 'c2' })]) {
      await expect(t.service.recordBankTransfer('adm', other)).rejects.toMatchObject({ status: 409, message: 'This bank reference is already recorded for another payment.' });
    }
    expect(t.payments.rows).toHaveLength(1);
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
  });

  it('a learner with a confirmed Chapa payment for the course is a 409, even while the entitlement is not active yet', async () => {
    const t = setup();
    t.seed({ status: PaymentStatus.CONFIRMED, webhook_received_at: new Date() });

    await expect(t.service.recordBankTransfer('adm', transfer())).rejects.toMatchObject({ status: 409, message: 'This learner already paid for the course' });

    expect(t.internal.get).not.toHaveBeenCalled();
    expect(t.payments.rows).toHaveLength(1);
  });

  it('a refunded or unfinished course payment, or a gift the learner bought for someone else, is not a payment for the course', async () => {
    const t = setup();
    t.seed({ id: 'refunded', chapa_tx_ref: 'TX-1', status: PaymentStatus.REFUNDED });
    t.seed({ id: 'failed', chapa_tx_ref: 'TX-2', status: PaymentStatus.FAILED });
    t.seed({ id: 'gift', chapa_tx_ref: 'TX-3', status: PaymentStatus.CONFIRMED, purpose: PaymentPurpose.GIFT });

    const { payment, created } = await t.service.recordBankTransfer('adm', transfer());

    expect(created).toBe(true);
    expect(t.row(payment.id).status).toBe(PaymentStatus.CONFIRMED);
  });

  it('a course the learner owns another way (gift, seat, sponsorship) is a 409', async () => {
    const t = setup();
    answer(t, '/entitlements', () => ({ entitlement_status: 'active' }));
    await expect(t.service.recordBankTransfer('adm', transfer())).rejects.toMatchObject({ status: 409, message: 'This learner already owns the course' });
    expect(t.payments.rows).toHaveLength(0);
  });

  it('an entitlement that was refunded does not count as owned', async () => {
    const t = setup();
    answer(t, '/entitlements', () => ({ entitlement_status: 'refunded' }));
    expect((await t.service.recordBankTransfer('adm', transfer())).created).toBe(true);
  });

  it.each([500, 404, undefined])('an entitlements lookup that fails (%p) is a 503, never a guess', async (status) => {
    const t = setup();
    answer(t, '/entitlements', () => {
      throw failure('/api/v1/internal/entitlements?learner_id=u1&course_id=c1', status);
    });
    await expect(t.service.recordBankTransfer('adm', transfer())).rejects.toMatchObject({ status: 503, message: "Couldn't check enrollment. Try again." });
    expect(t.payments.rows).toHaveLength(0);
  });

  it('an unknown learner is a 404, and enrollment is not checked', async () => {
    const t = setup();
    answer(t, '/internal/users/', () => {
      throw failure('/api/v1/internal/users/u9', 404);
    });
    await expect(t.service.recordBankTransfer('adm', transfer({ learner_id: 'u9' }))).rejects.toMatchObject({ status: 404, message: 'Learner not found' });
    expect(calls(t, '/entitlements')).toHaveLength(0);
    expect(t.payments.rows).toHaveLength(0);
  });

  it.each([500, 503, undefined])('a learner lookup that fails (%p) is a 503', async (status) => {
    const t = setup();
    answer(t, '/internal/users/', () => {
      throw failure('/api/v1/internal/users/u1', status);
    });
    await expect(t.service.recordBankTransfer('adm', transfer())).rejects.toMatchObject({ status: 503 });
    expect(calls(t, '/entitlements')).toHaveLength(0);
    expect(t.payments.rows).toHaveLength(0);
  });

  it('two submits of one transfer at once record one payment: the insert that loses re-reads the winner', async () => {
    const t = setup();
    gateEntitlements(t, 2);

    const results = await Promise.all([t.service.recordBankTransfer('adm', transfer()), t.service.recordBankTransfer('adm', transfer())]);

    expect(t.payments.save).toHaveBeenCalledTimes(2); // both reached the insert; the unique index refused one
    expect(t.payments.rows).toHaveLength(1);
    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(results.map((r) => [r.payment.id, r.payment.status])).toEqual([
      [t.payments.rows[0].id, PaymentStatus.CONFIRMED],
      [t.payments.rows[0].id, PaymentStatus.CONFIRMED],
    ]);
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
    expect(t.walletRows('cashback')).toHaveLength(1);
  });

  it('a submit whose twin recorded and confirmed the transfer after its check 1 gets the replay, not "already paid"', async () => {
    const t = setup();
    const findOne = t.payments.findOne as jest.Mock;
    const base = findOne.getMockImplementation()!;
    let twin!: { payment: Payment; created: boolean };
    // This submit's check 1 finds nothing; then its twin runs to the end before check 2 reads.
    findOne.mockImplementationOnce(async (opts) => {
      const none = await base(opts);
      twin = await t.service.recordBankTransfer('adm', transfer());
      return none;
    });

    const late = await t.service.recordBankTransfer('adm', transfer());

    expect(twin.created).toBe(true);
    expect(late).toEqual({ payment: expect.objectContaining({ id: twin.payment.id, status: PaymentStatus.CONFIRMED }), created: false });
    expect(t.payments.rows).toHaveLength(1);
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
    expect(t.walletRows('cashback')).toHaveLength(1);
  });

  it('a submit whose twin recorded the transfer and got the course granted before its check 4 gets the replay, not "already owns"', async () => {
    const t = setup();
    let twin: Promise<{ payment: Payment; created: boolean }> | undefined;
    // This submit's lookup lets its twin run to the end first, so the grant has landed; the twin's own lookup comes before any grant.
    answer(t, '/entitlements', async () => {
      if (twin) return { entitlement_status: 'none' };
      twin = t.service.recordBankTransfer('adm', transfer());
      await twin;
      return { entitlement_status: 'active' };
    });

    const late = await t.service.recordBankTransfer('adm', transfer());

    const first = await twin!;
    expect(first.created).toBe(true);
    expect(late).toEqual({ payment: expect.objectContaining({ id: first.payment.id, status: PaymentStatus.CONFIRMED }), created: false });
    expect(t.payments.rows).toHaveLength(1);
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
    expect(t.walletRows('cashback')).toHaveLength(1);
  });

  it('a submit that loses the insert to the same reference for another learner is a 409', async () => {
    const t = setup();
    gateEntitlements(t, 2);

    const [won, lost] = await Promise.allSettled([t.service.recordBankTransfer('adm', transfer()), t.service.recordBankTransfer('adm', transfer({ learner_id: 'u2' }))]);

    expect(won).toMatchObject({ status: 'fulfilled', value: { created: true } });
    expect(lost).toMatchObject({ status: 'rejected', reason: { status: 409, message: 'This bank reference is already recorded for another payment.' } });
    expect(t.payments.save).toHaveBeenCalledTimes(2);
    expect(t.payments.rows).toEqual([expect.objectContaining({ learner_id: 'u1', status: PaymentStatus.CONFIRMED })]);
  });

  it('a unique violation with no row behind it is not a replay: it is rethrown', async () => {
    const t = setup();
    t.payments.save.mockRejectedValueOnce(uniqueViolation('payments(chapa_tx_ref)'));
    await expect(t.service.recordBankTransfer('adm', transfer())).rejects.toBeInstanceOf(QueryFailedError);
    expect(t.published('PaymentConfirmed')).toHaveLength(0);
  });
});

describe('PaymentService: no lost access (P0-05)', () => {
  it('when the broker does not acknowledge PaymentConfirmed, the payment stays confirmed and unmarked, and the webhook still succeeds', async () => {
    const t = setup();
    t.db.repo(Coupon).rows.push({ id: 'cp-1', code: 'TEN', uses: 0 });
    t.seed({ coupon_code: 'TEN' });
    t.bus.publishConfirmed.mockRejectedValue(new BrokerPublishError('PaymentConfirmed', 'no acknowledgement within 5000 ms'));

    expect(await t.service.handleWebhook(successBody, signed(successBody))).toEqual({ processed: true, reason: 'confirmed' });
    expect(t.row()).toMatchObject({ status: PaymentStatus.CONFIRMED, effects_completed_at: null });
    expect(t.walletRows('cashback')).toHaveLength(1);
    expect(t.db.repo(Coupon).rows[0].uses).toBe(1);
  });

  it('the cron re-publishes for a confirmed course payment and marks it done', async () => {
    const t = setup();
    t.seed({ status: PaymentStatus.CONFIRMED, webhook_received_at: new Date(Date.now() - 5 * 60_000) });

    expect(await t.service.completePendingEffects()).toEqual({ completed: 1, failed: 0 });
    expect(t.bus.publishConfirmed).toHaveBeenCalledWith('PaymentConfirmed', expect.objectContaining({ payment_id: 'pay-1' }), { correlationId: 'pay-1' });
    expect(t.row().effects_completed_at).toBeInstanceOf(Date);

    await t.service.completePendingEffects();
    expect(t.bus.publishConfirmed).toHaveBeenCalledTimes(1);
  });

  it('the cron leaves done, refunded, pending and just-confirmed payments alone', async () => {
    const t = setup();
    const old = new Date(Date.now() - 5 * 60_000);
    t.seed({ id: 'done', chapa_tx_ref: 'TX-1', status: PaymentStatus.CONFIRMED, webhook_received_at: old, effects_completed_at: old });
    t.seed({ id: 'refunded', chapa_tx_ref: 'TX-2', status: PaymentStatus.REFUNDED, webhook_received_at: old });
    t.seed({ id: 'pending', chapa_tx_ref: 'TX-3', status: PaymentStatus.PENDING });
    t.seed({ id: 'fresh', chapa_tx_ref: 'TX-4', status: PaymentStatus.CONFIRMED, webhook_received_at: new Date() });

    expect(await t.service.completePendingEffects()).toEqual({ completed: 0, failed: 0 });
    expect(t.bus.publishConfirmed).not.toHaveBeenCalled();
  });

  it('the cron runs in mock mode too (unlike the Chapa sweep)', async () => {
    process.env.CHAPA_MODE = 'mock';
    const t = setup();
    t.seed({ status: PaymentStatus.CONFIRMED, webhook_received_at: new Date(Date.now() - 5 * 60_000) });
    expect(await t.service.completePendingEffects()).toEqual({ completed: 1, failed: 0 });
  });

  it('skips a tick while the previous run is still going', async () => {
    const t = setup();
    t.seed({ status: PaymentStatus.CONFIRMED, webhook_received_at: new Date(Date.now() - 5 * 60_000) });
    let release!: () => void;
    t.bus.publishConfirmed.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));

    const first = t.service.completePendingEffects();
    await new Promise((r) => setImmediate(r));
    expect(await t.service.completePendingEffects()).toBeNull();
    release();
    expect(await first).toEqual({ completed: 1, failed: 0 });
    expect(t.bus.publishConfirmed).toHaveBeenCalledTimes(1);
  });

  it('stops the run at the first broker failure, oldest first', async () => {
    const t = setup();
    t.seed({ id: 'older', chapa_tx_ref: 'TX-1', status: PaymentStatus.CONFIRMED, webhook_received_at: new Date(Date.now() - 10 * 60_000) });
    t.seed({ id: 'newer', chapa_tx_ref: 'TX-2', status: PaymentStatus.CONFIRMED, webhook_received_at: new Date(Date.now() - 5 * 60_000) });
    t.bus.publishConfirmed.mockRejectedValue(new BrokerPublishError('PaymentConfirmed', 'channel closed'));
    jest.spyOn((t.service as any).logger, 'warn').mockImplementation(() => undefined);

    expect(await t.service.completePendingEffects()).toEqual({ completed: 0, failed: 0 });
    expect(t.bus.publishConfirmed).toHaveBeenCalledTimes(1);
    expect(t.bus.publishConfirmed.mock.calls[0][1]).toMatchObject({ payment_id: 'older' });
  });

  it('a row failing for its own reason is logged and skipped, so it cannot block the rows behind it', async () => {
    const t = setup();
    t.seed({ id: 'poisoned', chapa_tx_ref: 'TX-1', status: PaymentStatus.CONFIRMED, webhook_received_at: new Date(Date.now() - 10 * 60_000) });
    t.seed({ id: 'healthy', chapa_tx_ref: 'TX-2', status: PaymentStatus.CONFIRMED, webhook_received_at: new Date(Date.now() - 5 * 60_000) });
    t.bus.publishConfirmed.mockImplementation(async (_type: string, payload: { payment_id: string }) => {
      if (payload.payment_id === 'poisoned') throw new TypeError('cannot read the course of a deleted user');
    });
    const error = jest.spyOn((t.service as any).logger, 'error').mockImplementation(() => undefined);

    expect(await t.service.completePendingEffects()).toEqual({ completed: 1, failed: 1 });
    expect(t.row('healthy').effects_completed_at).toBeInstanceOf(Date);
    expect(t.row('poisoned').effects_completed_at).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('payment poisoned'));
  });

  it('runs the registered purpose handler for other purposes and marks the payment done only when it succeeds', async () => {
    const t = setup();
    const old = new Date(Date.now() - 5 * 60_000);
    t.seed({ id: 'gift', chapa_tx_ref: 'TX-1', purpose: PaymentPurpose.GIFT, status: PaymentStatus.CONFIRMED, webhook_received_at: old });
    const handler = jest.fn().mockRejectedValueOnce(new BrokerPublishError('SponsorshipGranted', 'timeout')).mockResolvedValue(undefined);
    t.service.onPurposeConfirmed(PaymentPurpose.GIFT, handler);
    jest.spyOn((t.service as any).logger, 'warn').mockImplementation(() => undefined);

    await t.service.completePendingEffects();
    expect(t.row('gift').effects_completed_at).toBeNull();
    await t.service.completePendingEffects();
    expect(t.row('gift').effects_completed_at).toBeInstanceOf(Date);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(t.bus.publishConfirmed).not.toHaveBeenCalledWith('PaymentConfirmed', expect.anything(), expect.anything());
  });
});

describe('PaymentService.sweepPendingPayments', () => {
  it('confirms a pending payment Chapa reports as successful', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    t.seed();
    await t.service.sweepPendingPayments();
    expect(t.chapa.verify).toHaveBeenCalledWith('TX-TEST');
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
  });

  it('leaves a still-pending payment untouched', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    t.seed();
    t.chapa.verify.mockResolvedValue({ status: 'pending', amount: null, currency: null });
    await t.service.sweepPendingPayments();
    expect(t.row().status).toBe(PaymentStatus.PENDING);
    expect(t.bus.publishConfirmed).not.toHaveBeenCalled();
  });

  it('does nothing in mock mode', async () => {
    process.env.CHAPA_MODE = 'mock';
    const t = setup();
    t.seed();
    await t.service.sweepPendingPayments();
    expect(t.payments.find).not.toHaveBeenCalled();
  });

  /** A failed Chapa payment whose checkout page was opened, such as one a retry of the same purchase superseded. */
  const failedCheckout = (t: ReturnType<typeof setup>, over: Row = {}) =>
    t.seed({ status: PaymentStatus.FAILED, chapa_checkout_url: 'https://checkout.example/old', webhook_received_at: new Date(Date.now() - 5 * 60_000), ...over });

  it('confirms a failed checkout Chapa reports paid, even a superseded one whose retry already settled the purchase', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    failedCheckout(t, { id: 'pay-old', chapa_tx_ref: 'TX-OLD', created_at: new Date(Date.now() - 20 * 60_000) });
    t.seed({ id: 'pay-new', chapa_tx_ref: 'TX-NEW', status: PaymentStatus.CONFIRMED, chapa_checkout_url: 'https://checkout.example/new', effects_completed_at: new Date() });

    await t.service.sweepPendingPayments();

    expect(t.chapa.verify.mock.calls).toEqual([['TX-OLD']]);
    // Both pages paid: a duplicate purchase, now visible to refunds and support.
    expect(t.row('pay-old').status).toBe(PaymentStatus.CONFIRMED);
    expect(t.row('pay-new').status).toBe(PaymentStatus.CONFIRMED);
    expect(t.published('PaymentConfirmed')).toEqual([['PaymentConfirmed', expect.objectContaining({ payment_id: 'pay-old' }), { correlationId: 'pay-old' }]]);
  });

  it.each([
    ['failed', { status: 'failed', amount: null, currency: null }],
    ['still pending', { status: 'pending', amount: null, currency: null }],
  ])('leaves a failed checkout failed, with no event, when Chapa reports it %s', async (_, verification) => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    failedCheckout(t);
    t.chapa.verify.mockResolvedValue(verification);

    await t.service.sweepPendingPayments();

    expect(t.chapa.verify).toHaveBeenCalledWith('TX-TEST');
    expect(t.row().status).toBe(PaymentStatus.FAILED);
    expect(t.bus.publish).not.toHaveBeenCalled();
    expect(t.bus.publishConfirmed).not.toHaveBeenCalled();
  });

  it('never selects a failed checkout Chapa never opened, so a dozen newer ones cannot crowd out a payable one', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    failedCheckout(t, { id: 'payable', chapa_tx_ref: 'TX-PAYABLE', created_at: new Date(Date.now() - 3 * 3600_000) });
    for (let i = 0; i < 12; i++) {
      failedCheckout(t, { id: `never-opened-${i}`, chapa_tx_ref: `TX-NEVER-${i}`, chapa_checkout_url: null, created_at: new Date(Date.now() - (5 + i) * 60_000) });
    }
    failedCheckout(t, { id: 'too-old', chapa_tx_ref: 'TX-TOO-OLD', created_at: new Date(Date.now() - 25 * 3600_000) });

    await t.service.sweepPendingPayments();

    expect(t.chapa.verify.mock.calls).toEqual([['TX-PAYABLE']]);
    expect(t.row('payable').status).toBe(PaymentStatus.CONFIRMED);
  });

  it('sweeps pending payments first, then failed checkouts', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    failedCheckout(t, { id: 'failed', chapa_tx_ref: 'TX-FAILED', created_at: new Date(Date.now() - 5 * 60_000) });
    t.seed({ id: 'pending', chapa_tx_ref: 'TX-PENDING', course_id: 'c2', created_at: new Date(Date.now() - 3 * 3600_000) });

    await t.service.sweepPendingPayments();

    expect(t.chapa.verify.mock.calls).toEqual([['TX-PENDING'], ['TX-FAILED']]);
  });
});

describe('PaymentService.nudgeAbandonedCheckouts: one reminder, and it never writes the status', () => {
  /** A course checkout opened 2 h ago and never paid. */
  const abandoned = (t: ReturnType<typeof setup>) => t.seed({ created_at: new Date(Date.now() - 2 * 3600_000) });

  /** A confirmation (the webhook) lands the first time the job makes the internal call whose path contains `during`. */
  const confirmDuring = (t: ReturnType<typeof setup>, during: string) => {
    const get = t.internal.get.getMockImplementation()!;
    let landed = false;
    t.internal.get.mockImplementation(async (path: string) => {
      if (!landed && path.includes(during)) {
        landed = true;
        await t.service.handleWebhook(successBody, signed(successBody));
      }
      return get(path);
    });
  };

  it('sends an abandoned course checkout one reminder that links back to the course', async () => {
    const t = setup();
    abandoned(t);

    await t.service.nudgeAbandonedCheckouts();

    expect(t.published('PaymentAbandoned')).toEqual([
      ['PaymentAbandoned', expect.objectContaining({ payment_id: 'pay-1', learner_email: 'learner@x.et', resume_url: expect.stringMatching(/\/courses\/c1$/) })],
    ]);
    expect(t.row()).toMatchObject({ status: PaymentStatus.PENDING, nudged_at: expect.any(Date) });
  });

  it('a payment confirmed while ownership is checked (before the claim) stays confirmed and gets no reminder', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    abandoned(t);
    confirmDuring(t, '/entitlements');

    await t.service.nudgeAbandonedCheckouts();

    expect(t.published('PaymentAbandoned')).toHaveLength(0);
    expect(t.row().status).toBe(PaymentStatus.CONFIRMED);
    // Nothing reopened the confirmation, so the sweep has nothing to confirm a second time.
    await t.service.sweepPendingPayments();
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
  });

  it('a payment confirmed after the claim (while the learner is looked up) stays confirmed; the late reminder still goes out', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    abandoned(t);
    confirmDuring(t, '/internal/users/');

    await t.service.nudgeAbandonedCheckouts();

    expect(t.published('PaymentAbandoned')).toHaveLength(1);
    expect(t.row()).toMatchObject({ status: PaymentStatus.CONFIRMED, nudged_at: expect.any(Date) });
    await t.service.sweepPendingPayments();
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
  });

  it('a second run sends nothing, even one that overlaps the first', async () => {
    const t = setup();
    abandoned(t);

    await Promise.all([t.service.nudgeAbandonedCheckouts(), t.service.nudgeAbandonedCheckouts()]);
    await t.service.nudgeAbandonedCheckouts();

    expect(t.published('PaymentAbandoned')).toHaveLength(1);
  });

  it('a learner who already owns the course gets no reminder; the row is claimed and stays pending', async () => {
    const t = setup();
    abandoned(t);
    const get = t.internal.get.getMockImplementation()!;
    t.internal.get.mockImplementation(async (path: string) => (path.includes('/entitlements') ? { entitlement_status: 'active' } : get(path)));

    await t.service.nudgeAbandonedCheckouts();
    await t.service.nudgeAbandonedCheckouts();

    expect(t.published('PaymentAbandoned')).toHaveLength(0);
    expect(t.row()).toMatchObject({ status: PaymentStatus.PENDING, nudged_at: expect.any(Date) });
    expect(t.internal.get.mock.calls.filter(([path]) => path.includes('/entitlements'))).toHaveLength(1);
  });
});

describe('PaymentService.mockComplete', () => {
  afterEach(() => {
    delete process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
  });

  it('delivers a signed webhook that confirms the payment', async () => {
    process.env.CHAPA_MODE = 'mock';
    const t = setup({ chapa: new MockChapaProvider() });
    t.seed();
    expect(await t.service.mockComplete('TX-TEST', 'success')).toEqual({ processed: true, reason: 'confirmed' });
  });

  it('a mock "failed" outcome fails the payment (the mock verify reports what the checkout chose)', async () => {
    process.env.CHAPA_MODE = 'mock';
    const t = setup({ chapa: new MockChapaProvider() });
    t.seed();
    expect(await t.service.mockComplete('TX-TEST', 'failed')).toEqual({ processed: true, reason: 'failed' });
    expect(t.row().status).toBe(PaymentStatus.FAILED);
  });

  it('refuses in production even in mock mode', async () => {
    process.env.CHAPA_MODE = 'mock';
    process.env.NODE_ENV = 'production';
    const t = setup({ chapa: new MockChapaProvider() });
    t.seed();
    await expect(t.service.mockComplete('TX-TEST', 'success')).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.row().status).toBe(PaymentStatus.PENDING);
  });

  it('refuses in live mode', async () => {
    process.env.CHAPA_MODE = 'live';
    const t = setup();
    await expect(t.service.mockComplete('TX-TEST', 'success')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
