import { OwnerType, PaymentStatus, PayoutStatus, RefundStatus, TrustTier } from '@ethiopialearn/contracts';
import { PayoutService } from './payout.service';

const DAY = 86_400_000;

interface Options {
  amount?: string;
  settledDaysAgo?: number;
  tier?: TrustTier;
  pendingRefund?: boolean;
  openFraudHolds?: number;
}

function setup(opts: Options = {}) {
  const payment = {
    id: 'pay-1',
    learner_id: 'u1',
    course_id: 'c1',
    amount_etb: opts.amount ?? '500.00',
    status: PaymentStatus.CONFIRMED,
    payee_id: 'edu-1',
    payee_type: OwnerType.EDUCATOR,
    payout_id: null,
    webhook_received_at: new Date(Date.now() - (opts.settledDaysAgo ?? 10) * DAY),
    created_at: new Date(Date.now() - (opts.settledDaysAgo ?? 10) * DAY),
  };
  const payments = {
    find: jest.fn().mockResolvedValue([payment]),
    save: jest.fn(async (p: unknown) => p),
  };
  const savedPayouts: Record<string, unknown>[] = [];
  const payouts = {
    save: jest.fn(async (p: Record<string, unknown>) => {
      const row = { id: 'po-1', ...p };
      savedPayouts.push(row);
      return row;
    }),
    create: jest.fn((p: object) => p),
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const holds = { count: jest.fn().mockResolvedValue(opts.openFraudHolds ?? 0), findOne: jest.fn(), save: jest.fn(), create: jest.fn(), delete: jest.fn() };
  const refunds = {
    findOne: jest.fn().mockResolvedValue(opts.pendingRefund ? { status: RefundStatus.PENDING } : null),
  };
  const bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn(), subscribeCommands: jest.fn() };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.includes('/trust-tier')) return { tier: opts.tier ?? TrustTier.TRUSTED };
      return { email: 'edu@e.et' };
    }),
  };
  const service = new PayoutService(
    payments as never,
    payouts as never,
    holds as never,
    refunds as never,
    bus as never,
    internal as never,
  );
  return { service, payments, payouts, savedPayouts, bus };
}

describe('PayoutService.runPayouts (spec §10.3 / 80-20 split)', () => {
  it('computes the 80/20 split and disburses a cleared payment', async () => {
    const { service, savedPayouts, bus } = setup({ amount: '500.00', settledDaysAgo: 10 });
    const result = await service.runPayouts();

    expect(result).toEqual({ created: 1, held: 0 });
    const payout = savedPayouts[0];
    expect(payout).toMatchObject({
      payee_id: 'edu-1',
      gross_amount_etb: '500.00',
      platform_fee_etb: '100.00',
      net_amount_etb: '400.00',
    });
    expect(bus.publish).toHaveBeenCalledWith('PayoutScheduled', expect.objectContaining({ net_amount_etb: 400 }));
    expect(bus.publish).toHaveBeenCalledWith('PayoutCompleted', expect.objectContaining({ platform_fee_etb: 100 }));
  });

  it('holds back payments inside the 7-day settlement window', async () => {
    const { service, savedPayouts } = setup({ settledDaysAgo: 2 });
    expect(await service.runPayouts()).toEqual({ created: 0, held: 0 });
    expect(savedPayouts).toHaveLength(0);
  });

  it('applies the 14-day hold to new-tier educators', async () => {
    const heldCase = setup({ settledDaysAgo: 10, tier: TrustTier.NEW });
    expect(await heldCase.service.runPayouts()).toEqual({ created: 0, held: 0 });

    const clearedCase = setup({ settledDaysAgo: 15, tier: TrustTier.NEW });
    expect(await clearedCase.service.runPayouts()).toEqual({ created: 1, held: 0 });
  });

  it('skips payments with a pending refund', async () => {
    const { service, savedPayouts } = setup({ pendingRefund: true });
    expect(await service.runPayouts()).toEqual({ created: 0, held: 0 });
    expect(savedPayouts).toHaveLength(0);
  });

  it('holds large payouts behind the KYC threshold instead of paying', async () => {
    const { service, savedPayouts, bus } = setup({ amount: '20000.00' }); // net 16000 > default 10000
    expect(await service.runPayouts()).toEqual({ created: 0, held: 1 });
    expect(savedPayouts[0]).toMatchObject({ status: PayoutStatus.HELD, hold_reason: 'kyc_required' });
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('holds payouts for payees with open fraud flags', async () => {
    const { service, savedPayouts } = setup({ openFraudHolds: 1 });
    expect(await service.runPayouts()).toEqual({ created: 0, held: 1 });
    expect(savedPayouts[0]).toMatchObject({ status: PayoutStatus.HELD, hold_reason: 'fraud_flag_open' });
  });
});
