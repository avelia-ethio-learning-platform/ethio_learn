import { INestApplication, Logger, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FindOperator } from 'typeorm';
import { Role, UserStatus } from '@ethiopialearn/contracts';
import { AuthController } from './auth.controller';
import { AuthService, RESEND_VERIFICATION_MESSAGE } from './auth.service';
import { EmailVerification, User } from './entities';

/**
 * Resend verification (P1-34): one answer for every valid request, a fresh
 * link only for an active, unverified account within its caps (1 per 60 s,
 * 5 per 24 h, signup's link included), checked under a row lock on the user,
 * and the event only after the commit. The real-Postgres burst test is
 * auth.resend-verification.db.spec.ts.
 */
type Row = Record<string, any>;

const MESSAGE = "If an unverified account exists for that email, we've sent a new link.";
const EMAIL = 'learner@x.et';
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (want instanceof FindOperator) {
      if (want.type === 'moreThan') return row[key] > (want.value as Date);
      throw new Error(`unsupported operator ${want.type}`);
    }
    return row[key] === want;
  });
}

function setup(opts: { user?: Row | null; sentAgo?: number[]; publishFails?: boolean } = {}) {
  const calls: string[] = [];
  const user: Row | null =
    opts.user === null
      ? null
      : { id: 'u1', email: EMAIL, name: 'Abebe', role: Role.LEARNER, status: UserStatus.ACTIVE, email_verified_at: null, ...opts.user };
  const userRows = user ? [user] : [];
  const verificationRows: Row[] = (opts.sentAgo ?? []).map((s, i) => ({ id: `v${i}`, user_id: 'u1', token: `old-${i}`, created_at: secondsAgo(s) }));

  const users = {
    findOne: jest.fn(async (o: { where: Row; lock?: { mode: string } }) => {
      if (o.lock) calls.push(`lock:${o.lock.mode}`);
      const hit = userRows.find((r) => matches(r, o.where));
      return hit ? { ...hit } : null;
    }),
    create: jest.fn((x: Row) => ({ ...x })),
    save: jest.fn(async (x: Row) => ({ ...x, id: 'u-new' })),
  };
  const verifications = {
    create: jest.fn((x: Row) => ({ ...x })),
    count: jest.fn(async (o: { where: Row }) => verificationRows.filter((r) => matches(r, o.where)).length),
    save: jest.fn(async (x: Row) => {
      calls.push('insert');
      const row = { id: `v-new-${verificationRows.length}`, created_at: new Date(), ...x };
      verificationRows.push(row);
      return row;
    }),
  };
  const manager = {
    getRepository: (entity: unknown) => {
      if (entity === User) return users;
      if (entity === EmailVerification) return verifications;
      throw new Error('unexpected repository');
    },
  };
  const dataSource = {
    transaction: jest.fn(async (fn: (m: typeof manager) => Promise<unknown>) => {
      const result = await fn(manager);
      calls.push('commit');
      return result;
    }),
  };
  const bus = {
    publish: jest.fn(async (type: string) => {
      calls.push(`publish:${type}`);
      if (opts.publishFails) throw new Error('broker unreachable');
    }),
  };
  const svc = new AuthService(users as never, verifications as never, {} as never, {} as never, bus as never, dataSource as never);
  (svc as unknown as { redis: { disconnect?: () => void } }).redis.disconnect?.();
  const logger = (svc as unknown as { logger: Logger }).logger;
  const logs = jest.spyOn(logger, 'log');
  const errors = jest.spyOn(logger, 'error');
  const logged = () => [...logs.mock.calls, ...errors.mock.calls].map(([line]) => String(line));
  const newRows = () => verificationRows.filter((r) => String(r.id).startsWith('v-new'));
  return { svc, bus, calls, dataSource, newRows, logged };
}

