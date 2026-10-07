import { BadRequestException } from '@nestjs/common';
import { EntitlementStatus, OwnerType, PaymentMethod, PaymentPurpose, PaymentStatus, PayoutStatus, RefundStatus, TrustTier } from '@ethiopialearn/contracts';
import { Payment, Payout, PayoutHold, RefundRequest } from './entities';
import { PayoutService } from './payout.service';
import { RefundService } from './refund.service';
import { fakeDb, fakeOutbox, Row } from './testing/fake-db';

const DAY = 86_400_000;

interface Options {
  tier?: TrustTier;
}

function setup(opts: Options = {}) {
  const db = fakeDb();
  const bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn(), subscribeCommands: jest.fn() };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.includes('/trust-tier')) return { tier: opts.tier ?? TrustTier.TRUSTED };
      return { email: 'edu@e.et' };
    }),
  };
  const service = new PayoutService(
    db.repo(Payment) as never,
    db.repo(Payout) as never,
    db.repo(PayoutHold) as never,
    bus as never,
    internal as never,
    db.dataSource as never,
  );
  let seq = 0;
  const payment = (over: Row & { settledDaysAgo?: number } = {}) => {
    const { settledDaysAgo = 10, ...rest } = over;
    const settled = new Date(Date.now() - settledDaysAgo * DAY);
    const p = {
      id: `pay-${++seq}`,
      learner_id: 'u1',
      course_id: 'c1',
      amount_etb: '500.00',
      method: PaymentMethod.CHAPA,
      status: PaymentStatus.CONFIRMED,
      chapa_tx_ref: `TX-${seq}`,
      payee_id: 'edu-1',
      payee_type: OwnerType.EDUCATOR,
      purpose: PaymentPurpose.COURSE,
      payout_id: null,
      refund_requested_at: null as Date | null,
      webhook_received_at: settled,
      created_at: settled,
      ...rest,
    };
    db.repo(Payment).rows.push(p);
    return p;
  };
  const payouts = () => db.repo(Payout).rows;
  const published = (type: string) => bus.publish.mock.calls.filter(([t]) => t === type);
  const payoutOf = (paymentId: string) => db.repo(Payment).rows.find((p) => p.id === paymentId)!.payout_id;
  return { db, bus, internal, service, payment, payouts, published, payoutOf };
}

