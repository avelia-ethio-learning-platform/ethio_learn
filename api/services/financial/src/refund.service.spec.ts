import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EntitlementStatus, PaymentStatus, RefundStatus } from '@ethiopialearn/contracts';
import { Coupon, Payment, Referral, ReferralCode, RefundRequest, Wallet, WalletTransaction } from './entities';
import { GrowthService } from './growth.service';
import { RefundService } from './refund.service';
import { fakeDb } from './testing/fake-db';

const DAY = 86_400_000;
/** Purchase credits are held for the 7-day refund window plus an hour (GrowthService). */
const HOLD_MS = 7 * DAY + 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ctx = { id: 'u1', role: 'learner', email: 'l@e.et' } as never;
const ALREADY_OPEN = 'A refund is already open for this payment';
const PAID_OUT = 'This payment has already been paid out to the educator. Contact support from Help to request a refund.';

interface Options {
  paymentStatus?: PaymentStatus;
  learnerId?: string;
  /** When the payment was confirmed: the refund window's clock. */
  confirmedDaysAgo?: number;
  /** The enrollment's own date; it doesn't move the window (a re-purchase reuses the old enrollment). Defaults to the confirmation. */
  enrolledDaysAgo?: number;
  payoutId?: string;
  /** No enrollment yet: the grant hasn't happened (or hasn't been consumed). */
  noEnrollment?: boolean;
  /** The enrollment's entitlement; active unless set (refunded: a re-purchase whose grant isn't consumed yet). */
  entitlementStatus?: EntitlementStatus;
  progress?: number;
  certificateIssued?: boolean;
  assessmentPassed?: boolean;
}

function setup(opts: Options = {}) {
  const db = fakeDb();
  const payments = db.repo(Payment);
  const refunds = db.repo(RefundRequest);
  const confirmedAt = ago((opts.confirmedDaysAgo ?? 1) * DAY);
  payments.rows.push({
    id: 'pay-1',
    learner_id: opts.learnerId ?? 'u1',
    course_id: 'c1',
    course_title: 'Course',
    amount_etb: '500.00',
    status: opts.paymentStatus ?? PaymentStatus.CONFIRMED,
    chapa_tx_ref: 'TX-1',
    purpose: 'course',
    method: 'chapa',
    payout_id: opts.payoutId ?? null,
    refund_requested_at: null,
    webhook_received_at: confirmedAt,
    created_at: new Date(confirmedAt.getTime() - 5 * 60_000), // the checkout opened a few minutes earlier
  });
  const bus = { publish: jest.fn().mockResolvedValue(undefined) };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.startsWith('/api/v1/internal/entitlements')) {
        if (opts.noEnrollment) return { entitlement_status: EntitlementStatus.NONE, enrollment_id: null, enrolled_at: null, progress_percent: 0 };
        return {
          entitlement_status: opts.entitlementStatus ?? EntitlementStatus.ACTIVE,
          enrollment_id: 'e1',
          enrolled_at: ago((opts.enrolledDaysAgo ?? opts.confirmedDaysAgo ?? 1) * DAY).toISOString(),
          progress_percent: opts.progress ?? 0,
        };
      }
      if (path.includes('/outcomes-status')) {
        return {
          certificate_issued: opts.certificateIssued ?? false,
          assessment_passed: opts.assessmentPassed ?? false,
        };
      }
      return { email: 'l@e.et', name: 'Learner' };
    }),
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
  const service = new RefundService(refunds as never, payments as never, bus as never, internal as never, growth, db.dataSource as never);
  const payment = () => payments.rows.find((p) => p.id === 'pay-1')!;
  const published = (type: string) => bus.publish.mock.calls.filter(([t]) => t === type);

  /**
   * The purchase's cashback (25 ETB to the buyer) and its referrer's reward
   * (50 ETB), recorded pending by the real confirmation code, plus another
   * buyer's pending cashback on their own purchase, which no refund here may touch.
   */
  const earnCredits = async () => {
    db.repo(Referral).rows.push({ id: 'ref-1', referrer_id: 'referrer', referred_user_id: 'u1', status: 'signed_up', reward_etb: '0' });
    const other = { ...payment(), id: 'pay-2', learner_id: 'u2', chapa_tx_ref: 'TX-2', refund_requested_at: null };
    payments.rows.push(other);
    await db.dataSource.transaction(async (m) => {
      await growth.creditCashback(m as never, payment() as Payment, confirmedAt);
      await growth.rewardReferrer(m as never, payment() as Payment, 'Learner', confirmedAt);
      await growth.creditCashback(m as never, other as Payment, confirmedAt);
    });
  };
  /** [user, kind, purchase, state] of every wallet movement. */
  const credits = () => db.repo(WalletTransaction).rows.map((t) => [t.user_id, t.kind, t.payment_id, t.state]);
  const balance = (userId: string) => Number(db.repo(Wallet).rows.find((w) => w.user_id === userId)?.balance_etb ?? 0);

  return { db, service, growth, bus, payments, refunds, payment, published, confirmedAt, earnCredits, credits, balance };
}