describe('AuthService.resendVerification', () => {
  it('uses the exact message from the plan', () => {
    expect(RESEND_VERIFICATION_MESSAGE).toBe(MESSAGE);
  });

  it('unknown email: no row, no event, the same message, logged as unknown', async () => {
    const t = setup({ user: null });
    await expect(t.svc.resendVerification('nobody@x.et')).resolves.toEqual({ message: MESSAGE });
    expect(t.newRows()).toEqual([]);
    expect(t.bus.publish).not.toHaveBeenCalled();
    expect(t.logged()).toEqual(['resend_verification outcome=unknown']);
  });

  it('verified account: nothing sent, the same message, logged as already_verified', async () => {
    const t = setup({ user: { email_verified_at: new Date('2026-09-01') }, sentAgo: [86_400 * 30] });
    await expect(t.svc.resendVerification(EMAIL)).resolves.toEqual({ message: MESSAGE });
    expect(t.newRows()).toEqual([]);
    expect(t.bus.publish).not.toHaveBeenCalled();
    expect(t.logged()).toEqual(['resend_verification outcome=already_verified user_id=u1']);
  });

  it.each([UserStatus.SUSPENDED, UserStatus.BANNED])('%s account: nothing sent even though unverified, the same message, logged as inactive', async (status) => {
    const t = setup({ user: { status }, sentAgo: [3600] });
    await expect(t.svc.resendVerification(EMAIL)).resolves.toEqual({ message: MESSAGE });
    expect(t.newRows()).toEqual([]);
    expect(t.bus.publish).not.toHaveBeenCalled();
    expect(t.logged()).toEqual(['resend_verification outcome=inactive user_id=u1']);
  });

  it('first resend: a fresh 24 h link row and one VerificationEmailRequested with its link (never UserRegistered)', async () => {
    const t = setup({ sentAgo: [120] }); // signup's link, two minutes ago
    await expect(t.svc.resendVerification('  Learner@X.et ')).resolves.toEqual({ message: MESSAGE });

    const [row] = t.newRows();
    expect(t.newRows()).toHaveLength(1);
    expect(row).toMatchObject({ user_id: 'u1', used_at: null });
    expect(row.token).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token).not.toBe('old-0');
    expect(Math.abs(row.expires_at.getTime() - (Date.now() + 24 * 3600 * 1000))).toBeLessThan(5000);

    expect(t.bus.publish).toHaveBeenCalledTimes(1);
    expect(t.bus.publish).toHaveBeenCalledWith('VerificationEmailRequested', {
      user_id: 'u1',
      email: EMAIL,
      name: 'Abebe',
      verification_url: `http://localhost:3000/verify-email?token=${row.token}`,
    });
    expect(t.bus.publish).not.toHaveBeenCalledWith('UserRegistered', expect.anything());
    expect(t.logged()).toEqual(['resend_verification outcome=sent user_id=u1']);
  });

  it('issues its link exactly the way signup does: a 64-hex token, 24 h expiry, the same URL shape', async () => {
    const signup = setup({ user: null });
    await signup.svc.signup({ email: 'New@X.et', password: 'Strong-passw0rd', name: 'New', role: Role.LEARNER });
    const resend = setup({ sentAgo: [120] });
    await resend.svc.resendVerification(EMAIL);

    for (const [t, event] of [[signup, 'UserRegistered'], [resend, 'VerificationEmailRequested']] as const) {
      const [row] = t.newRows();
      expect(row.token).toMatch(/^[0-9a-f]{64}$/);
      expect(Math.abs(row.expires_at.getTime() - (Date.now() + 24 * 3600 * 1000))).toBeLessThan(5000);
      expect(t.bus.publish).toHaveBeenCalledWith(event, expect.objectContaining({ verification_url: `http://localhost:3000/verify-email?token=${row.token}` }));
    }
  });

  it('locks the user row, counts and inserts inside the transaction, and publishes only after the commit', async () => {
    const t = setup({ sentAgo: [120] });
    await t.svc.resendVerification(EMAIL);
    expect(t.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(t.calls).toEqual(['lock:pessimistic_write', 'insert', 'commit', 'publish:VerificationEmailRequested']);
  });

  it('a second resend within 60 s sends nothing and answers the same, logged as capped', async () => {
    const t = setup({ sentAgo: [30] });
    await expect(t.svc.resendVerification(EMAIL)).resolves.toEqual({ message: MESSAGE });
    expect(t.newRows()).toEqual([]);
    expect(t.bus.publish).not.toHaveBeenCalled();
    expect(t.logged()).toEqual(['resend_verification outcome=capped user_id=u1']);
  });

  it('a sixth link in 24 h sends nothing and answers the same, logged as capped', async () => {
    const t = setup({ sentAgo: [23 * 3600, 6 * 3600, 3 * 3600, 3600, 120] });
    await expect(t.svc.resendVerification(EMAIL)).resolves.toEqual({ message: MESSAGE });
    expect(t.newRows()).toEqual([]);
    expect(t.bus.publish).not.toHaveBeenCalled();
    expect(t.logged()).toEqual(['resend_verification outcome=capped user_id=u1']);
  });

  it('links older than 24 h no longer count toward the daily cap', async () => {
    const t = setup({ sentAgo: [25 * 3600, 6 * 3600, 3 * 3600, 3600, 120] });
    await t.svc.resendVerification(EMAIL);
    expect(t.newRows()).toHaveLength(1);
    expect(t.bus.publish).toHaveBeenCalledTimes(1);
  });

  it('a broker failure after the commit still answers the same, and logs it without the email', async () => {
    const t = setup({ sentAgo: [120], publishFails: true });
    await expect(t.svc.resendVerification(EMAIL)).resolves.toEqual({ message: MESSAGE });
    expect(t.newRows()).toHaveLength(1);
    expect(t.logged()).toEqual([expect.stringMatching(/^resend_verification user_id=u1: .*not published: broker unreachable$/)]);
  });

  it('never writes the email address into its logs', async () => {
    for (const opts of [{ user: null }, { sentAgo: [120] }, { sentAgo: [30] }, { user: { status: UserStatus.BANNED } }, { user: { email_verified_at: new Date() } }]) {
      const t = setup(opts);
      await t.svc.resendVerification(EMAIL);
      for (const line of t.logged()) expect(line.toLowerCase()).not.toContain('x.et');
    }
  });
});

