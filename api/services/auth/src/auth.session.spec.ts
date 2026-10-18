import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

/**
 * Session revocation: logout, "sign out everywhere" on password change/reset,
 * and admin suspend/ban must all invalidate refresh tokens in Redis. Before
 * these fixes, logging out only cleared the cookie client-side while the token
 * stayed valid for up to 7 days.
 *
 * We drive the real AuthService against an in-memory fake Redis that mimics the
 * ioredis commands the service uses (get/set/del/sadd/srem/smembers/expire,
 * and multi for rotation). `set … EX` expiry follows Date.now(), so jest's
 * fake timers move it.
 */
class FakeRedis {
  strings = new Map<string, string>();
  expiresAt = new Map<string, number>();
  sets = new Map<string, Set<string>>();
  async get(k: string) {
    const at = this.expiresAt.get(k);
    if (at !== undefined && Date.now() >= at) {
      this.strings.delete(k);
      this.expiresAt.delete(k);
    }
    return this.strings.get(k) ?? null;
  }
  async set(k: string, v: string, mode?: 'EX', seconds?: number) {
    this.strings.set(k, v);
    if (mode === 'EX' && seconds) this.expiresAt.set(k, Date.now() + seconds * 1000);
    else this.expiresAt.delete(k);
    return 'OK';
  }
  /** Queues commands and runs them in order on exec, like ioredis' pipeline. */
  multi() {
    const queued: (() => Promise<unknown>)[] = [];
    const chain = new Proxy({} as Record<string, unknown>, {
      get: (_t, name: string) => {
        if (name === 'exec') return async () => Promise.all(queued.map(async (run) => [null, await run()]));
        return (...args: unknown[]) => {
          queued.push(() => (this as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](...args));
          return chain;
        };
      },
    });
    return chain;
  }
  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) {
      if (this.strings.delete(k)) n++;
      if (this.sets.delete(k)) n++;
    }
    return n;
  }
  async sadd(k: string, ...members: string[]) {
    const s = this.sets.get(k) ?? new Set<string>();
    members.forEach((m) => s.add(m));
    this.sets.set(k, s);
    return members.length;
  }
  async srem(k: string, ...members: string[]) {
    const s = this.sets.get(k);
    if (!s) return 0;
    let n = 0;
    members.forEach((m) => (s.delete(m) ? n++ : null));
    return n;
  }
  async smembers(k: string) {
    return [...(this.sets.get(k) ?? [])];
  }
  async expire() {
    return 1;
  }
}

type UserRow = { id: string; email: string; name: string; role: string; status?: string; must_change_password: boolean };