describe('RefundService rule engine (spec §10.4)', () => {
  it('auto-approves <20% progress within 7 days and revokes entitlement via RefundApproved', async () => {
    const { service, bus, payment } = setup({ progress: 10, confirmedDaysAgo: 2 });
    const result = await service.request(ctx, 'pay-1', 'changed my mind');
    expect(result.status).toBe(RefundStatus.APPROVED);
    expect(result.rule).toBe('auto_approve_under_20pct_within_7d');
    expect(bus.publish).toHaveBeenCalledWith('RefundApproved', expect.objectContaining({ payment_id: 'pay-1' }));
    // the payment itself is marked refunded, and keeps the request's mark
    expect(payment().status).toBe(PaymentStatus.REFUNDED);
    expect(payment().refund_requested_at).toBeInstanceOf(Date);
  });

  it('sends 20–50% progress to manual review (pending, admin notified)', async () => {
    const { service, bus } = setup({ progress: 35, confirmedDaysAgo: 2 });
    const result = await service.request(ctx, 'pay-1', 'not what I expected');
    expect(result.status).toBe(RefundStatus.PENDING);
    expect(result.rule).toBe('manual_review_20_to_50pct');
    expect(bus.publish).toHaveBeenCalledWith('RefundRequested', expect.anything());
  });

  it('denies >50% consumed', async () => {
    const { service } = setup({ progress: 80, confirmedDaysAgo: 2 });
    const result = await service.request(ctx, 'pay-1', 'finished it, want money back');
    expect(result.status).toBe(RefundStatus.DENIED);
    expect(result.rule).toBe('over_50pct_consumed');
  });

  it('denies outside the 7-day window regardless of progress', async () => {
    const { service } = setup({ progress: 5, confirmedDaysAgo: 9 });
    const result = await service.request(ctx, 'pay-1', 'late');
    expect(result.status).toBe(RefundStatus.DENIED);
    expect(result.rule).toBe('outside_7_day_window');
  });

  it('denies once a certificate was issued, even inside the window', async () => {
    const { service } = setup({ progress: 10, confirmedDaysAgo: 1, certificateIssued: true });
    const result = await service.request(ctx, 'pay-1', 'got cert, want refund');
    expect(result.status).toBe(RefundStatus.DENIED);
    expect(result.rule).toBe('certificate_already_issued');
  });

  it('denies once an assessment was passed', async () => {
    const { service } = setup({ progress: 10, confirmedDaysAgo: 1, assessmentPassed: true });
    const result = await service.request(ctx, 'pay-1', 'passed, refund pls');
    expect(result.status).toBe(RefundStatus.DENIED);
    expect(result.rule).toBe('assessment_already_passed');
  });

  it("refuses to act on someone else's payment", async () => {
    const { service } = setup({ learnerId: 'someone-else' });
    await expect(service.request(ctx, 'pay-1', 'x')).rejects.toThrow(ForbiddenException);
  });

  it('only refunds confirmed payments', async () => {
    const { service } = setup({ paymentStatus: PaymentStatus.PENDING });
    await expect(service.request(ctx, 'pay-1', 'x')).rejects.toThrow(BadRequestException);
  });
});

