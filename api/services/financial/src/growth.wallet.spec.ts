import { BadRequestException } from '@nestjs/common';
import { PaymentMethod, PaymentPurpose } from '@ethiopialearn/contracts';
import { Coupon, Payment, Referral, ReferralCode, Wallet, WalletTransaction } from './entities';
import { GrowthService } from './growth.service';
import { fakeDb } from './testing/fake-db';

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
  return { db, bus, svc, balance, movements };
}

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

  it('pays cashback once per payment', async () => {
    const { db, svc, balance } = ledger();
    await db.dataSource.transaction((m) => svc.creditCashback(m as never, purchase()));
    const again = await db.dataSource.transaction((m) => svc.creditCashback(m as never, purchase()));
    expect(again).toBeNull();
    expect(balance('buyer')).toBe(25);
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

  it('rewards the referrer once when two first purchases confirm at the same time', async () => {
    const { db, svc, balance } = ledger();
    db.repo(Referral).rows.push({ id: 'ref-1', referrer_id: 'referrer', referred_user_id: 'buyer', status: 'signed_up', reward_etb: '0' });

    const results = await Promise.all([
      db.dataSource.transaction((m) => svc.rewardReferrer(m as never, purchase({ id: 'pay-1' }), 'Buyer')),
      db.dataSource.transaction((m) => svc.rewardReferrer(m as never, purchase({ id: 'pay-2' }), 'Buyer')),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(balance('referrer')).toBe(50);
    expect(db.repo(Referral).rows[0]).toMatchObject({ status: 'rewarded', reward_etb: '50.00' });
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
