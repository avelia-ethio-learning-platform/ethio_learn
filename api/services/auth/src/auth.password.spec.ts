import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

/**
 * Password change: needs the current password (except for Google-only accounts
 * and the first-login path), keeps the caller signed in with a fresh session,
 * and revokes every other session. Reset confirmation clears the first-login flag.
 */
const OLD = 'Strong-passw0rd';
const NEW = 'Another-passw0rd';

type Row = Record<string, unknown>;

function makeService(user: Row | null, resets: Row[] = []) {
  const calls: string[] = [];
  const users = {
    findOne: jest.fn(async () => user),
    update: jest.fn(async (_id: string, patch: Row) => {
      calls.push('update');
      Object.assign(user ?? {}, patch);
    }),
  };
  const resetRepo = { findOne: jest.fn(async () => resets[0] ?? null), save: jest.fn(async (r: Row) => r) };
  process.env.JWT_SECRET = 'test-secret-not-real';
  const svc = new AuthService(users as never, {} as never, resetRepo as never, {} as never, {} as never, {} as never, {} as never);
  (svc as unknown as { redis: { disconnect?: () => void } }).redis.disconnect?.();
  const revoke = jest.spyOn(svc, 'revokeAllSessions').mockImplementation(async () => {
    calls.push('revoke');
    return 1;
  });
  const issued: string[] = [];
  (svc as unknown as { issueRefreshToken: (id: string) => Promise<string> }).issueRefreshToken = async () => {
    calls.push('issue');
    issued.push('fresh-refresh-token');
    return 'fresh-refresh-token';
  };
  return { svc, users, revoke, calls };
}

async function userRow(over: Row = {}): Promise<Row> {
  return {
    id: 'u1',
    email: 'a@x.et',
    name: 'A',
    role: 'learner',
    password_hash: await bcrypt.hash(OLD, 4),
    must_change_password: false,
    ...over,
  };
}

describe('AuthService.changePassword', () => {
  it('rejects a missing current password with 400', async () => {
    const { svc, users, revoke } = makeService(await userRow());
    await expect(svc.changePassword('u1', { new_password: NEW })).rejects.toEqual(
      new BadRequestException('Current password is required.'),
    );
    expect(users.update).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('rejects a wrong current password with 401 and changes nothing', async () => {
    const { svc, users, revoke } = makeService(await userRow());
    await expect(svc.changePassword('u1', { new_password: NEW, current_password: 'Wrong-passw0rd' })).rejects.toEqual(
      new UnauthorizedException('Current password is incorrect.'),
    );
    expect(users.update).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each([
    ['suspended', 'This account is suspended. Contact support for help.'],
    ['banned', 'This account has been banned. Contact support if you believe this is a mistake.'],
  ])('refuses a %s account before any check, update, revoke or session', async (status, message) => {
    const { svc, users, revoke, calls } = makeService(await userRow({ status }));
    await expect(svc.changePassword('u1', { new_password: NEW, current_password: OLD })).rejects.toEqual(
      new UnauthorizedException(message),
    );
    expect(users.update).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('accepts the correct current password, saves a new hash and returns a login-shaped session', async () => {
    const row = await userRow();
    const { svc } = makeService(row);
    const res = await svc.changePassword('u1', { new_password: NEW, current_password: OLD });
    expect(await bcrypt.compare(NEW, row.password_hash as string)).toBe(true);
    expect(res).toMatchObject({
      refresh_token: 'fresh-refresh-token',
      expires_in: 900,
      user: { id: 'u1', email: 'a@x.et', must_change_password: false },
    });
    expect(typeof res.access_token).toBe('string');
  });

  it('revokes every session before issuing the caller a fresh one (so the new token survives)', async () => {
    const { svc, calls } = makeService(await userRow());
    await svc.changePassword('u1', { new_password: NEW, current_password: OLD });
    expect(calls).toEqual(['update', 'revoke', 'issue']);
  });

  it('does not need a current password for a Google-only account', async () => {
    const row = await userRow({ password_hash: null });
    const { svc } = makeService(row);
    const res = await svc.changePassword('u1', { new_password: NEW });
    expect(await bcrypt.compare(NEW, row.password_hash as string)).toBe(true);
    expect(res.refresh_token).toBe('fresh-refresh-token');
  });

  it('does not need a current password on the first-login path, and clears the flag', async () => {
    const row = await userRow({ must_change_password: true });
    const { svc } = makeService(row);
    const res = await svc.changePassword('u1', { new_password: NEW });
    expect(row.must_change_password).toBe(false);
    expect(res.user).toMatchObject({ must_change_password: false });
  });
});

describe('AuthService.confirmPasswordReset', () => {
  it('clears must_change_password along with setting the new hash', async () => {
    const future = new Date(Date.now() + 60_000);
    const { svc, users } = makeService(await userRow(), [{ user_id: 'u1', used_at: null, expires_at: future }]);
    await svc.confirmPasswordReset('fake-token', NEW);
    expect(users.update).toHaveBeenCalledWith('u1', expect.objectContaining({ must_change_password: false }));
  });
});
