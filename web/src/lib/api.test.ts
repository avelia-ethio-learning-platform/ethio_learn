import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { wakeServices } = vi.hoisted(() => ({ wakeServices: vi.fn() }));
vi.mock('./wake', () => ({ wakeServices }));

import { api, ApiError, getAuth, refreshSession, setAuth, WakingError } from './api';
import { SLOW_NOTICE_MS, slowRequestCount } from './waking';

const fetchMock = vi.fn();
const learner = { id: 'u1', name: 'N', email: 'e', role: 'learner' as const };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** What the browser sees from a sleeping Render service: plain text, and the header isn't readable cross-origin. */
function hibernationResponse(): Response {
  return new Response('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain' } });
}

const isRefresh = (url: string) => url.endsWith('/auth/refresh');

/** Counts logouts: setAuth(null) fires el-auth-changed with nothing stored. */
function countLogouts() {
  let n = 0;
  const onChange = () => {
    if (!localStorage.getItem('el_auth')) n += 1;
  };
  window.addEventListener('el-auth-changed', onChange);
  return {
    get count() {
      return n;
    },
    stop: () => window.removeEventListener('el-auth-changed', onChange),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  wakeServices.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('api()', () => {
  it('returns the parsed JSON body on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { hello: 'world' }));
    expect(await api('/courses/c1')).toEqual({ hello: 'world' });
  });

  it('sends the bearer token from stored auth', async () => {
    setAuth({ access_token: 'tok-123', user: learner });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await api('/enrollments');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer tok-123');
  });

  it('throws ApiError with the server message on failure', async () => {
    // Fresh Response per call — a Response body can only be consumed once.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(403, { message: 'Not your enrollment' })));
    await expect(api('/enrollments/x')).rejects.toMatchObject({ status: 403, message: 'Not your enrollment' });
    await expect(api('/enrollments/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('joins array validation messages', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(400, { message: ['a is required', 'b is required'] })));
    await expect(api('/x')).rejects.toMatchObject({ message: 'a is required, b is required' });
  });

  it('retries once via the refresh cookie on 401, then replays the request', async () => {
    setAuth({ access_token: 'expired', user: learner });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { message: 'jwt expired' })) // original call
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'fresh', user: learner })) // refresh
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })); // replay

    expect(await api('/enrollments')).toEqual({ ok: true });
    expect(getAuth()?.access_token).toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('clears stored auth when the refresh also fails', async () => {
    setAuth({ access_token: 'expired', user: learner });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { message: 'jwt expired' }))
      .mockResolvedValueOnce(jsonResponse(401, { message: 'no cookie' }));

    await expect(api('/enrollments')).rejects.toMatchObject({ status: 401 });
    expect(getAuth()).toBeNull();
  });
});

describe('single-flight refresh (P0-12)', () => {
  it('five parallel 401s make exactly one refresh call, and everyone stays signed in', async () => {
    setAuth({ access_token: 'expired', user: learner });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => (releaseRefresh = resolve));
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (isRefresh(url)) {
        await refreshGate;
        return jsonResponse(200, { access_token: 'fresh', user: learner });
      }
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer fresh' ? jsonResponse(200, { url }) : jsonResponse(401, { message: 'jwt expired' });
    });
    const logouts = countLogouts();

    const calls = [1, 2, 3, 4, 5].map((i) => api(`/r${i}`));
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => isRefresh(u))).toHaveLength(1));
    releaseRefresh();
    const results = await Promise.all(calls);

    expect(results.map((r) => r.url)).toEqual([1, 2, 3, 4, 5].map((i) => expect.stringContaining(`/r${i}`)));
    expect(fetchMock.mock.calls.filter(([u]) => isRefresh(u))).toHaveLength(1);
    expect(getAuth()?.access_token).toBe('fresh');
    expect(logouts.count).toBe(0);
    logouts.stop();
  });

  it('a request that 401s after another one refreshed retries without a second refresh', async () => {
    setAuth({ access_token: 'expired', user: learner });
    fetchMock.mockImplementationOnce(async () => {
      // While this request was in flight, a parallel one refreshed the token.
      setAuth({ access_token: 'fresh', user: learner });
      return jsonResponse(401, { message: 'jwt expired' });
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    expect(await api('/enrollments')).toEqual({ ok: true });
    expect(fetchMock.mock.calls.filter(([u]) => isRefresh(u))).toHaveLength(0);
  });

  it('a rejected refresh logs out exactly once, however many requests were waiting', async () => {
    setAuth({ access_token: 'expired', user: learner });
    fetchMock.mockImplementation(async (url: string) =>
      isRefresh(url) ? jsonResponse(401, { message: 'Invalid refresh token' }) : jsonResponse(401, { message: 'jwt expired' }),
    );
    const logouts = countLogouts();

    const results = await Promise.allSettled([1, 2, 3].map((i) => api(`/r${i}`)));

    expect(results.every((r) => r.status === 'rejected' && (r.reason as ApiError).status === 401)).toBe(true);
    expect(fetchMock.mock.calls.filter(([u]) => isRefresh(u))).toHaveLength(1);
    expect(logouts.count).toBe(1);
    expect(getAuth()).toBeNull();
    logouts.stop();
  });
});

