// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyToGateway } from './gateway-proxy';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('GATEWAY_INTERNAL_URL', 'http://gateway.test/');
  vi.stubEnv('WEB_PROXY_SECRET', '');
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ok = (init: ResponseInit = {}, body = '{"ok":true}') => new Response(body, { status: 200, ...init });

function sent(): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetchMock.mock.calls[0];
  return { url: String(url), init: init!, headers: new Headers(init!.headers) };
}

describe('proxyToGateway', () => {
  it('forwards the method, query, body, authorization and only el_refresh', async () => {
    fetchMock.mockResolvedValue(ok());
    const res = await proxyToGateway(
      new Request('http://web.test/api/v1/auth/verify-email?token=abc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer tok',
          cookie: 'theme=dark; el_refresh=r1; other=x',
          'x-request-id': 'req-1',
          origin: 'http://web.test',
        },
        body: '{"a":1}',
      }),
    );
    expect(res.status).toBe(200);
    const { url, init, headers } = sent();
    expect(url).toBe('http://gateway.test/api/v1/auth/verify-email?token=abc');
    expect(init.method).toBe('POST');
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"a":1}');
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('cookie')).toBe('el_refresh=r1');
    expect(headers.get('x-request-id')).toBe('req-1');
    expect(headers.get('origin')).toBeNull();
  });

  it('adds the secret and the client IP only when WEB_PROXY_SECRET is set, and drops client-sent x-web-* headers', async () => {
    fetchMock.mockResolvedValue(ok());
    const req = () =>
      new Request('http://web.test/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1', 'x-web-client-ip': '6.6.6.6', 'x-web-proxy-secret': 'guess' },
      });

    await proxyToGateway(req());
    let { headers } = sent();
    expect(headers.get('x-web-proxy-secret')).toBeNull();
    expect(headers.get('x-web-client-ip')).toBeNull();

    fetchMock.mockClear();
    vi.stubEnv('WEB_PROXY_SECRET', 'proxy-secret-not-real');
    await proxyToGateway(req());
    ({ headers } = sent());
    expect(headers.get('x-web-proxy-secret')).toBe('proxy-secret-not-real');
    expect(headers.get('x-web-client-ip')).toBe('203.0.113.9');
  });

  it('falls back to the first x-forwarded-for entry for the client IP', async () => {
    vi.stubEnv('WEB_PROXY_SECRET', 'proxy-secret-not-real');
    fetchMock.mockResolvedValue(ok());
    await proxyToGateway(new Request('http://web.test/api/v1/auth/login', { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' } }));
    expect(sent().headers.get('x-web-client-ip')).toBe('198.51.100.1');
  });

  it('returns every Set-Cookie separately and drops content-encoding and content-length', async () => {
    const upstream = new Headers({ 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '999' });
    upstream.append('set-cookie', 'el_refresh=r2; Path=/api/v1/auth; HttpOnly; SameSite=Lax');
    upstream.append('set-cookie', 'other=1; Path=/');
    fetchMock.mockResolvedValue(ok({ headers: upstream }));
    const res = await proxyToGateway(new Request('http://web.test/api/v1/auth/login', { method: 'POST' }));
    expect(res.headers.getSetCookie()).toEqual(['el_refresh=r2; Path=/api/v1/auth; HttpOnly; SameSite=Lax', 'other=1; Path=/']);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('keeps the status, body and x-render-routing of a hibernation 429', async () => {
    fetchMock.mockResolvedValue(new Response('asleep', { status: 429, headers: { 'x-render-routing': 'hibernate-wake-error' } }));
    const res = await proxyToGateway(new Request('http://web.test/api/v1/auth/refresh', { method: 'POST' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('x-render-routing')).toBe('hibernate-wake-error');
    expect(await res.text()).toBe('asleep');
  });

  it.each([
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['a timeout', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))],
  ])('answers 503 service_waking on %s', async (_label, fail) => {
    fetchMock.mockImplementation(fail);
    const res = await proxyToGateway(new Request('http://web.test/api/v1/auth/refresh', { method: 'POST' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'service_waking' });
  });

  it('gives the upstream call a 20 s timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(ok());
    await proxyToGateway(new Request('http://web.test/api/v1/auth/refresh', { method: 'POST' }));
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(sent().init.signal).toBeInstanceOf(AbortSignal);
  });

  it('forwards PUT /api/v1/profiles/password', async () => {
    fetchMock.mockResolvedValue(ok());
    await proxyToGateway(new Request('http://web.test/api/v1/profiles/password', { method: 'PUT', body: '{}' }));
    expect(sent().url).toBe('http://gateway.test/api/v1/profiles/password');
    expect(sent().init.method).toBe('PUT');
  });

  it.each(['/api/v1/profiles/me', '/api/v1/internal/users', '/api/v1/auth', '/api/v1/profiles/password/x', '/api/v1/auth/../internal/users'])(
    'refuses %s with 404 and never calls the gateway',
    async (path) => {
      const res = await proxyToGateway(new Request(`http://web.test${path}`, { method: 'POST' }));
      if (path.includes('..')) expect(new URL(`http://web.test${path}`).pathname).toBe('/api/v1/internal/users');
      expect(res.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