describe('RefundService: the 7-day window runs from the payment confirmation (decision 4)', () => {
  it('measures the window from the confirmation, not from the enrollment', async () => {
    const late = setup({ progress: 5, confirmedDaysAgo: 8, enrolledDaysAgo: 1 });
    await expect(late.service.request(ctx, 'pay-1', 'late')).resolves.toMatchObject({ status: RefundStatus.DENIED, rule: 'outside_7_day_window' });

    const inTime = setup({ progress: 5, confirmedDaysAgo: 6, enrolledDaysAgo: 30 });
    await expect(inTime.service.request(ctx, 'pay-1', 'in time')).resolves.toMatchObject({ status: RefundStatus.APPROVED });
  });

  it('a re-purchase after a refund is refundable within 7 days of the new payment', async () => {
    // The first purchase was refunded 40 days ago; buying again reused that enrollment.
    // Its grant has been consumed: the reused enrollment is active again.
    const { service, payments, refunds, payment, published } = setup({
      progress: 10,
      confirmedDaysAgo: 2,
      enrolledDaysAgo: 40,
      entitlementStatus: EntitlementStatus.ACTIVE,
    });
    payments.rows.push({ ...payment(), id: 'pay-0', chapa_tx_ref: 'TX-0', status: PaymentStatus.REFUNDED, refund_requested_at: ago(40 * DAY), webhook_received_at: ago(40 * DAY) });
    refunds.rows.push({ id: 'rr-0', payment_id: 'pay-0', learner_id: 'u1', reason: 'first time', status: RefundStatus.APPROVED, decision_rule: 'auto_approve_under_20pct_within_7d' });

    const result = await service.request(ctx, 'pay-1', 'still not for me');

    expect(result).toMatchObject({ status: RefundStatus.APPROVED, rule: 'auto_approve_under_20pct_within_7d' });
    expect(payment().status).toBe(PaymentStatus.REFUNDED);
    expect(published('RefundApproved')).toEqual([['RefundApproved', expect.objectContaining({ payment_id: 'pay-1' })]]);
  });

  it('keeps the window closed while the learner has no enrollment yet, as before', async () => {
    const { service, payment } = setup({ confirmedDaysAgo: 1, noEnrollment: true });
    await expect(service.request(ctx, 'pay-1', 'no access yet')).resolves.toMatchObject({ status: RefundStatus.DENIED, rule: 'outside_7_day_window' });
    expect(payment()).toMatchObject({ status: PaymentStatus.CONFIRMED, refund_requested_at: null });
  });

  it("keeps the window closed for a re-purchase whose grant isn't consumed yet (the old enrollment is still refunded)", async () => {
    const { service, payment, published } = setup({ progress: 5, confirmedDaysAgo: 5 / (24 * 60), enrolledDaysAgo: 40, entitlementStatus: EntitlementStatus.REFUNDED });
    await expect(service.request(ctx, 'pay-1', 'no access yet')).resolves.toMatchObject({ status: RefundStatus.DENIED, rule: 'outside_7_day_window' });
    expect(payment()).toMatchObject({ status: PaymentStatus.CONFIRMED, refund_requested_at: null });
    expect(published('RefundApproved')).toHaveLength(0);
  });

  it('uses the payment creation time when it has no confirmation time', async () => {
    const { service, payment } = setup({ progress: 5 });
    Object.assign(payment(), { webhook_received_at: null, created_at: ago(8 * DAY) });
    await expect(service.request(ctx, 'pay-1', 'late')).resolves.toMatchObject({ status: RefundStatus.DENIED, rule: 'outside_7_day_window' });
  });
});