function makeService(users: UserRow[] = []) {
  const redis = new FakeRedis();
  const repo = { findOne: async ({ where: { id } }: { where: { id: string } }) => users.find((u) => u.id === id) ?? null };
  process.env.JWT_SECRET = 'test-secret-not-real';
  const svc = new AuthService(repo as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  // Replace the real ioredis connection (opened at field init) with the fake,
  // and stop the real one so no socket lingers during the test run.
  const real = (svc as unknown as { redis: { disconnect?: () => void } }).redis;
  real?.disconnect?.();
  (svc as unknown as { redis: FakeRedis }).redis = redis;
  return { svc, redis };
}

// Reach the private issuer to mint tokens the way login/refresh do.
function issue(svc: AuthService, userId: string): Promise<string> {
  return (svc as unknown as { issueRefreshToken(id: string): Promise<string> }).issueRefreshToken(userId);
}

describe('AuthService session revocation', () => {
  it('logout deletes exactly that refresh token and de-indexes it', async () => {
    const { svc, redis } = makeService();
    const a = await issue(svc, 'user-1');
    const b = await issue(svc, 'user-1');
    expect(await redis.get(`refresh:${a}`)).toBe('user-1');

    await svc.logout(a);

    expect(await redis.get(`refresh:${a}`)).toBeNull(); // this device signed out
    expect(await redis.get(`refresh:${b}`)).toBe('user-1'); // the other device still valid
    expect(await redis.smembers('refresh:user:user-1')).toEqual([b]);
  });

  it('logout with no token is a harmless no-op', async () => {
    const { svc } = makeService();
    await expect(svc.logout(undefined)).resolves.toBeUndefined();
  });

  it('revokeAllSessions kills every token for the user and reports the count', async () => {
    const { svc, redis } = makeService();
    await issue(svc, 'user-1');
    await issue(svc, 'user-1');
    await issue(svc, 'user-2'); // a different user is untouched
    const other = await redis.smembers('refresh:user:user-2');

    const killed = await svc.revokeAllSessions('user-1');

    expect(killed).toBe(2);
    expect(await redis.smembers('refresh:user:user-1')).toEqual([]);
    expect(await redis.get(`refresh:${other[0]}`)).toBe('user-2'); // user-2 still signed in
  });

  it('revokeAllSessions on a user with no sessions returns 0', async () => {
    const { svc } = makeService();
    expect(await svc.revokeAllSessions('nobody')).toBe(0);
  });
});

describe('AuthService.refresh: rotation and the 30 s grace (Phase 11b, decision 8)', () => {
  const learner = (over: Partial<UserRow> = {}): UserRow => ({ id: 'user-1', email: 'a@x.et', name: 'A', role: 'learner', must_change_password: false, ...over });

  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-18T09:00:00Z') }));
  afterEach(() => jest.useRealTimers());

  it('rotates: a new token, the old one gone from Redis and from the user set', async () => {
    const { svc, redis } = makeService([learner()]);
    const t0 = await issue(svc, 'user-1');
    const res = await svc.refresh(t0);
    expect(res.refresh_token).not.toBe(t0);
    expect(res.access_token).toEqual(expect.any(String));
    expect(await redis.get(`refresh:${t0}`)).toBeNull();
    expect(await redis.smembers('refresh:user:user-1')).toEqual([res.refresh_token]);
    expect(await redis.get(`refresh:${res.refresh_token}`)).toBe('user-1');
  });

  it('inside 30 s, the old token returns the same successor and mints no new session', async () => {
    const { svc, redis } = makeService([learner()]);
    const t0 = await issue(svc, 'user-1');
    const t1 = (await svc.refresh(t0)).refresh_token;
    jest.advanceTimersByTime(29_000);
    const again = await svc.refresh(t0);
    expect(again.refresh_token).toBe(t1);
    expect(again.access_token).toEqual(expect.any(String));
    expect(await redis.smembers('refresh:user:user-1')).toEqual([t1]);
  });

  it('after 30 s, the old token is a 401', async () => {
    const { svc } = makeService([learner()]);
    const t0 = await issue(svc, 'user-1');
    await svc.refresh(t0);
    jest.advanceTimersByTime(30_000);
    await expect(svc.refresh(t0)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('one hop only: once the successor is rotated, the old token is a 401', async () => {
    const { svc } = makeService([learner()]);
    const t0 = await issue(svc, 'user-1');
    const t1 = (await svc.refresh(t0)).refresh_token;
    const t2 = (await svc.refresh(t1)).refresh_token;
    expect(t2).not.toBe(t1);
    await expect(svc.refresh(t0)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('once the successor is revoked by revokeAllSessions, the old token is a 401', async () => {
    const { svc } = makeService([learner()]);
    const t0 = await issue(svc, 'user-1');
    await svc.refresh(t0);
    await svc.revokeAllSessions('user-1');
    await expect(svc.refresh(t0)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('once the successor is logged out, the old token is a 401', async () => {
    const { svc } = makeService([learner()]);
    const t0 = await issue(svc, 'user-1');
    const t1 = (await svc.refresh(t0)).refresh_token;
    await svc.logout(t1);
    await expect(svc.refresh(t0)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('logout with the old token inside the grace also revokes its successor', async () => {
    const { svc, redis } = makeService([learner()]);
    const t0 = await issue(svc, 'user-1');
    const t1 = (await svc.refresh(t0)).refresh_token;
    await svc.logout(t0);
    expect(await redis.get(`refresh:${t1}`)).toBeNull();
    expect(await redis.smembers('refresh:user:user-1')).toEqual([]);
    await expect(svc.refresh(t1)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.refresh(t0)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each(['suspended', 'banned'])('a %s user cannot refresh, nor use the grace', async (status) => {
    const user = learner();
    const { svc } = makeService([user]);
    const t0 = await issue(svc, 'user-1');
    const t1 = await issue(svc, 'user-1');
    await svc.refresh(t1); // t1 rotated while still active
    user.status = status;
    await expect(svc.refresh(t0)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.refresh(t1)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('an unknown or missing token is a 401', async () => {
    const { svc } = makeService([learner()]);
    await expect(svc.refresh('nope')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.refresh(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
