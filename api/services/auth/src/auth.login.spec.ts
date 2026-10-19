import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

/**
 * The flows that lock people out (Phase 11b, P1-29): login refusals issue no
 * token; reset and invite links fail when expired or used, and a reset ends
 * every session; Google sign-in creates a learner, links an existing account
 * and refuses a token it can't verify.
 */
const PASSWORD = 'Strong-passw0rd';

type Row = Record<string, unknown>;

function makeService(users: Row[], resets: Row[] = []) {
  const repo = {
    findOne: jest.fn(async ({ where }: { where: Row }) => users.find((u) => Object.entries(where).every(([k, v]) => u[k] === v)) ?? null),
    update: jest.fn(async (id: string, patch: Row) => Object.assign(users.find((u) => u.id === id) ?? {}, patch)),
    create: jest.fn((row: Row) => row),
    save: jest.fn(async (row: Row) => {
      const saved = { id: `new-${users.length}`, ...row };
      users.push(saved);
      return saved;
    }),
  };
  const resetRepo = { findOne: jest.fn(async () => resets[0] ?? null), save: jest.fn(async (r: Row) => r) };
  process.env.JWT_SECRET = 'test-secret-not-real';
  const svc = new AuthService(repo as never, {} as never, resetRepo as never, {} as never, {} as never, {} as never, {} as never);
  (svc as unknown as { redis: { disconnect?: () => void } }).redis.disconnect?.();
  const issue = jest.fn(async () => 'refresh-token');
  (svc as unknown as { issueRefreshToken: typeof issue }).issueRefreshToken = issue;
  const revoke = jest.spyOn(svc, 'revokeAllSessions').mockResolvedValue(2);
  return { svc, repo, resetRepo, issue, revoke };
}

async function user(over: Row = {}): Promise<Row> {
  return {
    id: 'u1',
    email: 'a@x.et',
    name: 'A',
    role: 'learner',
    status: 'active',
    password_hash: await bcrypt.hash(PASSWORD, 4),
    email_verified_at: new Date('2026-01-01'),
    must_change_password: false,
    ...over,
  };
}

describe('AuthService.login', () => {
  it('signs a verified, active user in', async () => {
    const { svc, issue } = makeService([await user()]);
    const res = await svc.login({ email: ' A@X.et ', password: PASSWORD });
    expect(res).toMatchObject({ refresh_token: 'refresh-token', user: { id: 'u1' } });
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a wrong password', async () => user(), 'Wrong-passw0rd', 'Invalid email or password'],
    ['an unknown email', async () => user({ email: 'other@x.et' }), PASSWORD, 'Invalid email or password'],
    ['a Google-only account', async () => user({ password_hash: null }), PASSWORD, 'Invalid email or password'],
    ['an unverified email', async () => user({ email_verified_at: null }), PASSWORD, 'Email not verified. Check your inbox for the verification link.'],
    ['a suspended account', async () => user({ status: 'suspended' }), PASSWORD, 'This account is suspended. Contact support for help.'],
  ])('refuses %s with 401 and issues no token', async (_label, row, password, message) => {
    const { svc, issue } = makeService([await row()]);
    await expect(svc.login({ email: 'a@x.et', password })).rejects.toEqual(new UnauthorizedException(message));
    expect(issue).not.toHaveBeenCalled();
  });
});

describe('AuthService.confirmPasswordReset', () => {
  const NEW = 'Another-passw0rd';

  it.each([
    ['an expired link', { user_id: 'u1', used_at: null, expires_at: new Date(Date.now() - 1000) }],
    ['a used link', { user_id: 'u1', used_at: new Date(), expires_at: new Date(Date.now() + 60_000) }],
    ['an unknown link', null],
  ])('refuses %s and changes nothing', async (_label, record) => {
    const { svc, repo, revoke } = makeService([await user()], record ? [record] : []);
    await expect(svc.confirmPasswordReset('tok', NEW)).rejects.toEqual(new BadRequestException('Invalid or expired reset link'));
    expect(repo.update).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('a successful reset ends every session', async () => {
    const { svc, revoke } = makeService([await user()], [{ user_id: 'u1', used_at: null, expires_at: new Date(Date.now() + 60_000) }]);
    await svc.confirmPasswordReset('tok', NEW);
    expect(revoke).toHaveBeenCalledWith('u1');
  });
});

describe('AuthService.acceptInvite (expired or used links)', () => {
  it.each([
    ['an expired link', { user_id: 'u1', used_at: null, expires_at: new Date(Date.now() - 1000) }],
    ['a used link', { user_id: 'u1', used_at: new Date(), expires_at: new Date(Date.now() + 60_000) }],
  ])('refuses %s and issues no session', async (_label, record) => {
    const { svc, issue } = makeService([await user()], [record]);
    await expect(svc.acceptInvite('tok', 'Another-passw0rd')).rejects.toBeInstanceOf(BadRequestException);
    expect(issue).not.toHaveBeenCalled();
  });
});

describe('AuthService.googleSignIn', () => {
  const CLIENT = 'client-id.apps.googleusercontent.com';
  const claims = (over: Row = {}) => ({ aud: CLIENT, iss: 'https://accounts.google.com', sub: 'g-1', email: 'new@x.et', email_verified: 'true', name: 'New', ...over });
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = CLIENT;
    fetchSpy = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.GOOGLE_CLIENT_ID;
  });
  const google = (body: unknown, ok = true) => fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), { status: ok ? 200 : 400 }));

  it('creates a first-time Google user as a verified learner', async () => {
    google(claims());
    const users: Row[] = [];
    const { svc, repo } = makeService(users);
    const res = await svc.googleSignIn('id-token');
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(users[0]).toMatchObject({ email: 'new@x.et', role: 'learner', google_id: 'g-1', password_hash: null, email_verified_at: expect.any(Date) });
    expect(res.user).toMatchObject({ email: 'new@x.et', role: 'learner' });
  });

  it('links an existing account with the same email instead of creating one', async () => {
    google(claims({ email: 'a@x.et' }));
    const { svc, repo } = makeService([await user({ google_id: null })]);
    const res = await svc.googleSignIn('id-token');
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('u1', expect.objectContaining({ google_id: 'g-1' }));
    expect(res.user).toMatchObject({ id: 'u1' });
  });

  it.each([
    ['tokeninfo refuses it', () => google({ error: 'invalid_token' }, false)],
    ['it was issued for another app', () => google(claims({ aud: 'other-app' }))],
    ['its email is not verified', () => google(claims({ email_verified: 'false' }))],
  ])('refuses a token when %s, with no account and no session', async (_label, arrange) => {
    arrange();
    const { svc, repo, issue } = makeService([]);
    await expect(svc.googleSignIn('id-token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.save).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });
});
