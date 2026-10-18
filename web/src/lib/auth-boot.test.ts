import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { wakeServices } = vi.hoisted(() => ({ wakeServices: vi.fn() }));
vi.mock('./wake', () => ({ wakeServices }));

import { BOOT_RETRY_MS, bootAuth, getAuth, resetBootForTests, setAuth } from './api';
import { authSnapshot, resetAuthForTests } from './auth-store';
import { SLOW_NOTICE_MS, slowRequestCount } from './waking';

/**
 * Phase 11b: the access token in memory, the `el_session` hint, boot (online
 * and offline), the cross-tab lock and the broadcast.
 */
const fetchMock = vi.fn();
const learner = { id: 'u1', name: 'Almaz', email: 'a@x.et', role: 'learner' as const };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refreshCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/auth/refresh'));

/** Stands in for the other tabs: records what this tab posts and delivers what they post. */
class FakeChannel {
  static last: FakeChannel | null = null;
  posted: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(public name: string) {
    FakeChannel.last = this;
  }
  postMessage(data: unknown) {
    this.posted.push(data);
  }
  close() {}
  deliver(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

/** navigator.locks, serializing requests for one name, with a log of acquire/release. */
function fakeLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  const log: string[] = [];
  return {
    log,
    request: (_name: string, cb: () => unknown) => {
      const run = tail.then(async () => {
        log.push('acquire');
        try {
          return await cb();
        } finally {
          log.push('release');
        }
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

function boot(nav: Record<string, unknown> = {}) {
  vi.stubGlobal('navigator', { ...navigator, onLine: true, ...nav });
  bootAuth();
}

const withHint = () => localStorage.setItem('el_session', JSON.stringify({ user: learner }));

beforeEach(() => {
  fetchMock.mockReset();
  wakeServices.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  localStorage.clear();
  resetAuthForTests();
  resetBootForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('boot', () => {
  it('no hint: anonymous and ready at once, with no call', () => {
    boot();
    expect(authSnapshot()).toEqual({ user: null, ready: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removes a token stored by an older build', () => {
    localStorage.setItem('el_auth', JSON.stringify({ access_token: 'old', user: learner }));
    boot();
    expect(localStorage.getItem('el_auth')).toBeNull();
    expect(getAuth()).toBeNull();
  });

  it('hint: the user shows before the refresh resolves, then signed in with the token', async () => {
    let respond!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (respond = r)));
    withHint();
    boot();
    expect(authSnapshot()).toEqual({ user: learner, ready: false });
    expect(getAuth()?.access_token).toBeUndefined();
    expect(refreshCalls()).toHaveLength(1);
    expect(refreshCalls()[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });

    respond(json(200, { access_token: 'fresh', user: learner }));
    await vi.waitFor(() => expect(authSnapshot().ready).toBe(true));
    expect(getAuth()).toEqual({ access_token: 'fresh', user: learner });
  });

  it('hint plus 401: anonymous, hint cleared, and no broadcast (this tab only)', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { message: 'Invalid refresh token' }));
    withHint();
    boot();
    await vi.waitFor(() => expect(authSnapshot()).toEqual({ user: null, ready: true }));
    expect(localStorage.getItem('el_session')).toBeNull();
    expect(FakeChannel.last?.posted).toEqual([]);
  });

  it('a call made before the boot refresh lands waits for it and carries the new token', async () => {
    let respond!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (respond = r)));
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    withHint();
    boot();
    const { api } = await import('./api');
    const call = api('/enrollments');
    respond(json(200, { access_token: 'fresh', user: learner }));
    expect(await call).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2); // one refresh, shared
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh');
  });

  it('hint plus a network error while online: not ready, the waking notice, a retry on the wake backoff', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    withHint();
    boot();
    await vi.advanceTimersByTimeAsync(SLOW_NOTICE_MS);
    expect(authSnapshot()).toEqual({ user: learner, ready: false });
    expect(slowRequestCount()).toBe(1);
    expect(wakeServices).toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(json(200, { access_token: 'fresh', user: learner }));
    await vi.advanceTimersByTimeAsync(BOOT_RETRY_MS);
    expect(refreshCalls()).toHaveLength(2);
    expect(authSnapshot().ready).toBe(true);
    expect(slowRequestCount()).toBe(0);
  });

  it('hint while offline: ready with the user, no notice and no refresh; back online, one refresh', async () => {
    vi.useFakeTimers();
    withHint();
    boot({ onLine: false });
    expect(authSnapshot()).toEqual({ user: learner, ready: true });
    await vi.advanceTimersByTimeAsync(SLOW_NOTICE_MS * 2);
    expect(slowRequestCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(json(200, { access_token: 'fresh', user: learner }));
    vi.stubGlobal('navigator', { ...navigator, onLine: true });
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(getAuth()?.access_token).toBe('fresh'));
    expect(refreshCalls()).toHaveLength(1);
  });

  it('a network error at boot while the browser goes offline: signed in offline, no notice', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(async () => {
      vi.stubGlobal('navigator', { ...navigator, onLine: false });
      throw new TypeError('Failed to fetch');
    });
    withHint();
    boot();
    await vi.advanceTimersByTimeAsync(SLOW_NOTICE_MS + BOOT_RETRY_MS);
    expect(authSnapshot()).toEqual({ user: learner, ready: true });
    expect(slowRequestCount()).toBe(0);
    expect(refreshCalls()).toHaveLength(1);
  });
});

