import { HttpStatus } from '@nestjs/common';
import { BulkPurchase, Sponsorship } from './entities';
import { SponsorshipService } from './sponsorship.service';
import { fakeDb, fakeOutbox } from './testing/fake-db';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const ME = { id: 'me', role: 'learner', email: 'me@x.et' } as never;
const COURSE = { id: 'c1', title: 'Course', status: 'published', pricing_type: 'paid', price_etb: 500, owner_id: 'edu', owner_type: 'educator' };

function setup() {
  const db = fakeDb();
  const bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.includes('/by-email/')) throw new Error('404');
      if (path.includes('/entitlements')) return { entitlement_status: 'none' };
      return { email: 'me@x.et', name: 'Me' };
    }),
  };
  const payments = {
    courseInfo: jest.fn(async () => COURSE),
    createSession: jest.fn(async () => ({ confirmed: false, payment_id: 'pay-1', checkout_url: 'https://pay.example/x' })),
    onPurposeConfirmed: jest.fn(),
  };
  const svc = new SponsorshipService(db.repo(Sponsorship) as never, db.repo(BulkPurchase) as never, payments as never, bus as never, internal as never, fakeOutbox(db.dataSource).outbox as never);
  const rows = () => db.repo(Sponsorship).rows;
  const published = () => bus.publish.mock.calls.filter((c: unknown[]) => c[0] === 'PayRequestCreated');
  const payRequest = (over: Record<string, unknown> = {}) => ({
    id: `pr-${rows().length + 1}`,
    source: 'pay_request',
    status: 'requested',
    sponsor_id: null,
    recipient_user_id: 'me',
    recipient_email: 'me@x.et',
    course_id: 'c1',
    organization_name: 'payer@x.et',
    token: `TOK${rows().length + 1}`,
    created_at: hoursAgo(1),
    ...over,
  });
  const gift = (over: Record<string, unknown> = {}) => ({
    id: `g-${rows().length + 1}`,
    source: 'gift',
    status: 'pending_payment',
    sponsor_id: 'me',
    recipient_email: 'a@x.et',
    course_id: 'c1',
    created_at: hoursAgo(1),
    ...over,
  });
  return { svc, db, bus, payments, rows, published, payRequest, gift };
}

