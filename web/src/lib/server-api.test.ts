import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants';
import { SERVER_TIMEOUT_MS, serverApi, staticFallback } from './server-api';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const text = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers });
const json = (status: number, body: unknown) => text(status, JSON.stringify(body), { 'Content-Type': 'application/json' });

describe('serverApi', () => {
  it('returns the data with a timeout signal and the revalidate hint', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: 'c1' }));
    expect(await serverApi('/courses/c1', 300)).toEqual({ ok: true, data: { id: 'c1' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/v1\/courses\/c1$/);
    expect(init.next).toEqual({ revalidate: 300 });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a 404 is a real not-found', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { statusCode: 404, message: 'Course not found' }));
    expect(await serverApi('/courses/missing')).toEqual({ ok: false, status: 404 });
  });

  it('a malformed id (400) is treated as not found, as before', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { statusCode: 400, message: 'Validation failed (uuid is expected)' }));
    expect(await serverApi('/courses/not-a-uuid')).toEqual({ ok: false, status: 404 });
  });

  it('a 5xx is unavailable, not a 404', async () => {
    fetchMock.mockResolvedValueOnce(text(502, 'Bad Gateway'));
    expect(await serverApi('/courses/c1')).toEqual({ ok: false, status: 'unavailable' });
  });

  it('a network error is unavailable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await serverApi('/courses/c1')).toEqual({ ok: false, status: 'unavailable' });
  });

  it(`gives up after ${SERVER_TIMEOUT_MS} ms and says unavailable`, async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    // What fetch does when its timeout signal fires.
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(await serverApi('/courses/c1')).toEqual({ ok: false, status: 'unavailable' });
    expect(timeout).toHaveBeenCalledWith(SERVER_TIMEOUT_MS);
    timeout.mockRestore();
  });

  it('a hibernation 429 (Render header) is unavailable', async () => {
    fetchMock.mockResolvedValueOnce(text(429, 'Too Many Requests', { 'x-render-routing': 'hibernate-rate-limited' }));
    expect(await serverApi('/courses/c1')).toEqual({ ok: false, status: 'unavailable' });
  });

  it('a plain-text 429 without the header is unavailable too', async () => {
    fetchMock.mockResolvedValueOnce(text(429, 'Too Many Requests'));
    expect(await serverApi('/courses/c1')).toEqual({ ok: false, status: 'unavailable' });
  });

  it("the gateway limiter's JSON 429 is not treated as a cold start", async () => {
    fetchMock.mockResolvedValueOnce(json(429, { statusCode: 429, message: 'Too many requests' }));
    expect(await serverApi('/courses/c1')).toEqual({ ok: false, status: 404 });
  });
});

describe('staticFallback', () => {
  const empty = { items: [] as string[] };

  it('passes the data through', () => {
    expect(staticFallback({ ok: true, data: { items: ['a'] } }, empty)).toEqual({ data: { items: ['a'] }, unavailable: false });
  });

  it('during next build, an unavailable API gives the empty value, marked unavailable', () => {
    vi.stubEnv('NEXT_PHASE', PHASE_PRODUCTION_BUILD);
    expect(staticFallback({ ok: false, status: 'unavailable' }, empty)).toEqual({ data: empty, unavailable: true });
  });

  it('at runtime, an unavailable API throws so Next keeps the last good page', () => {
    vi.stubEnv('NEXT_PHASE', PHASE_PRODUCTION_SERVER);
    expect(() => staticFallback({ ok: false, status: 'unavailable' }, empty)).toThrow(/unavailable/);
  });

  it('a 404 renders the empty value without throwing', () => {
    vi.stubEnv('NEXT_PHASE', PHASE_PRODUCTION_SERVER);
    expect(staticFallback({ ok: false, status: 404 }, empty)).toEqual({ data: empty, unavailable: false });
  });
});
