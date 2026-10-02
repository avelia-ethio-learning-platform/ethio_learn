import { HttpStatus } from '@nestjs/common';
import { Coupon, Referral, ReferralCode, Wallet, WalletTransaction } from './entities';
import { GrowthService } from './growth.service';
import { fakeDb } from './testing/fake-db';

const ACCOUNTS = new Set(['member@x.et']);
const ME = { id: 'me', role: 'learner', email: 'me@x.et' } as never;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

function setup() {
  const db = fakeDb();
  const bus = { publish: jest.fn().mockResolvedValue(undefined) };
  const internal = {
    get: jest.fn(async (path: string) => {
      const byEmail = /\/internal\/users\/by-email\/(.+)$/.exec(path);
      if (byEmail) {
        if (!ACCOUNTS.has(decodeURIComponent(byEmail[1]))) throw new Error('404');
        return { id: 'someone', email: decodeURIComponent(byEmail[1]) };
      }
      return { email: 'me@x.et', name: 'Me' };
    }),
  };
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
  db.repo(ReferralCode).rows.push({ id: 'code-me', user_id: 'me', code: 'MYCODE22' });
  const sent = () => bus.publish.mock.calls.filter((c: unknown[]) => c[0] === 'ReferralInviteSent').map((c: any[]) => c[1].to_email);
  const rows = () => db.repo(Referral).rows;
  return { svc, db, bus, sent, rows };
}

describe('GrowthService.invite', () => {
  const OLD_ENV = process.env.REFERRAL_INVITES_PER_DAY;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.REFERRAL_INVITES_PER_DAY;
    else process.env.REFERRAL_INVITES_PER_DAY = OLD_ENV;
  });

  it('emails and stores only new addresses, and answers with the count alone', async () => {
    const t = setup();
    t.rows().push({ id: 'r0', referrer_id: 'me', referred_email: 'before@x.et', status: 'invited', created_at: hoursAgo(48) });
    const res = await t.svc.invite(ME, ['new1@x.et', 'member@x.et', 'before@x.et', 'me@x.et', 'new2@x.et', 'NEW1@x.et'], 'hi', 'learner');
    expect(res).toEqual({ invited: 2 });
    expect(t.sent()).toEqual(['new1@x.et', 'new2@x.et']);
    expect(t.rows().map((r) => r.referred_email)).toEqual(['before@x.et', 'new1@x.et', 'new2@x.et']);
  });

  it('publishes nothing for an existing account or an address this referrer already invited', async () => {
    const t = setup();
    t.rows().push({ id: 'r0', referrer_id: 'me', referred_email: 'before@x.et', status: 'invited', created_at: hoursAgo(48) });
    await expect(t.svc.invite(ME, ['member@x.et', 'before@x.et'], '', 'learner')).resolves.toEqual({ invited: 0 });
    expect(t.bus.publish).not.toHaveBeenCalled();
    expect(t.rows()).toHaveLength(1);
  });

  it('skips silently an address anyone invited in the last 7 days, but not an older one', async () => {
    const t = setup();
    t.rows().push(
      { id: 'r1', referrer_id: 'other', referred_email: 'taken@x.et', status: 'invited', created_at: hoursAgo(24 * 6) },
      { id: 'r2', referrer_id: 'other', referred_email: 'stale@x.et', status: 'invited', created_at: hoursAgo(24 * 8) },
    );
    const res = await t.svc.invite(ME, ['taken@x.et', 'stale@x.et', 'free@x.et'], '', 'learner');
    expect(res).toEqual({ invited: 2 });
    expect(t.sent()).toEqual(['stale@x.et', 'free@x.et']);
  });

  it('answers 429 once the 24 h allowance is used, changing nothing', async () => {
    process.env.REFERRAL_INVITES_PER_DAY = '2';
    const t = setup();
    t.rows().push(
      { id: 'r1', referrer_id: 'me', referred_email: 'a@x.et', status: 'invited', created_at: hoursAgo(1) },
      { id: 'r2', referrer_id: 'me', referred_email: 'b@x.et', status: 'invited', created_at: hoursAgo(23) },
    );
    const err = await t.svc.invite(ME, ['c@x.et'], '', 'learner').catch((e) => e);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(err.message).toBe("You've reached today's limit for referral invites. Try again tomorrow.");
    expect(t.rows()).toHaveLength(2);
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('does not count invites older than 24 h, or other referrers', async () => {
    process.env.REFERRAL_INVITES_PER_DAY = '1';
    const t = setup();
    t.rows().push(
      { id: 'r1', referrer_id: 'me', referred_email: 'old@x.et', status: 'invited', created_at: hoursAgo(25) },
      { id: 'r2', referrer_id: 'other', referred_email: 'o@x.et', status: 'invited', created_at: hoursAgo(1) },
    );
    await expect(t.svc.invite(ME, ['c@x.et'], '', 'learner')).resolves.toEqual({ invited: 1 });
  });

  it('fills the allowance in request order when it runs out partway', async () => {
    process.env.REFERRAL_INVITES_PER_DAY = '3';
    const t = setup();
    t.rows().push({ id: 'r1', referrer_id: 'me', referred_email: 'a@x.et', status: 'invited', created_at: hoursAgo(2) });
    const res = await t.svc.invite(ME, ['b@x.et', 'c@x.et', 'd@x.et'], '', 'learner');
    expect(res).toEqual({ invited: 2 });
    expect(t.sent()).toEqual(['b@x.et', 'c@x.et']);
    expect(t.rows()).toHaveLength(3);
  });

  it('logs the user id and the path on a cap hit, not the addresses', async () => {
    process.env.REFERRAL_INVITES_PER_DAY = '1';
    const t = setup();
    t.rows().push({ id: 'r1', referrer_id: 'me', referred_email: 'a@x.et', status: 'invited', created_at: hoursAgo(1) });
    const warn = jest.spyOn((t.svc as any).logger, 'warn').mockImplementation(() => undefined);
    await t.svc.invite(ME, ['secret-address@x.et'], '', 'learner').catch(() => undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('user me'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/referrals/invite'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('secret-address'));
  });
});