const ENV_KEYS = ['PAY_REQUESTS_PER_DAY', 'GIFTS_PER_DAY'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('SponsorshipService.createPayRequest caps', () => {
  const dto = { course_id: 'c1', payer_email: 'Payer@x.et' };

  it('creates and emails the first request', async () => {
    const t = setup();
    const res = await t.svc.createPayRequest(ME, dto);
    expect(res).toMatchObject({ status: 'requested', pay_url: expect.stringContaining('/pay/') });
    expect(t.rows()).toHaveLength(1);
    expect(t.published()).toHaveLength(1);
  });

  it.each(['requested', 'pending_payment'])('returns the existing %s request for the same course and payer: no row, no email', async (status) => {
    const t = setup();
    const open = t.payRequest({ status });
    t.rows().push(open);
    const res = await t.svc.createPayRequest(ME, dto);
    expect(res).toEqual({ sponsorship_id: open.id, pay_url: expect.stringContaining(`/pay/${open.token}`), status });
    expect(t.rows()).toHaveLength(1);
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('dedupes before the caps: an open duplicate is returned even at both caps', async () => {
    process.env.PAY_REQUESTS_PER_DAY = '1';
    const t = setup();
    t.rows().push(t.payRequest());
    await expect(t.svc.createPayRequest(ME, dto)).resolves.toMatchObject({ sponsorship_id: 'pr-1' });
  });

  it('does not dedupe against a closed request, another course or another payer', async () => {
    const t = setup();
    t.rows().push(
      t.payRequest({ status: 'cancelled' }),
      t.payRequest({ course_id: 'c2', organization_name: 'payer@x.et' }),
      t.payRequest({ organization_name: 'other@x.et' }),
    );
    const res = await t.svc.createPayRequest(ME, dto);
    expect(res.sponsorship_id).not.toBe('pr-1');
    expect(t.rows()).toHaveLength(4);
    expect(t.published()).toHaveLength(1);
  });

  it('answers 429 at the per-account cap (default 5 a day), counting only this requester and the last 24 h', async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) t.rows().push(t.payRequest({ organization_name: `p${i}@x.et`, status: 'granted' }));
    t.rows().push(t.payRequest({ recipient_user_id: 'else', organization_name: 'z@x.et' }), t.payRequest({ organization_name: 'old@x.et', created_at: hoursAgo(25) }));
    const err = await t.svc.createPayRequest(ME, dto).catch((e) => e);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(err.message).toBe("You've reached today's limit for pay requests. Try again tomorrow.");
    expect(t.rows()).toHaveLength(7);
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('honours PAY_REQUESTS_PER_DAY', async () => {
    process.env.PAY_REQUESTS_PER_DAY = '1';
    const t = setup();
    t.rows().push(t.payRequest({ organization_name: 'p0@x.et', status: 'granted' }));
    await expect(t.svc.createPayRequest(ME, dto)).rejects.toMatchObject({ status: 429 });
  });

  it('answers 429 at 3 requests a day to one payer email across requesters, with the recipient message', async () => {
    const t = setup();
    for (const who of ['u1', 'u2', 'u3']) t.rows().push(t.payRequest({ recipient_user_id: who, status: 'granted' }));
    const err = await t.svc.createPayRequest(ME, dto).catch((e) => e);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(err.message).toBe("You've reached today's limit for pay requests to this email. Try again tomorrow.");
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('counts only the last 24 h toward the per-recipient cap', async () => {
    const t = setup();
    for (const who of ['u1', 'u2', 'u3']) t.rows().push(t.payRequest({ recipient_user_id: who, created_at: hoursAgo(25) }));
    await expect(t.svc.createPayRequest(ME, dto)).resolves.toMatchObject({ status: 'requested' });
  });

  it('logs the user id and path on a cap hit, never the payer address', async () => {
    process.env.PAY_REQUESTS_PER_DAY = '1';
    const t = setup();
    t.rows().push(t.payRequest({ organization_name: 'p0@x.et', status: 'granted' }));
    const warn = jest.spyOn((t.svc as any).logger, 'warn').mockImplementation(() => undefined);
    await t.svc.createPayRequest(ME, dto).catch(() => undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('user me'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/pay-requests'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('payer@x.et'));
  });
});

describe('SponsorshipService.createGift cap', () => {
  const dto = { course_id: 'c1', recipient_email: 'sister@x.et' };

  it('answers 429 at 10 gifts in 24 h, before any checkout is created', async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) t.rows().push(t.gift());
    t.rows().push(t.gift({ sponsor_id: 'else' }), t.gift({ created_at: hoursAgo(25) }), t.payRequest({ sponsor_id: 'me' }));
    const err = await t.svc.createGift(ME, dto).catch((e) => e);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(err.message).toBe("You've reached today's limit for gifts. Try again tomorrow.");
    expect(t.payments.createSession).not.toHaveBeenCalled();
    expect(t.rows()).toHaveLength(13);
  });

  it('lets a gift through below the cap and honours GIFTS_PER_DAY', async () => {
    const t = setup();
    for (let i = 0; i < 9; i++) t.rows().push(t.gift());
    await expect(t.svc.createGift(ME, dto)).resolves.toMatchObject({ sponsorship_id: expect.any(String) });
    expect(t.payments.createSession).toHaveBeenCalledTimes(1);

    process.env.GIFTS_PER_DAY = '2';
    const small = setup();
    small.rows().push(small.gift(), small.gift());
    await expect(small.svc.createGift(ME, dto)).rejects.toMatchObject({ status: 429 });
  });
});
