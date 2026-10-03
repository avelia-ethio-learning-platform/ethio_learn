import { BadRequestException } from '@nestjs/common';
import { PaymentMethod, PaymentPurpose, PaymentStatus } from '@ethiopialearn/contracts';
import { Coupon, Payment, Referral, ReferralCode, Wallet, WalletTransaction } from './entities';
import { GrowthService } from './growth.service';
import { fakeDb, Row } from './testing/fake-db';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Purchase credits are held for the 7-day refund window plus an hour. */
const HOLD_MS = 7 * DAY_MS + 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

function ledger() {
  const db = fakeDb();
  const bus = { publish: jest.fn().mockResolvedValue(undefined) };
  const internal = { get: jest.fn().mockResolvedValue({ email: 'buyer@x.et', name: 'Buyer' }) };
  const svc = new GrowthService(
    db.repo(Coupon) as never,
    db.repo(Wallet) as never,
    db.repo(WalletTransaction) as never,
    db.repo(ReferralCode) as never,
    db.repo(Referral) as never,
    db.dataSource as never,
    bus as never,
    internal as never,
  );
  const balance = (userId: string) => Number(db.repo(Wallet).rows.find((w) => w.user_id === userId)?.balance_etb ?? 0);
  const movements = (userId: string) => db.repo(WalletTransaction).rows.filter((t) => t.user_id === userId);
  /** The purchase row a pending credit points at, as the release reads it. */
  const purchaseRow = (id: string, over: Row = {}) => db.repo(Payment).rows.push({ id, status: PaymentStatus.CONFIRMED, refund_requested_at: null, ...over });
  return { db, bus, svc, balance, movements, purchaseRow };
}

const purchase = (over: Partial<Payment> = {}) =>
  ({
    id: 'pay-1',
    learner_id: 'buyer',
    amount_etb: '500.00',
    method: PaymentMethod.CHAPA,
    purpose: PaymentPurpose.COURSE,
    course_title: 'Course',
    ...over,
  }) as Payment;

describe('GrowthService wallet ledger', () => {
  it('credits a (kind, reference) once, however often it is replayed', async () => {
    const { svc, bus, balance, movements } = ledger();
    await svc.credit('u1', 100, 'topup', 'pay-1', 'Wallet top-up');
    await svc.credit('u1', 100, 'topup', 'pay-1', 'Wallet top-up');

    expect(balance('u1')).toBe(100);
    expect(movements('u1')).toHaveLength(1);
    expect(bus.publish).toHaveBeenCalledTimes(1);
  });

  it('applies two concurrent first credits to a new wallet, each once', async () => {
    const { svc, balance, movements } = ledger();
    await Promise.all([
      svc.credit('u1', 30, 'cashback', 'pay-1', 'Cashback'),
      svc.credit('u1', 50, 'referral_reward', 'ref-1', 'Referral reward'),
    ]);
    expect(balance('u1')).toBe(80);
    expect(movements('u1')).toHaveLength(2);
  });

  it('keeps admin adjustments non-unique: the same support reference can credit twice', async () => {
    const { svc, balance } = ledger();
    await svc.adminAdjust('adm', 'u1', 20, 'goodwill');
    await svc.adminAdjust('adm', 'u1', 20, 'goodwill');
    expect(balance('u1')).toBe(40);
  });

  it('debits a purchase once and refuses an overdraft without leaving a movement behind', async () => {
    const { svc, balance, movements } = ledger();
    await svc.credit('u1', 100, 'topup', 'pay-0', 'Wallet top-up');
    await svc.debit('u1', 60, 'purchase', 'pay-1', 'Paid for "Course"');
    await svc.debit('u1', 60, 'purchase', 'pay-1', 'Paid for "Course"');
    expect(balance('u1')).toBe(40);

    await expect(svc.debit('u1', 60, 'purchase', 'pay-2', 'Paid for "Other"')).rejects.toThrow(
      new BadRequestException('Wallet balance (40.00 ETB) is not enough for 60.00 ETB'),
    );
    expect(balance('u1')).toBe(40);
    expect(movements('u1').map((m) => m.reference)).toEqual(['pay-0', 'pay-1']);
  });

  it('refuses a debit from a wallet that does not exist yet', async () => {
    const { svc, movements } = ledger();
    await expect(svc.debit('u1', 10, 'purchase', 'pay-1', 'Paid')).rejects.toThrow('Wallet balance (0.00 ETB) is not enough for 10.00 ETB');
    expect(movements('u1')).toHaveLength(0);
  });

  it("inside a caller's transaction, leaves announcing the credit to the caller", async () => {
    const { db, svc, bus } = ledger();
    const credit = await db.dataSource.transaction((m) => svc.creditWith(m as never, 'u1', 25, 'cashback', 'pay-1', 'Cashback'));

    expect(credit).toEqual({ user_id: 'u1', amount_etb: 25, balance_etb: 25, kind: 'cashback', note: 'Cashback' });
    expect(bus.publish).not.toHaveBeenCalled();
    await svc.announceCredits([credit!]);
    expect(bus.publish).toHaveBeenCalledWith('WalletCredited', credit);
  });

  it("is rolled back with the caller's transaction", async () => {
    const { db, svc, balance, movements } = ledger();
    await expect(
      db.dataSource.transaction(async (m) => {
        await svc.creditWith(m as never, 'u1', 25, 'cashback', 'pay-1', 'Cashback');
        throw new Error('a later step failed');
      }),
    ).rejects.toThrow('a later step failed');
    expect(balance('u1')).toBe(0);
    expect(movements('u1')).toHaveLength(0);
  });

  it('a failed WalletCredited publish never undoes or fails the credit', async () => {
    const { svc, bus, balance } = ledger();
    bus.publish.mockRejectedValue(new Error('broker down'));
    await expect(svc.credit('u1', 10, 'topup', 'pay-1', 'Wallet top-up')).resolves.toBe(10);
    expect(balance('u1')).toBe(10);
  });
});