describe('RefundService: a request the rules accept marks the payment (decision 5)', () => {
  it('a manual-review request marks the payment and leaves it confirmed', async () => {
    const { service, payment } = setup({ progress: 35, confirmedDaysAgo: 2 });
    await service.request(ctx, 'pay-1', 'not what I expected');
    expect(payment()).toMatchObject({ status: PaymentStatus.CONFIRMED, payout_id: null, refund_requested_at: expect.any(Date) });
  });

  it.each<[string, Options, string]>([
    ['a certificate was issued', { certificateIssued: true }, 'certificate_already_issued'],
    ['outside the window', { confirmedDaysAgo: 9 }, 'outside_7_day_window'],
    ['over 50% consumed', { progress: 80 }, 'over_50pct_consumed'],
  ])('an auto-denied request (%s) leaves the payment unmarked and claimable', async (_case, opts, rule) => {
    const { service, payment, published } = setup({ progress: 10, confirmedDaysAgo: 2, ...opts });
    await expect(service.request(ctx, 'pay-1', 'please')).resolves.toMatchObject({ status: RefundStatus.DENIED, rule });
    // What the payout claim needs: confirmed, not in a payout, no refund mark.
    expect(payment()).toMatchObject({ status: PaymentStatus.CONFIRMED, payout_id: null, refund_requested_at: null });
    expect(published('RefundDenied')).toHaveLength(1);
  });

  it.each<[string, number]>([
    ['auto-approved', 10],
    ['manual review', 35],
  ])('an accepted request (%s) on a payment already paid out is sent to support and changes nothing', async (_case, progress) => {
    const { service, refunds, payment, bus, earnCredits, credits } = setup({ progress, confirmedDaysAgo: 2, payoutId: 'po-1' });
    await earnCredits();
    const before = credits();

    await expect(service.request(ctx, 'pay-1', 'please')).rejects.toThrow(new BadRequestException(PAID_OUT));

    expect(refunds.rows).toHaveLength(0);
    expect(payment()).toMatchObject({ status: PaymentStatus.CONFIRMED, payout_id: 'po-1', refund_requested_at: null });
    expect(credits()).toEqual(before);
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('a request on a paid-out payment that the rules deny gets the rule, not the support message', async () => {
    const { service, payment } = setup({ progress: 5, confirmedDaysAgo: 9, payoutId: 'po-1' });
    await expect(service.request(ctx, 'pay-1', 'late')).resolves.toMatchObject({ status: RefundStatus.DENIED, rule: 'outside_7_day_window' });
    expect(payment().refund_requested_at).toBeNull();
  });

  it('a failure in the request transaction rolls back the mark, the request row and the flip, and announces nothing', async () => {
    const { service, growth, refunds, payment, earnCredits, credits, published } = setup({ progress: 10, confirmedDaysAgo: 2 });
    await earnCredits();
    const before = credits();
    jest.spyOn(growth, 'voidPurchaseCredits').mockRejectedValueOnce(new Error('connection reset'));

    await expect(service.request(ctx, 'pay-1', 'please')).rejects.toThrow('connection reset');

    expect(refunds.rows).toHaveLength(0);
    expect(payment()).toMatchObject({ status: PaymentStatus.CONFIRMED, refund_requested_at: null });
    expect(credits()).toEqual(before);
    expect(published('RefundApproved')).toHaveLength(0);
  });
});

describe('RefundService: approval voids the purchase credits, denial keeps them (decision 3)', () => {
  const admin = 'adm-1';

  it("an auto-approved refund voids the purchase's pending cashback and referral reward, and nothing else", async () => {
    const { service, earnCredits, credits, balance } = setup({ progress: 10, confirmedDaysAgo: 2 });
    await earnCredits();

    await service.request(ctx, 'pay-1', 'changed my mind');

    expect(credits()).toEqual([
      ['u1', 'cashback', 'pay-1', 'void'],
      ['referrer', 'referral_reward', 'pay-1', 'void'],
      ['u2', 'cashback', 'pay-2', 'pending'],
    ]);
    expect([balance('u1'), balance('referrer')]).toEqual([0, 0]);
  });

  it('an admin approval voids them once; a replayed approval is refused and changes nothing', async () => {
    const { service, payment, earnCredits, credits, published } = setup({ progress: 35, confirmedDaysAgo: 2 });
    await earnCredits();
    const { refund_id } = await service.request(ctx, 'pay-1', 'not what I expected');
    expect(credits().filter(([, , pay]) => pay === 'pay-1').map(([, , , state]) => state)).toEqual(['pending', 'pending']);

    await expect(service.decide(admin, refund_id, true)).resolves.toMatchObject({ status: RefundStatus.APPROVED, decided_by: admin });
    const after = credits();
    expect(after.filter(([, , pay]) => pay === 'pay-1').map(([, , , state]) => state)).toEqual(['void', 'void']);

    await expect(service.decide(admin, refund_id, true)).rejects.toThrow(new BadRequestException('Already decided'));
    expect(credits()).toEqual(after);
    expect(payment()).toMatchObject({ status: PaymentStatus.REFUNDED, refund_requested_at: expect.any(Date) });
    expect(published('RefundApproved')).toHaveLength(1);
  });

  it('a denied refund clears the mark and leaves the credits pending; they release once they mature', async () => {
    const { service, growth, payment, earnCredits, credits, confirmedAt, published } = setup({ progress: 35, confirmedDaysAgo: 2 });
    await earnCredits();
    const { refund_id } = await service.request(ctx, 'pay-1', 'not what I expected');

    // Freeze only the clock, just past the hold; promises keep real timers.
    jest.useFakeTimers({
      now: new Date(confirmedAt.getTime() + HOLD_MS + 60_000),
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    try {
      // Matured, but the open request holds them.
      expect((await growth.wallet('u1')).balance_etb).toBe(0);

      await expect(service.decide(admin, refund_id, false)).resolves.toMatchObject({ status: RefundStatus.DENIED });
      expect(payment()).toMatchObject({ status: PaymentStatus.CONFIRMED, refund_requested_at: null });
      expect(credits().filter(([, , pay]) => pay === 'pay-1').map(([, , , state]) => state)).toEqual(['pending', 'pending']);

      expect((await growth.wallet('u1')).balance_etb).toBe(25);
      expect((await growth.wallet('referrer')).balance_etb).toBe(50);
    } finally {
      jest.useRealTimers();
    }
    expect(published('RefundDenied')).toHaveLength(1);
    expect(published('RefundApproved')).toHaveLength(0);
  });

  it('approving a legacy pending refund on a payment already paid out is sent to support and changes nothing (N2)', async () => {
    const { service, refunds, payment, earnCredits, credits, bus } = setup({ progress: 35, confirmedDaysAgo: 2, payoutId: 'po-1' });
    await earnCredits();
    // Filed before the mark existed; the migration's backfill marked its payment.
    const markedAt = ago(DAY);
    payment().refund_requested_at = markedAt;
    refunds.rows.push({ id: 'rr-legacy', payment_id: 'pay-1', learner_id: 'u1', reason: 'x', status: RefundStatus.PENDING, decision_rule: 'manual_review_20_to_50pct', decided_at: null, decided_by: null });
    const before = credits();

    await expect(service.decide(admin, 'rr-legacy', true)).rejects.toThrow(new BadRequestException(PAID_OUT));

    expect(refunds.rows[0]).toMatchObject({ status: RefundStatus.PENDING, decided_at: null, decided_by: null });
    expect(payment()).toMatchObject({ status: PaymentStatus.CONFIRMED, payout_id: 'po-1', refund_requested_at: markedAt });
    expect(credits()).toEqual(before);
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('a failure in the approval transaction leaves the refund pending and the payment confirmed', async () => {
    const { service, growth, refunds, payment, earnCredits, credits, published } = setup({ progress: 35, confirmedDaysAgo: 2 });
    await earnCredits();
    const { refund_id } = await service.request(ctx, 'pay-1', 'not what I expected');
    const before = credits();
    jest.spyOn(growth, 'voidPurchaseCredits').mockRejectedValueOnce(new Error('connection reset'));

    await expect(service.decide(admin, refund_id, true)).rejects.toThrow('connection reset');

    expect(refunds.rows[0]).toMatchObject({ status: RefundStatus.PENDING, decided_by: null });
    expect(payment()).toMatchObject({ status: PaymentStatus.CONFIRMED, refund_requested_at: expect.any(Date) });
    expect(credits()).toEqual(before);
    expect(published('RefundApproved')).toHaveLength(0);
  });
});

describe('RefundService: decided once (5a)', () => {
  const admin = 'adm-1';

  it('an admin decision applied twice at once approves once and revokes access once', async () => {
    const { service, refunds, payment, published } = setup({ progress: 35, confirmedDaysAgo: 2 });
    const { refund_id } = await service.request(ctx, 'pay-1', 'not what I expected');

    const results = await Promise.allSettled([service.decide(admin, refund_id, true), service.decide(admin, refund_id, true)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: new BadRequestException('Already decided') });
    expect(published('RefundApproved')).toHaveLength(1);
    expect(refunds.rows[0]).toMatchObject({ status: RefundStatus.APPROVED, decided_by: admin });
    expect(payment().status).toBe(PaymentStatus.REFUNDED);
  });

  it('approve and deny racing: the first decision stands', async () => {
    const { service, refunds, payment, published } = setup({ progress: 35, confirmedDaysAgo: 2 });
    const { refund_id } = await service.request(ctx, 'pay-1', 'x');
    await Promise.allSettled([service.decide(admin, refund_id, false), service.decide(admin, refund_id, true)]);
    expect(refunds.rows[0].status).toBe(RefundStatus.DENIED);
    expect(payment()).toMatchObject({ status: PaymentStatus.CONFIRMED, refund_requested_at: null });
    expect(published('RefundApproved')).toHaveLength(0);
    expect(published('RefundDenied')).toHaveLength(1);
  });

  it('refuses a second open refund request for the same payment', async () => {
    const { service } = setup({ progress: 35, confirmedDaysAgo: 2 });
    await service.request(ctx, 'pay-1', 'first');
    await expect(service.request(ctx, 'pay-1', 'second')).rejects.toThrow(new BadRequestException(ALREADY_OPEN));
  });

  it('two auto-approved requests at once refund the payment once', async () => {
    const { service, payment, published } = setup({ progress: 10, confirmedDaysAgo: 2 });
    const results = await Promise.allSettled([service.request(ctx, 'pay-1', 'a'), service.request(ctx, 'pay-1', 'b')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // The second found the payment already marked.
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: new BadRequestException(ALREADY_OPEN) });
    expect(published('RefundApproved')).toHaveLength(1);
    expect(payment().status).toBe(PaymentStatus.REFUNDED);
  });

  it('approving does not refund a payment that is no longer confirmed', async () => {
    const { service, payment, published } = setup({ progress: 35, confirmedDaysAgo: 2 });
    const { refund_id } = await service.request(ctx, 'pay-1', 'x');
    payment().status = PaymentStatus.REFUNDED; // refunded through another path meanwhile
    await service.decide(admin, refund_id, true);
    expect(published('RefundApproved')).toHaveLength(0);
  });

  it('a decision on an unknown refund is a 404', async () => {
    const { service } = setup();
    await expect(service.decide(admin, 'nope', true)).rejects.toThrow('Refund request not found');
  });
});

describe('RefundService.listPending', () => {
  const admin = { id: 'adm-1', role: 'platform_admin', email: 'a@e.et' } as never;

  it('carries the payment amount and course title, from one payments query', async () => {
    const { service, payments } = setup({ progress: 35, confirmedDaysAgo: 2 });
    await service.request(ctx, 'pay-1', 'not what I expected');
    const find = jest.spyOn(payments, 'find');
    const rows = await service.listPending(admin);
    expect(rows).toEqual([expect.objectContaining({ payment_id: 'pay-1', reason: 'not what I expected', amount_etb: '500.00', course_title: 'Course' })]);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('gives null for a missing payment and skips the query when nothing is pending', async () => {
    const { service, payments, refunds } = setup({ progress: 35, confirmedDaysAgo: 2 });
    await service.request(ctx, 'pay-1', 'x');
    payments.rows.length = 0;
    await expect(service.listPending(admin)).resolves.toEqual([expect.objectContaining({ amount_etb: null, course_title: null })]);
    refunds.rows.length = 0;
    const find = jest.spyOn(payments, 'find');
    find.mockClear();
    await expect(service.listPending(admin)).resolves.toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});
