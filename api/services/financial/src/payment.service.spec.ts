import { createHmac } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { BrokerPublishError } from '@ethiopialearn/common';
import { PaymentMethod, PaymentPurpose, PaymentStatus } from '@ethiopialearn/contracts';
import { MockChapaProvider } from './chapa.provider';
import { Coupon, Payment, Referral, ReferralCode, Wallet, WalletTransaction } from './entities';
import { GrowthService } from './growth.service';
import { PaymentService } from './payment.service';
import { fakeDb, Row } from './testing/fake-db';

const SECRET = 'test-webhook-secret-0123456789';

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
    expect(t.walletRows('cashback')).toHaveLength(1);
    expect(t.balance('u1')).toBe(25);
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
    const payment = await t.service.recordBankTransfer('adm', { learner_id: 'u1', course_id: 'c1' });
    expect(t.row(payment.id)).toMatchObject({ status: PaymentStatus.CONFIRMED, method: PaymentMethod.BANK_TRANSFER });
    expect(t.published('PaymentConfirmed')).toHaveLength(1);
    expect(t.walletRows('cashback')).toHaveLength(1);
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