describe('waking up (A1)', () => {
  it('a hibernation 429 (plain text, no readable header) throws WakingError and wakes the services', async () => {
    fetchMock.mockResolvedValueOnce(hibernationResponse());
    await expect(api('/courses/c1')).rejects.toBeInstanceOf(WakingError);
    expect(wakeServices).toHaveBeenCalledTimes(1);
  });

  it('a network error does the same', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api('/courses/c1')).rejects.toBeInstanceOf(WakingError);
    expect(wakeServices).toHaveBeenCalledTimes(1);
  });

  it('offline, a network error stays a network error', async () => {
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api('/courses/c1')).rejects.toBeInstanceOf(TypeError);
    expect(wakeServices).not.toHaveBeenCalled();
  });

  it("the gateway limiter's JSON 429 is an ordinary ApiError", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { statusCode: 429, message: 'Too many requests' }));
    await expect(api('/courses/c1')).rejects.toMatchObject({ status: 429, message: 'Too many requests' });
    expect(wakeServices).not.toHaveBeenCalled();
  });

  it('a hibernation 429 on the refresh keeps the session, wakes, and throws WakingError to every waiter', async () => {
    setAuth({ access_token: 'expired', user: learner });
    fetchMock.mockImplementation(async (url: string) => (isRefresh(url) ? hibernationResponse() : jsonResponse(401, { message: 'jwt expired' })));
    const logouts = countLogouts();

    const results = await Promise.allSettled([1, 2, 3].map((i) => api(`/r${i}`)));

    expect(results.every((r) => r.status === 'rejected' && r.reason instanceof WakingError)).toBe(true);
    expect(fetchMock.mock.calls.filter(([u]) => isRefresh(u))).toHaveLength(1);
    expect(getAuth()?.access_token).toBe('expired');
    expect(logouts.count).toBe(0);
    expect(wakeServices).toHaveBeenCalled();
  });

  it('after a waking refresh, the next attempt starts a new refresh', async () => {
    setAuth({ access_token: 'expired', user: learner });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { message: 'jwt expired' }))
      .mockResolvedValueOnce(hibernationResponse()) // refresh: auth is asleep
      .mockResolvedValueOnce(jsonResponse(401, { message: 'jwt expired' }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'fresh', user: learner })) // refresh: awake now
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await expect(api('/enrollments')).rejects.toBeInstanceOf(WakingError);
    expect(await api('/enrollments')).toEqual({ ok: true });
    expect(getAuth()?.access_token).toBe('fresh');
  });

  it('a 5xx or network error on the refresh is waking too, not a logout', async () => {
    setAuth({ access_token: 'expired', user: learner });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { message: 'jwt expired' }))
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(401, { message: 'jwt expired' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(api('/enrollments')).rejects.toBeInstanceOf(WakingError);
    await expect(api('/enrollments')).rejects.toBeInstanceOf(WakingError);
    expect(getAuth()?.access_token).toBe('expired');
  });

  it('a 200 refresh whose body is not JSON (a proxy page) is waking too, not a raw parse error', async () => {
    setAuth({ access_token: 'expired', user: learner });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { message: 'jwt expired' }))
      .mockResolvedValueOnce(new Response('<html>Service waking up</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));

    await expect(api('/enrollments')).rejects.toBeInstanceOf(WakingError);
    expect(getAuth()?.access_token).toBe('expired');
  });

  it("the limiter's JSON 429 on the refresh keeps the session", async () => {
    setAuth({ access_token: 'expired', user: learner });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { message: 'jwt expired' }))
      .mockResolvedValueOnce(jsonResponse(429, { statusCode: 429, message: 'Too many requests' }));

    await expect(api('/enrollments')).rejects.toMatchObject({ status: 429 });
    expect(getAuth()?.access_token).toBe('expired');
  });

  it('refreshSession reports false without throwing when auth is asleep', async () => {
    setAuth({ access_token: 'tok', user: learner });
    fetchMock.mockResolvedValueOnce(hibernationResponse());
    expect(await refreshSession()).toBe(false);
    expect(getAuth()?.access_token).toBe('tok');
  });
});

describe('the 4 s "waking up" notice', () => {
  it('counts a request still pending after 4 s, until it settles', async () => {
    vi.useFakeTimers();
    let respond!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (respond = resolve)));

    const call = api('/courses');
    await vi.advanceTimersByTimeAsync(SLOW_NOTICE_MS - 1);
    expect(slowRequestCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(slowRequestCount()).toBe(1);

    respond(jsonResponse(200, {}));
    await call;
    expect(slowRequestCount()).toBe(0);
  });

  it('a request that settles in time never counts', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await api('/courses');
    await vi.advanceTimersByTimeAsync(SLOW_NOTICE_MS * 2);
    expect(slowRequestCount()).toBe(0);
  });

  it('slow calls opt out', async () => {
    vi.useFakeTimers();
    let respond!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (respond = resolve)));

    const call = api('/courses/c1/outline', { method: 'POST', slow: true });
    await vi.advanceTimersByTimeAsync(SLOW_NOTICE_MS * 3);
    expect(slowRequestCount()).toBe(0);
    respond(jsonResponse(200, {}));
    await call;
  });

  it('a failed request stops counting too', async () => {
    vi.useFakeTimers();
    let fail!: (e: Error) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((_resolve, reject) => (fail = reject)));

    const call = api('/courses').catch((e) => e);
    await vi.advanceTimersByTimeAsync(SLOW_NOTICE_MS);
    expect(slowRequestCount()).toBe(1);
    fail(new TypeError('Failed to fetch'));
    expect(await call).toBeInstanceOf(WakingError);
    expect(slowRequestCount()).toBe(0);
  });
});
