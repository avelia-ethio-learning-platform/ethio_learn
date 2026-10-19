import { HttpStatus } from '@nestjs/common';
import { PeerAsleepError, PeerNotFoundError } from '@ethiopialearn/common';
import { Coupon, Referral, ReferralCode, Wallet, WalletTransaction } from './entities';
import { GrowthService } from './growth.service';
import { fakeDb, fakeOutbox } from './testing/fake-db';

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
        if (!ACCOUNTS.has(decodeURIComponent(byEmail[1]))) throw new PeerNotFoundError();
        return { id: 'someone', email: decodeURIComponent(byEmail[1]) };
      }
      return { email: 'me@x.et', name: 'Me' };
    }),
  };
  const tx = fakeOutbox(db.dataSource);
  const svc = new GrowthService(
    db.repo(Coupon) as never,
    db.repo(Wallet) as never,
    db.repo(WalletTransaction) as never,
    db.repo(ReferralCode) as never,
    db.repo(Referral) as never,
    db.dataSource as never,
    bus as never,
    internal as never,
    tx.outbox as never,
  );
  db.repo(ReferralCode).rows.push({ id: 'code-me', user_id: 'me', code: 'MYCODE22' });
  /** Invite emails committed with their rows (the outbox publishes them after commit). */
  const sent = () => tx.committed.filter(([type]) => type === 'ReferralInviteSent').map(([, p]) => (p as { to_email: string }).to_email);
  const rows = () => db.repo(Referral).rows;
  return { svc, db, bus, internal, sent, rows, committed: tx.committed };
}

describe('GrowthService.invite', () => {
  it('auth asleep: 503, with no referral row and no event (only a 404 means "no account")', async () => {
    const t = setup();
    t.internal.get.mockImplementation(async (path: string) => {
      if (path.includes('/by-email/')) throw new PeerAsleepError();
      return { email: 'me@x.et', name: 'Me' };
    });
    await expect(t.svc.invite(ME, ['new1@x.et'], '', 'learner')).rejects.toBeInstanceOf(PeerAsleepError);
    expect(t.rows()).toHaveLength(0);
    expect(t.committed).toHaveLength(0);
  });

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
    expect(t.committed).toHaveLength(0);
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
    expect(t.committed).toHaveLength(0);
    expect(t.internal.get).not.toHaveBeenCalled();
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

describe('GrowthService: invite and code races (P2-03)', () => {
  it('two concurrent invites of one address by one referrer make one row and one email', async () => {
    const t = setup();
    const results = await Promise.all([t.svc.invite(ME, ['dup@x.et'], '', 'learner'), t.svc.invite(ME, ['dup@x.et'], '', 'learner')]);
    expect(results.map((r) => r.invited).sort()).toEqual([0, 1]);
    expect(t.rows().filter((r) => r.referred_email === 'dup@x.et')).toHaveLength(1);
    expect(t.sent()).toEqual(['dup@x.et']);
  });

  it('two concurrent first calls for a referral code agree on one code and never throw', async () => {
    const t = setup();
    t.db.repo(ReferralCode).rows.length = 0;
    const svc = t.svc as unknown as { codeFor(userId: string): Promise<string> };
    const [a, b] = await Promise.all([svc.codeFor('fresh-user'), svc.codeFor('fresh-user')]);
    expect(a).toBe(b);
    expect(t.db.repo(ReferralCode).rows.filter((r) => r.user_id === 'fresh-user')).toHaveLength(1);
  });
});
