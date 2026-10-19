import { BadRequestException, Logger, ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { PeerAsleepError } from '@ethiopialearn/common';
import { OwnerType, Role } from '@ethiopialearn/contracts';
import { FinancialController } from './controllers';
import { PaymentService } from './payment.service';
import { PayoutService } from './payout.service';
import { SponsorshipService } from './sponsorship.service';

/** Phase 9e: list reads make one internal call per batch endpoint, and display data degrades. */
const admin = { id: 'a1', role: Role.PLATFORM_ADMIN, email: 'a@e.et' } as never;

/** Answers the batch endpoints from their query string; `down` makes every call fail as a sleeping peer would. */
function batchClient(opts: { down?: boolean } = {}) {
  return {
    get: jest.fn(async (path: string) => {
      if (opts.down) throw new PeerAsleepError();
      const list = decodeURIComponent(path.split('=')[1].split('&')[0]).split(',');
      if (path.includes('/entitlements/progress')) {
        return list
          .filter((pair) => !pair.startsWith('ghost'))
          .map((pair) => ({ learner_id: pair.split(':')[0], course_id: pair.split(':')[1], active: true, progress_percent: 40, lessons_complete: false }));
      }
      if (path.includes('/internal/users?')) return list.map((id) => ({ id, name: `Name ${id}`, role: 'educator', email: `${id}@e.et` }));
      throw new Error(`unexpected ${path}`);
    }),
  };
}

const seat = (i: number, patch: Record<string, unknown> = {}) => ({
  id: `s${i}`,
  source: 'bulk',
  status: 'granted',
  recipient_user_id: `u${i}`,
  recipient_email: `u${i}@e.et`,
  course_id: 'c1',
  bulk_purchase_id: `b${i % 2}`,
  ...patch,
});

function sponsorshipSetup(seats: ReturnType<typeof seat>[], opts: { down?: boolean } = {}) {
  const sponsorships = { find: jest.fn(async () => seats) };
  const bulk = { find: jest.fn(async () => [{ id: 'b0', seats: 40, unit_price_etb: '100', total_etb: '4000' }, { id: 'b1', seats: 40 }]) };
  const internal = batchClient(opts);
  const service = new SponsorshipService(sponsorships as never, bulk as never, {} as never, {} as never, internal as never, {} as never);
  return { service, sponsorships, internal };
}

describe('SponsorshipService.listBulk (Phase 9e)', () => {
  it('60 seats over 2 orders: one seats query and 2 progress batch calls', async () => {
    const t = sponsorshipSetup(Array.from({ length: 60 }, (_, i) => seat(i)));
    const orders = await t.service.listBulk(admin);
    expect(t.sponsorships.find).toHaveBeenCalledTimes(1);
    expect(t.internal.get).toHaveBeenCalledTimes(2);
    expect(orders.map((o) => o.assignments.length)).toEqual([30, 30]);
    expect(orders[0].assignments[0].progress).toEqual({ progress_percent: 40, lessons_complete: false });
  });

  it('a seat not granted asks nothing; a granted seat with no enrollment yet reads as not started', async () => {
    const t = sponsorshipSetup([seat(0, { status: 'pending_claim', recipient_user_id: null }), seat(2, { recipient_user_id: 'ghost' })]);
    const [order] = await t.service.listBulk(admin);
    expect(order.assignments.map((a) => a.progress)).toEqual([null, { progress_percent: 0, lessons_complete: false }]);
    expect(t.internal.get).toHaveBeenCalledTimes(1);
  });

  it('enrollment asleep: 200 with progress null on every seat', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t = sponsorshipSetup([seat(0), seat(2)], { down: true });
    const [order] = await t.service.listBulk(admin);
    expect(order.assignments.map((a) => a.progress)).toEqual([null, null]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('PaymentService.adminList names (Phase 9e)', () => {
  const payment = (i: number) => ({ id: `p${i}`, learner_id: `l${i % 5}`, amount_etb: '100', discount_etb: '0', created_at: new Date() });

  function paymentSetup(opts: { down?: boolean } = {}) {
    const payments = { findAndCount: jest.fn(async () => [Array.from({ length: 20 }, (_, i) => payment(i)), 20]) };
    const internal = batchClient(opts);
    const service = new PaymentService(payments as never, {} as never, {} as never, internal as never, {} as never, {} as never);
    return { service, internal };
  }

  it('20 payments by 5 learners: one users call', async () => {
    const t = paymentSetup();
    const page = await t.service.adminList(1, 20);
    expect(t.internal.get).toHaveBeenCalledTimes(1);
    expect(t.internal.get.mock.calls[0][0]).toContain('&fields=email');
    expect(page.items[0]).toEqual(expect.objectContaining({ learner_name: 'Name l0', learner_email: 'l0@e.et' }));
  });

  it('auth asleep: the placeholders, never an error', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const page = await paymentSetup({ down: true }).service.adminList(1, 20);
    expect(page.items[0]).toEqual(expect.objectContaining({ learner_name: '(unknown)', learner_email: '' }));
  });
});

describe('PayoutService admin listing (Phase 9e)', () => {
  const payout = (i: number, type: OwnerType) => ({ id: `po${i}`, payee_id: `payee${i}`, payee_type: type, created_at: new Date() });

  function payoutSetup(opts: { down?: boolean } = {}) {
    const rows = [payout(1, OwnerType.EDUCATOR), payout(2, OwnerType.INSTITUTION), payout(3, OwnerType.EDUCATOR)];
    const payouts = { find: jest.fn(async () => rows) };
    const internal = batchClient(opts);
    const service = new PayoutService({} as never, payouts as never, {} as never, {} as never, internal as never, {} as never, {} as never);
    return { service, internal };
  }

  it('names educator payees from one users call; an institution payee keeps null', async () => {
    const t = payoutSetup();
    const rows = await t.service.listAll();
    expect(t.internal.get).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r.payee_name)).toEqual(['Name payee1', null, 'Name payee3']);
  });

  it('auth asleep: payee_name null on every row', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect((await payoutSetup({ down: true }).service.listAll()).map((r) => r.payee_name)).toEqual([null, null, null]);
  });
});

describe('FinancialController own lists (Phase 9e review S3)', () => {
  const page = { items: [{ id: 'p1' }], total: 41 };
  const controller = new FinancialController(
    { listMine: jest.fn(async () => page) } as never,
    {} as never,
    { listForPayee: jest.fn(async () => page), resolvePayeeId: jest.fn(async () => 'edu1') } as never,
  );
  const educator = { id: 'edu1', role: Role.EDUCATOR, email: 'e@e.et' } as never;
  const learner = { id: 'u1', role: Role.LEARNER, email: 'u@e.et' } as never;

  it('answers { items, total } with paged=1 and the bare page otherwise', async () => {
    expect(await controller.myPayments(learner, { page: 1, limit: 20, paged: '1' })).toEqual(page);
    expect(await controller.myPayments(learner, { page: 1, limit: 20 })).toEqual(page.items);
    expect(await controller.payouts(educator, { page: 2, limit: 20, paged: '1' })).toEqual(page);
    expect(await controller.payouts(educator, { page: 2, limit: 20 })).toEqual(page.items);
  });

  it('the admin ?payee_id= listing honours paged=1 too, with payee names', async () => {
    const withPayeeNames = jest.fn(async (rows: { id: string }[]) => rows.map((r) => ({ ...r, payee_name: 'Edu' })));
    const listForPayee = jest.fn(async () => page);
    const admin = { id: 'a1', role: Role.PLATFORM_ADMIN, email: 'a@e.et' } as never;
    const adminController = new FinancialController({} as never, {} as never, { listForPayee, withPayeeNames, listAll: jest.fn() } as never);
    const named = [{ id: 'p1', payee_name: 'Edu' }];
    expect(await adminController.payouts(admin, { page: 3, limit: 10, paged: '1' }, 'payee9')).toEqual({ items: named, total: 41 });
    expect(await adminController.payouts(admin, { page: 3, limit: 10 }, 'payee9')).toEqual(named);
    expect(listForPayee).toHaveBeenLastCalledWith('payee9', 3, 10);
  });
});

describe('FinancialController payouts ?payee_id=', () => {
  const pipe = (() => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, FinancialController, 'payouts');
    const arg = Object.values<{ data?: string; pipes: unknown[] }>(args).find((a) => a.data === 'payee_id');
    return arg?.pipes[0] as ParseUUIDPipe;
  })();
  const meta = { type: 'query' as const, data: 'payee_id' };

  it('carries a ParseUUIDPipe', () => expect(pipe).toBeInstanceOf(ParseUUIDPipe));

  it('passes a uuid or no value', async () => {
    const id = '3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d';
    await expect(pipe.transform(id, meta)).resolves.toBe(id);
    await expect(pipe.transform(undefined as never, meta)).resolves.toBeUndefined();
  });

  it.each([['a non-uuid', 'payee9'], ['a repeated key', ['3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d', '3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3e']]])(
    'answers %s with a 400',
    async (_label, value) => {
      await expect(pipe.transform(value as never, meta)).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});