/** The HTTP contract through the same ValidationPipe the services install at boot. */
describe('POST /api/v1/auth/resend-verification', () => {
  const resendVerification = jest.fn(async () => ({ message: MESSAGE }));
  let app: INestApplication;
  let url: string;

  @Module({ controllers: [AuthController], providers: [{ provide: AuthService, useValue: { resendVerification } }] })
  class TestModule {}

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    url = `${await app.getUrl()}/api/v1/auth/resend-verification`;
  });
  afterAll(() => app.close());

  const post = (body: unknown) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('answers 200 with the message for a valid email', async () => {
    const res = await post({ email: EMAIL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: MESSAGE });
    expect(resendVerification).toHaveBeenCalledWith(EMAIL);
  });

  it.each([[{}], [{ email: 'not-an-email' }], [{ email: 42 }]])('answers 400 with the validation envelope for %j, before the service runs', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ statusCode: 400, error: 'Bad Request', message: expect.arrayContaining([expect.stringMatching(/^email /)]) });
    expect(resendVerification).not.toHaveBeenCalled();
  });

  it('takes an address of up to 254 characters and refuses a longer one with 400', async () => {
    const address = (lastLabel: number) => `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(lastLabel)}.et`;
    expect([address(58).length, address(59).length]).toEqual([254, 255]);

    expect((await post({ email: address(58) })).status).toBe(200);
    expect(resendVerification).toHaveBeenCalledTimes(1);

    const res = await post({ email: address(59) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ statusCode: 400, message: expect.arrayContaining(['email must be shorter than or equal to 254 characters']) });
    expect(resendVerification).toHaveBeenCalledTimes(1);
  });
});