describe('the hint and other tabs', () => {
  it('the hint holds the public user and never the access token', () => {
    setAuth({ access_token: 'secret.jwt.value', user: learner });
    const raw = localStorage.getItem('el_session')!;
    expect(JSON.parse(raw)).toEqual({ user: learner });
    expect(raw).not.toContain('secret.jwt.value');
    for (let i = 0; i < localStorage.length; i += 1) {
      expect(localStorage.getItem(localStorage.key(i)!)).not.toContain('secret.jwt.value');
    }
  });

  it("adopts another tab's session broadcast", () => {
    boot();
    FakeChannel.last!.deliver({ type: 'session', access_token: 'from-tab-b', user: learner });
    expect(getAuth()).toEqual({ access_token: 'from-tab-b', user: learner });
    expect(authSnapshot()).toEqual({ user: learner, ready: true });
  });

  it('a login broadcasts the session; a logout broadcasts logout, and the other tab signs out', () => {
    setAuth({ access_token: 't', user: learner });
    setAuth(null);
    expect(FakeChannel.last!.posted).toEqual([{ type: 'session', access_token: 't', user: learner }, { type: 'logout' }]);
    expect(localStorage.getItem('el_session')).toBeNull();

    setAuth({ access_token: 't2', user: learner });
    FakeChannel.last!.deliver({ type: 'logout' });
    expect(getAuth()).toBeNull();
  });
});

describe('the cross-tab lock', () => {
  it('inside the lock, a token another tab delivered while this one waited skips the call', async () => {
    const locks = fakeLocks();
    let releaseOther!: () => void;
    // Tab B holds the lock while it refreshes.
    void locks.request('el-auth-refresh', () => new Promise<void>((r) => (releaseOther = r)));
    withHint();
    boot({ locks });
    await Promise.resolve();
    FakeChannel.last!.deliver({ type: 'session', access_token: 'from-tab-b', user: learner });
    releaseOther();
    await vi.waitFor(() => expect(locks.log).toEqual(['acquire', 'release', 'acquire', 'release']));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAuth()?.access_token).toBe('from-tab-b');
  });

  it('a waking retry releases the lock between attempts (one attempt per acquisition)', async () => {
    vi.useFakeTimers();
    const locks = fakeLocks();
    fetchMock.mockResolvedValueOnce(new Response('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain' } }));
    withHint();
    boot({ locks });
    await vi.advanceTimersByTimeAsync(1);
    expect(locks.log).toEqual(['acquire', 'release']); // released while the backoff waits

    fetchMock.mockResolvedValueOnce(json(200, { access_token: 'fresh', user: learner }));
    await vi.advanceTimersByTimeAsync(BOOT_RETRY_MS);
    expect(locks.log).toEqual(['acquire', 'release', 'acquire', 'release']);
    expect(getAuth()?.access_token).toBe('fresh');
  });
});