describe('PayoutService.runPayouts (spec §10.3 / 80-20 split)', () => {
  it('computes the 80/20 split and disburses a cleared payment', async () => {
    const t = setup();
    const p = t.payment();
    expect(await t.service.runPayouts()).toEqual({ created: 1, held: 0 });

    expect(t.payouts()[0]).toMatchObject({
      payee_id: 'edu-1',
      gross_amount_etb: '500.00',
      platform_fee_etb: '100.00',
      net_amount_etb: '400.00',
      status: PayoutStatus.PAID,
    });
    expect(t.payoutOf(p.id)).toBe(t.payouts()[0].id);
    expect(t.bus.publish).toHaveBeenCalledWith('PayoutScheduled', expect.objectContaining({ net_amount_etb: 400 }));
    expect(t.bus.publish).toHaveBeenCalledWith('PayoutCompleted', expect.objectContaining({ platform_fee_etb: 100 }));
  });

  it('holds back payments inside the 7-day settlement window', async () => {
    const t = setup();
    t.payment({ settledDaysAgo: 2 });
    expect(await t.service.runPayouts()).toEqual({ created: 0, held: 0 });
    expect(t.payouts()).toHaveLength(0);
  });

  it('applies the 14-day hold to new-tier educators', async () => {
    const heldCase = setup({ tier: TrustTier.NEW });
    heldCase.payment({ settledDaysAgo: 10 });
    expect(await heldCase.service.runPayouts()).toEqual({ created: 0, held: 0 });

    const clearedCase = setup({ tier: TrustTier.NEW });
    clearedCase.payment({ settledDaysAgo: 15 });
    expect(await clearedCase.service.runPayouts()).toEqual({ created: 1, held: 0 });
  });

  it('skips a payment whose refund request marked it, and pays the rest', async () => {
    const t = setup();
    const refunded = t.payment({ refund_requested_at: new Date() });
    const clean = t.payment({ amount_etb: '300.00' });
    t.db.repo(RefundRequest).rows.push({ id: 'ref-1', payment_id: refunded.id, status: RefundStatus.PENDING });

    expect(await t.service.runPayouts()).toEqual({ created: 1, held: 0 });
    expect(t.payouts()[0].gross_amount_etb).toBe('300.00');
    expect(t.payoutOf(refunded.id)).toBeNull();
    expect(t.payoutOf(clean.id)).toBe(t.payouts()[0].id);
  });

  it('claims a marked payment once the mark is cleared (admin denial)', async () => {
    const t = setup();
    const p = t.payment({ refund_requested_at: new Date() });
    expect(await t.service.runPayouts()).toEqual({ created: 0, held: 0 });
    expect(t.payoutOf(p.id)).toBeNull();

    p.refund_requested_at = null;
    expect(await t.service.runPayouts()).toEqual({ created: 1, held: 0 });
    expect(t.payoutOf(p.id)).toBe(t.payouts()[0].id);
  });

  it('the claim itself skips a payment marked after the candidates were read, and sums only what it claimed', async () => {
    const t = setup();
    const raced = t.payment();
    const clean = t.payment({ amount_etb: '300.00' });
    // The mark lands between the candidate read and the claim (holdDays asks the trust tier in between).
    t.internal.get.mockImplementationOnce(async () => {
      raced.refund_requested_at = new Date();
      return { tier: TrustTier.TRUSTED };
    });

    expect(await t.service.runPayouts()).toEqual({ created: 1, held: 0 });
    expect(t.payouts()[0]).toMatchObject({ gross_amount_etb: '300.00', net_amount_etb: '240.00' });
    expect(t.payoutOf(raced.id)).toBeNull();
    expect(t.payoutOf(clean.id)).toBe(t.payouts()[0].id);
  });

  it('a refund request after the payout claimed the payment is sent to support, and the payout stands', async () => {
    const t = setup();
    const p = t.payment({ settledDaysAgo: 8 });
    expect(await t.service.runPayouts()).toEqual({ created: 1, held: 0 });
    const payoutId = t.payoutOf(p.id);
    expect(payoutId).toBe(t.payouts()[0].id);

    // The payout hold is as long as the refund window, so a payment cleared for payout is outside it. Move the clock the rules read.
    p.webhook_received_at = p.created_at = new Date(Date.now() - 2 * DAY);
    const refundService = new RefundService(
      t.db.repo(RefundRequest) as never,
      t.db.repo(Payment) as never,
      t.bus as never,
      {
        get: jest.fn(async (path: string) =>
          path.startsWith('/api/v1/internal/entitlements')
            ? { entitlement_status: EntitlementStatus.ACTIVE, enrollment_id: 'e1', enrolled_at: new Date(Date.now() - 2 * DAY).toISOString(), progress_percent: 35 }
            : { certificate_issued: false, assessment_passed: false },
        ),
      } as never,
      {} as never, // growth: only an approval reaches it, and this request goes to manual review
      fakeOutbox(t.db.dataSource).outbox as never,
    );
    await expect(refundService.request({ id: 'u1', role: 'learner', email: 'l@e.et' } as never, p.id, 'please')).rejects.toThrow(
      new BadRequestException('This payment has already been paid out to the educator. Contact support from Help to request a refund.'),
    );
    expect(t.db.repo(RefundRequest).rows).toHaveLength(0);
    expect(p).toMatchObject({ payout_id: payoutId, refund_requested_at: null, status: PaymentStatus.CONFIRMED });
  });

  it('holds large payouts behind the KYC threshold instead of paying', async () => {
    const t = setup();
    t.payment({ amount_etb: '20000.00' }); // net 16000 > default 10000
    expect(await t.service.runPayouts()).toEqual({ created: 0, held: 1 });
    expect(t.payouts()[0]).toMatchObject({ status: PayoutStatus.HELD, hold_reason: 'kyc_required' });
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('holds payouts for payees with open fraud flags', async () => {
    const t = setup();
    t.payment();
    t.db.repo(PayoutHold).rows.push({ id: 'h1', payee_id: 'edu-1', flag_id: 'f1' });
    expect(await t.service.runPayouts()).toEqual({ created: 0, held: 1 });
    expect(t.payouts()[0]).toMatchObject({ status: PayoutStatus.HELD, hold_reason: 'fraud_flag_open' });
  });

  it('never pays out wallet top-ups, the platform payee or zero-amount payments', async () => {
    const t = setup();
    t.payment({ purpose: PaymentPurpose.WALLET_TOPUP });
    t.payment({ payee_id: '00000000-0000-0000-0000-000000000000' });
    t.payment({ amount_etb: '0.00', payee_id: 'edu-2' });
    expect(await t.service.runPayouts()).toEqual({ created: 0, held: 0 });
  });
});

describe('PayoutService: one payout per payment (P1-14)', () => {
  it('a second run claims nothing and publishes nothing', async () => {
    const t = setup();
    t.payment();
    await t.service.runPayouts();
    t.bus.publish.mockClear();

    expect(await t.service.runPayouts()).toEqual({ created: 0, held: 0 });
    expect(t.payouts()).toHaveLength(1);
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('two concurrent runs attach each payment to exactly one payout, paid once', async () => {
    const t = setup();
    const mine = [t.payment(), t.payment(), t.payment({ payee_id: 'edu-2' })];

    await Promise.all([t.service.runPayouts(), t.service.runPayouts()]);

    expect(t.payouts().length).toBeGreaterThanOrEqual(1);
    for (const payout of t.payouts()) {
      const attached = t.db.repo(Payment).rows.filter((p) => p.payout_id === payout.id);
      expect(Number(payout.gross_amount_etb)).toBe(attached.reduce((sum, p) => sum + Number(p.amount_etb), 0));
    }
    expect(mine.every((p) => t.payoutOf(p.id) !== null)).toBe(true);
    expect(t.payouts()).toHaveLength(2); // one per payee
    expect(t.published('PayoutCompleted')).toHaveLength(2);
  });

  it('a run that read the payments before another run claimed them claims nothing (the claim UPDATE is the guarantee)', async () => {
    const t = setup();
    const p = t.payment();
    // Pause the late run after its reads, just before its transaction.
    let resume!: () => void;
    const gate = new Promise<void>((r) => (resume = r));
    jest.spyOn(t.db.repo(PayoutHold), 'count').mockImplementationOnce(async () => {
      await gate;
      return 0;
    });
    const late = t.service.runPayouts();
    await new Promise((r) => setImmediate(r));

    await t.service.runPayouts(); // claims, commits and releases its lock
    resume();
    expect(await late).toEqual({ created: 0, held: 0 });

    expect(t.payouts()).toHaveLength(1);
    expect(t.payoutOf(p.id)).toBe(t.payouts()[0].id);
    expect(t.published('PayoutCompleted')).toHaveLength(1);
  });

  it('skips a payee whose payout another run is creating right now (advisory lock)', async () => {
    const t = setup();
    const p = t.payment();
    t.db.heldLocks.add('payout:edu-1');
    expect(await t.service.runPayouts()).toEqual({ created: 0, held: 0 });
    expect(t.payoutOf(p.id)).toBeNull();
  });

  it('asks for the trust tier once per payee, not once per payment', async () => {
    const t = setup();
    t.payment();
    t.payment();
    t.payment();
    await t.service.runPayouts();
    expect(t.internal.get.mock.calls.filter(([path]) => path.includes('/trust-tier'))).toHaveLength(1);
  });

  it('pages through payees with a keyset cursor', async () => {
    const t = setup();
    for (let i = 0; i < 150; i++) t.payment({ payee_id: `edu-${String(i).padStart(3, '0')}` });
    expect(await t.service.runPayouts()).toEqual({ created: 150, held: 0 });
  });

  it('disburses a payout a crashed run left scheduled, once', async () => {
    const t = setup();
    t.db.repo(Payout).rows.push({
      id: 'po-left',
      payee_id: 'edu-1',
      payee_type: OwnerType.EDUCATOR,
      gross_amount_etb: '500.00',
      platform_fee_etb: '100.00',
      net_amount_etb: '400.00',
      status: PayoutStatus.SCHEDULED,
      hold_reason: null,
    });
    await Promise.all([t.service.runPayouts(), t.service.runPayouts()]);
    expect(t.payouts()[0].status).toBe(PayoutStatus.PAID);
    expect(t.published('PayoutCompleted')).toHaveLength(1);
  });
});

describe('PayoutService: a resolved fraud flag never skips KYC', () => {
  const resolveFlag = async (t: ReturnType<typeof setup>, flagId: string) => {
    t.service.onModuleInit();
    const handler = t.bus.subscribe.mock.calls.find(([type]) => type === 'FraudFlagResolved')![1];
    await handler({ flag_id: flagId, payee_id: 'edu-1' });
  };
  const holdForFraud = (t: ReturnType<typeof setup>) => t.db.repo(PayoutHold).rows.push({ id: 'h1', payee_id: 'edu-1', flag_id: 'f1' });

  it('keeps a fraud-held payout above the KYC threshold held for KYC, and a run does not pay it', async () => {
    const t = setup();
    t.payment({ amount_etb: '20000.00' }); // net 16000 > 10000
    holdForFraud(t);
    await t.service.runPayouts();
    expect(t.payouts()[0]).toMatchObject({ status: PayoutStatus.HELD, hold_reason: 'fraud_flag_open' });

    await resolveFlag(t, 'f1');
    expect(t.payouts()[0]).toMatchObject({ status: PayoutStatus.HELD, hold_reason: 'kyc_required' });
    await t.service.runPayouts();
    expect(t.payouts()[0].status).toBe(PayoutStatus.HELD);
    expect(t.published('PayoutCompleted')).toHaveLength(0);
  });

  it('leaves a kyc_required payout untouched', async () => {
    const t = setup();
    t.payment({ amount_etb: '20000.00' });
    await t.service.runPayouts();
    holdForFraud(t);

    await resolveFlag(t, 'f1');
    expect(t.payouts()[0]).toMatchObject({ status: PayoutStatus.HELD, hold_reason: 'kyc_required' });
    await t.service.runPayouts();
    expect(t.published('PayoutCompleted')).toHaveLength(0);
  });

  it('pays a fraud-held payout under the threshold on the next run, once', async () => {
    const t = setup();
    t.payment();
    holdForFraud(t);
    await t.service.runPayouts();

    await resolveFlag(t, 'f1');
    expect(t.payouts()[0]).toMatchObject({ status: PayoutStatus.SCHEDULED, hold_reason: null });
    await Promise.all([t.service.runPayouts(), t.service.runPayouts()]);
    expect(t.payouts()[0].status).toBe(PayoutStatus.PAID);
    expect(t.published('PayoutCompleted')).toHaveLength(1);
  });

  it('treats a hold from a flag raised after scheduling (fraud:<signal>) the same way', async () => {
    const t = setup();
    t.db.repo(Payout).rows.push({
      id: 'po-big', payee_id: 'edu-1', payee_type: OwnerType.EDUCATOR, net_amount_etb: '16000.00', status: PayoutStatus.HELD, hold_reason: 'fraud:velocity',
    });
    await resolveFlag(t, 'f-other');
    expect(t.payouts()[0]).toMatchObject({ status: PayoutStatus.HELD, hold_reason: 'kyc_required' });
  });
});

describe('PayoutService.release', () => {
  it('releasing a held payout twice disburses it once', async () => {
    const t = setup();
    t.payment({ amount_etb: '20000.00' });
    await t.service.runPayouts();
    const held = t.payouts()[0];

    const results = await Promise.all([t.service.release(held.id), t.service.release(held.id)]);

    expect(results.filter((r) => r.released)).toHaveLength(1);
    expect(t.payouts()[0].status).toBe(PayoutStatus.PAID);
    expect(t.published('PayoutCompleted')).toHaveLength(1);
  });

  it('does nothing for a payout that is not held', async () => {
    const t = setup();
    t.payment();
    await t.service.runPayouts();
    expect(await t.service.release(t.payouts()[0].id)).toEqual({ released: false });
  });
});
