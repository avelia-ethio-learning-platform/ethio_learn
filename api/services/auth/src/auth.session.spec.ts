import { AuthService } from './auth.service';

/**
 * Session revocation: logout, "sign out everywhere" on password change/reset,
 * and admin suspend/ban must all invalidate refresh tokens in Redis. Before
 * these fixes, logging out only cleared the cookie client-side while the token
 * stayed valid for up to 7 days.
 *
 * We drive the real AuthService against an in-memory fake Redis that mimics the
 * ioredis commands the service uses (get/set/del/sadd/srem/smembers/expire).
 */
class FakeRedis {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  async get(k: string) {
    return this.strings.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.strings.set(k, v);
    return 'OK';
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

function makeService() {
  const redis = new FakeRedis();
  const svc = new AuthService({} as never, {} as never, {} as never, {} as never);
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
