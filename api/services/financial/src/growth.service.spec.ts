import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@ethiopialearn/contracts';
import { GrowthService, randomCode } from './growth.service';
import { bulkDiscountPercent } from './payment.service';

function repo(rows: Record<string, unknown>[] = []) {
  return {
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    ),
    find: jest.fn(async () => rows),
    save: jest.fn(async (r: unknown) => r),
    create: jest.fn((r: unknown) => r),
    increment: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

function service(opts: { coupons?: Record<string, unknown>[]; internal?: Record<string, unknown> } = {}) {
  const coupons = repo(opts.coupons ?? []);
  const internal = { get: jest.fn().mockResolvedValue(opts.internal ?? { owner_id: 'edu-1', price_etb: 500 }) };
  const bus = { publish: jest.fn() };
  const svc = new GrowthService(
    coupons as never,
    repo() as never,
    repo() as never,
    repo() as never,
    repo() as never,
    {} as never,
    bus as never,
    internal as never,
  );
  return { svc, coupons, internal, bus };
}

const educator = { id: 'edu-1', role: Role.EDUCATOR, email: 'e@x.et' };
const admin = { id: 'adm', role: Role.PLATFORM_ADMIN, email: 'a@x.et' };

describe('GrowthService coupons', () => {
  it('prices a percent coupon and never goes below zero', async () => {
    const { svc } = service({ coupons: [{ code: 'HALF', kind: 'percent', value: '50', active: true, uses: 0, max_uses: null, expires_at: null, course_id: null }] });
    const q = await svc.quote('c1', 500, 'half');
    expect(q).toMatchObject({ list_price_etb: 500, discount_etb: 250, amount_due_etb: 250 });
    const { svc: svc2 } = service({ coupons: [{ code: 'BIG', kind: 'amount', value: '9999', active: true, uses: 0, max_uses: null, expires_at: null, course_id: null }] });
    const q2 = await svc2.quote('c1', 500, 'BIG');
    expect(q2.amount_due_etb).toBe(0);
    expect(q2.discount_etb).toBe(500);
  });

  it('rejects unknown, inactive, expired, exhausted and wrong-course codes with readable errors', async () => {
    const base = { kind: 'percent', value: '10', uses: 0, max_uses: null, expires_at: null, course_id: null, active: true };
    const { svc } = service({
      coupons: [
        { ...base, code: 'OFF', active: false },
        { ...base, code: 'OLD', expires_at: new Date(Date.now() - 1000) },
        { ...base, code: 'USED', max_uses: 2, uses: 2 },
        { ...base, code: 'OTHER', course_id: 'c-other' },
      ],
    });
    for (const code of ['NOPE', 'OFF', 'OLD', 'USED', 'OTHER']) {
      await expect(svc.quote('c1', 500, code)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('no code → no discount', async () => {
    const { svc } = service();
    expect(await svc.quote('c1', 500, '')).toEqual({ coupon: null, list_price_etb: 500, discount_etb: 0, amount_due_etb: 500 });
  });

  it('educators may only create coupons for courses they own, and never platform-wide', async () => {
    const { svc } = service({ internal: { owner_id: 'someone-else' } });
    await expect(svc.createCoupon(educator, { kind: 'percent', value: 10, course_id: 'c1' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.createCoupon(educator, { kind: 'percent', value: 10 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('admins can create platform-wide coupons; codes are upper-cased and validated', async () => {
    const { svc, coupons } = service();
    const c = (await svc.createCoupon(admin, { code: 'welcome20', kind: 'percent', value: 20 })) as { code: string; course_id: string | null };
    expect(c.code).toBe('WELCOME20');
    expect(c.course_id).toBeNull();
    expect(coupons.save).toHaveBeenCalled();
    await expect(svc.createCoupon(admin, { kind: 'percent', value: 150 })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('bulk volume tiers', () => {
  it('applies the highest tier the seat count reaches', () => {
    delete process.env.BULK_DISCOUNT_TIERS;
    expect(bulkDiscountPercent(2)).toBe(0);
    expect(bulkDiscountPercent(5)).toBe(10);
    expect(bulkDiscountPercent(9)).toBe(10);
    expect(bulkDiscountPercent(10)).toBe(20);
    expect(bulkDiscountPercent(49)).toBe(20);
    expect(bulkDiscountPercent(50)).toBe(30);
    expect(bulkDiscountPercent(5000)).toBe(30);
  });

  it('is env-overridable', () => {
    process.env.BULK_DISCOUNT_TIERS = '3:5,20:40';
    expect(bulkDiscountPercent(3)).toBe(5);
    expect(bulkDiscountPercent(25)).toBe(40);
    delete process.env.BULK_DISCOUNT_TIERS;
  });
});

describe('randomCode', () => {
  it('avoids look-alike characters and honours the length', () => {
    for (let i = 0; i < 50; i++) {
      const code = randomCode(8);
      expect(code).toHaveLength(8);
      expect(code).not.toMatch(/[0O1I]/);
    }
  });
});