describe('GrowthService purchase rewards', () => {
  it('records cashback once per payment, pending for 7 days and 1 hour from the confirmation, and leaves the balance alone', async () => {
    const { db, svc, balance, movements } = ledger();
    const confirmedAt = new Date();
    const credit = await db.dataSource.transaction((m) => svc.creditCashback(m as never, purchase(), confirmedAt));
    const again = await db.dataSource.transaction((m) => svc.creditCashback(m as never, purchase(), confirmedAt));

    expect(credit).toEqual({ user_id: 'buyer', amount_etb: 25, balance_etb: 0, kind: 'cashback', note: '5% cashback on "Course"' });
    expect(again).toBeNull();
    expect(movements('buyer')).toEqual([
      expect.objectContaining({
        kind: 'cashback',
        reference: 'pay-1',
        amount_etb: '25.00',
        state: 'pending',
        available_at: new Date(confirmedAt.getTime() + HOLD_MS),
        payment_id: 'pay-1',
      }),
    ]);
    expect(balance('buyer')).toBe(0);
  });

  it('pays no cashback or referral reward on wallet, coupon or top-up settlements', () => {
    const { svc } = ledger();
    expect(svc.rewardsApply(purchase())).toBe(true);
    expect(svc.rewardsApply(purchase({ method: PaymentMethod.BANK_TRANSFER }))).toBe(true);
    expect(svc.rewardsApply(purchase({ method: PaymentMethod.WALLET }))).toBe(false);
    expect(svc.rewardsApply(purchase({ method: PaymentMethod.COUPON }))).toBe(false);
    expect(svc.rewardsApply(purchase({ purpose: PaymentPurpose.WALLET_TOPUP }))).toBe(false);
    expect(svc.rewardsApply(purchase({ amount_etb: '0.00' }))).toBe(false);
  });

  it('rewards the referrer once when two first purchases confirm at the same time, as a pending credit', async () => {
    const { db, svc, balance, movements } = ledger();
    db.repo(Referral).rows.push({ id: 'ref-1', referrer_id: 'referrer', referred_user_id: 'buyer', status: 'signed_up', reward_etb: '0' });
    const confirmedAt = new Date();

    const results = await Promise.all([
      db.dataSource.transaction((m) => svc.rewardReferrer(m as never, purchase({ id: 'pay-1' }), 'Buyer', confirmedAt)),
      db.dataSource.transaction((m) => svc.rewardReferrer(m as never, purchase({ id: 'pay-2' }), 'Buyer', confirmedAt)),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(balance('referrer')).toBe(0);
    // The reference is the referral; payment_id ties the reward to the purchase that earned it.
    expect(movements('referrer')).toEqual([
      expect.objectContaining({
        kind: 'referral_reward',
        reference: 'ref-1',
        amount_etb: '50.00',
        state: 'pending',
        available_at: new Date(confirmedAt.getTime() + HOLD_MS),
      }),
    ]);
    expect(['pay-1', 'pay-2']).toContain(movements('referrer')[0].payment_id);
    expect(db.repo(Referral).rows[0]).toMatchObject({ status: 'rewarded', reward_etb: '50.00' });
  });
});

describe('GrowthService pending purchase credits: lazy release', () => {
  const earnCashback = (t: ReturnType<typeof ledger>, confirmedAt: Date) =>
    t.db.dataSource.transaction((m) => t.svc.creditCashback(m as never, purchase(), confirmedAt)); // 25 ETB
  const states = (t: ReturnType<typeof ledger>, userId: string) => t.movements(userId).map((m) => [m.kind, m.state]);

  it('releases a matured credit on the first wallet read, once; the response keeps its shape', async () => {
    const t = ledger();
    t.purchaseRow('pay-1');
    await earnCashback(t, ago(HOLD_MS + 60_000)); // available a minute ago

    const first = await t.svc.wallet('buyer');
    const second = await t.svc.wallet('buyer');

    expect(first).toEqual({
      user_id: 'buyer',
      balance_etb: 25,
      transactions: [{ id: expect.any(String), amount_etb: 25, kind: 'cashback', note: '5% cashback on "Course"', reference: 'pay-1', created_at: expect.any(Date) }],
      referral_reward_etb: 50,
      cashback_percent: 5,
    });
    expect(second.balance_etb).toBe(25);
    expect(t.balance('buyer')).toBe(25);
    expect(states(t, 'buyer')).toEqual([['cashback', 'available']]);
  });

  it('releases a matured credit once when two wallet reads run at the same time', async () => {
    const t = ledger();
    t.purchaseRow('pay-1');
    await earnCashback(t, ago(8 * DAY_MS));

    const reads = await Promise.all([t.svc.wallet('buyer'), t.svc.wallet('buyer')]);

    expect(reads.map((r) => r.balance_etb)).toEqual([25, 25]);
    expect(t.balance('buyer')).toBe(25);
  });

  it('a read before available_at releases nothing, through the extra hour after the 7-day window', async () => {
    const t = ledger();
    t.purchaseRow('pay-1');
    await earnCashback(t, ago(7 * DAY_MS + 59 * 60_000)); // available in a minute

    expect((await t.svc.wallet('buyer')).balance_etb).toBe(0);
    expect(states(t, 'buyer')).toEqual([['cashback', 'pending']]);
    // Neither the pending credit nor a release of nothing writes a wallet.
    expect(t.db.repo(Wallet).rows).toHaveLength(0);
  });

  it('a spend that needs a matured credit succeeds', async () => {
    const t = ledger();
    t.purchaseRow('pay-1');
    await t.svc.credit('buyer', 10, 'topup', 'pay-0', 'Wallet top-up');
    await earnCashback(t, ago(8 * DAY_MS));

    await expect(t.svc.debit('buyer', 30, 'purchase', 'pay-2', 'Paid for "Other"')).resolves.toBe(5);
    expect(t.balance('buyer')).toBe(5);
    expect(states(t, 'buyer')).toEqual([
      ['topup', 'available'],
      ['cashback', 'available'],
      ['purchase', 'available'],
    ]);
  });

  it('a spend that needs a still-pending credit fails with the usual 400 and changes nothing', async () => {
    const t = ledger();
    t.purchaseRow('pay-1');
    await t.svc.credit('buyer', 10, 'topup', 'pay-0', 'Wallet top-up');
    await earnCashback(t, new Date());

    await expect(t.svc.debit('buyer', 30, 'purchase', 'pay-2', 'Paid for "Other"')).rejects.toThrow(
      new BadRequestException('Wallet balance (10.00 ETB) is not enough for 30.00 ETB'),
    );
    expect(t.balance('buyer')).toBe(10);
    expect(states(t, 'buyer')).toEqual([
      ['topup', 'available'],
      ['cashback', 'pending'],
    ]);
  });

  it('never releases a credit whose purchase has an open refund request, by read or by spend', async () => {
    const t = ledger();
    t.purchaseRow('pay-1', { refund_requested_at: ago(DAY_MS) });
    await t.svc.credit('buyer', 10, 'topup', 'pay-0', 'Wallet top-up');
    await earnCashback(t, ago(8 * DAY_MS));

    expect((await t.svc.wallet('buyer')).balance_etb).toBe(10);
    await expect(t.svc.debit('buyer', 30, 'purchase', 'pay-2', 'Paid for "Other"')).rejects.toThrow(BadRequestException);
    expect(t.balance('buyer')).toBe(10);
    expect(states(t, 'buyer')).toEqual([
      ['topup', 'available'],
      ['cashback', 'pending'],
    ]);
  });

  it('never releases a credit whose purchase was refunded, even when the void did not run', async () => {
    const t = ledger();
    // No mark, so only the payment status holds it back.
    t.purchaseRow('pay-1', { status: PaymentStatus.REFUNDED });
    await earnCashback(t, ago(8 * DAY_MS));

    expect((await t.svc.wallet('buyer')).balance_etb).toBe(0);
    expect(states(t, 'buyer')).toEqual([['cashback', 'pending']]);
  });

  it("holds a referral reward on the buyer's purchase: it waits out a refund request and releases once that is cleared", async () => {
    const t = ledger();
    t.db.repo(Referral).rows.push({ id: 'ref-1', referrer_id: 'referrer', referred_user_id: 'buyer', status: 'signed_up', reward_etb: '0' });
    t.purchaseRow('pay-1', { refund_requested_at: ago(DAY_MS) });
    await t.db.dataSource.transaction((m) => t.svc.rewardReferrer(m as never, purchase(), 'Buyer', ago(8 * DAY_MS)));

    expect((await t.svc.wallet('referrer')).balance_etb).toBe(0);

    t.db.repo(Payment).rows[0].refund_requested_at = null; // the request was denied
    expect((await t.svc.wallet('referrer')).balance_etb).toBe(50);
    expect(states(t, 'referrer')).toEqual([['referral_reward', 'available']]);
  });

  it('top-ups and admin adjustments land in the balance at once, as before', async () => {
    const t = ledger();
    await t.svc.credit('u1', 100, 'topup', 'pay-0', 'Wallet top-up');
    await t.svc.adminAdjust('adm', 'u1', 20, 'goodwill');
    await t.svc.adminAdjust('adm', 'u1', -5, 'correction');

    expect(t.balance('u1')).toBe(115);
    expect(t.movements('u1').map((m) => [m.kind, m.amount_etb, m.state, m.available_at, m.payment_id])).toEqual([
      ['topup', '100.00', 'available', null, null],
      ['admin_adjust', '20.00', 'available', null, null],
      ['admin_adjust', '-5.00', 'available', null, null],
    ]);
  });
});

describe('GrowthService.recordCouponUse', () => {
  it("counts the use through the caller's transaction", async () => {
    const { db, svc } = ledger();
    db.repo(Coupon).rows.push({ id: 'cp-1', code: 'HALF', uses: 0 });
    await expect(
      db.dataSource.transaction(async (m) => {
        await svc.recordCouponUse('HALF', m as never);
        throw new Error('confirmation rolled back');
      }),
    ).rejects.toThrow();
    expect(db.repo(Coupon).rows[0].uses).toBe(0);
    await db.dataSource.transaction((m) => svc.recordCouponUse('HALF', m as never));
    expect(db.repo(Coupon).rows[0].uses).toBe(1);
  });
});

describe('GrowthService.claim', () => {
  it('stays idempotent when the same account claims twice at once (unique referred account)', async () => {
    const { db, svc } = ledger();
    db.repo(ReferralCode).rows.push({ id: 'referrer', user_id: 'referrer', code: 'FRIEND22' });
    const ctx = { id: 'newbie', role: 'learner', email: 'newbie@x.et' } as never;

    const [a, b] = await Promise.all([svc.claim(ctx, 'friend22'), svc.claim(ctx, 'FRIEND22')]);

    expect(a).toEqual({ claimed: true, referrer_id: 'referrer', status: 'signed_up' });
    expect(b).toEqual({ claimed: true, referrer_id: 'referrer', status: 'signed_up' });
    expect(db.repo(Referral).rows.filter((r) => r.referred_user_id === 'newbie')).toHaveLength(1);
  });
});
