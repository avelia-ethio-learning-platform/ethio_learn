import { createServer, IncomingHttpHeaders, Server } from 'http';
import { AddressInfo } from 'net';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { createGatewayApp } from './app';
import { ipBucket } from './auth-middleware';

/**
 * The gateway's request pipeline, run for real on `listen(0)` against a stub
 * upstream that records what it receives (Phase 11b, P1-29).
 */
const JWT_SECRET = 'gateway-spec-jwt-secret-not-real';
const INTERNAL = 'gateway-spec-internal-token-not-real';
const PROXY_SECRET = 'gateway-spec-proxy-secret-not-real';

let upstream: Server;
let seen: { url: string; headers: IncomingHttpHeaders }[] = [];
let app: NestExpressApplication;
let base: string;

const port = (s: Server) => (s.address() as AddressInfo).port;
const token = (claims: object, opts: jwt.SignOptions = {}) =>
  jwt.sign(claims, JWT_SECRET, { issuer: 'ethiopialearn', algorithm: 'HS256', expiresIn: 60, ...opts });

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.INTERNAL_API_TOKEN = INTERNAL;
  process.env.AUTH_SERVICE_URL = `127.0.0.1:${port(upstream)}`;
  process.env.WEB_PROXY_SECRET = PROXY_SECRET;
  app = await createGatewayApp({ logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port(app.getHttpServer() as Server)}`;
});

afterAll(async () => {
  await app.close();
  await new Promise((r) => upstream.close(r));
  delete process.env.AUTH_SERVICE_URL;
  delete process.env.INTERNAL_API_TOKEN;
  delete process.env.WEB_PROXY_SECRET;
});

beforeEach(() => {
  seen = [];
});

describe('gateway pipeline', () => {
  it('strips client-sent identity and internal-token headers on a public route', async () => {
    const res = await fetch(`${base}/api/v1/auth/invite/abc`, {
      headers: { 'x-user-id': 'evil', 'x-user-role': 'platform_admin', 'x-user-email': 'e', 'x-internal-token': 'guess' },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const h = seen[0].headers;
    expect(h['x-user-id']).toBeUndefined();
    expect(h['x-user-role']).toBeUndefined();
    expect(h['x-user-email']).toBeUndefined();
    // The gateway's own proof replaces whatever the client sent.
    expect(h['x-internal-token']).toBe(INTERNAL);
  });

  it.each([
    ['no token', undefined],
    ['a bad token', 'Bearer not-a-jwt'],
    ['an expired token', `Bearer ${token({ sub: 'u1', role: 'learner' }, { expiresIn: -10 })}`],
    ['a token signed with another secret', `Bearer ${jwt.sign({ sub: 'u1', role: 'learner' }, 'other', { issuer: 'ethiopialearn' })}`],
  ])('refuses a jwt route with %s', async (_label, authorization) => {
    const res = await fetch(`${base}/api/v1/profiles/me`, { headers: authorization ? { authorization } : {} });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('forwards a jwt route with a valid token, with the identity headers set by the gateway', async () => {
    const res = await fetch(`${base}/api/v1/profiles/me`, {
      headers: { authorization: `Bearer ${token({ sub: 'u1', role: 'educator', email: 'a@x.et' })}`, 'x-user-id': 'evil' },
    });
    expect(res.status).toBe(200);
    expect(seen[0].headers['x-user-id']).toBe('u1');
    expect(seen[0].headers['x-user-role']).toBe('educator');
    expect(seen[0].headers['x-user-email']).toBe(encodeURIComponent('a@x.et'));
  });

  it('refuses an internal route without the internal token, or with a wrong one', async () => {
    expect((await fetch(`${base}/api/v1/internal/users?ids=u1`)).status).toBe(401);
    expect((await fetch(`${base}/api/v1/internal/users?ids=u1`, { headers: { 'x-internal-token': 'wrong' } })).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('forwards an internal route with the internal token', async () => {
    const res = await fetch(`${base}/api/v1/internal/users?ids=u1`, { headers: { 'x-internal-token': INTERNAL } });
    expect(res.status).toBe(200);
    expect(seen[0].url).toBe('/api/v1/internal/users?ids=u1');
  });

  it('answers 404 for an unknown /api/v1 route without calling upstream', async () => {
    expect((await fetch(`${base}/api/v1/nope`)).status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});

describe('the web proxy headers', () => {
  it.each([
    ['the right secret', PROXY_SECRET],
    ['a wrong secret', 'gateway-spec-proxy-secret-not-rea1'],
    ['no secret', undefined],
  ])('never reach a service, with %s', async (_label, secret) => {
    const headers: Record<string, string> = { 'x-web-client-ip': '203.0.113.7' };
    if (secret) headers['x-web-proxy-secret'] = secret;
    expect((await fetch(`${base}/api/v1/auth/invite/abc`, { headers })).status).toBe(200);
    expect(seen[0].headers['x-web-proxy-secret']).toBeUndefined();
    expect(seen[0].headers['x-web-client-ip']).toBeUndefined();
  });
});

describe('a web proxy secret that does not match', () => {
  it('logs one warning a minute, naming the header but never its value', async () => {
    const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    // Earlier specs sent a wrong secret too: start a minute later.
    const later = Date.now() + 61_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => later);
    try {
      const wrong = 'gateway-spec-wrong-secret-value';
      for (let i = 0; i < 3; i++) await fetch(`${base}/api/v1/auth/invite/abc`, { headers: { 'x-web-proxy-secret': wrong } });
      await fetch(`${base}/api/v1/auth/invite/abc`, { headers: { 'x-web-proxy-secret': PROXY_SECRET } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/x-web-proxy-secret/);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(wrong);
    } finally {
      warn.mockRestore();
      clock.mockRestore();
    }
  });
});

describe('ipBucket', () => {
  it.each([
    ['203.0.113.7', 'ip:203.0.113.7'],
    ['::ffff:203.0.113.7', 'ip:203.0.113.7'],
    ['2001:db8::a:b:c:d', 'ip6:2001:db8:0:0'],
    ['2001:0db8:0000:0000:a:b:c:d', 'ip6:2001:db8:0:0'],
    ['2001:db8:1:2::1', 'ip6:2001:db8:1:2'],
    ['2001:DB8:1:2:3:4:5:6', 'ip6:2001:db8:1:2'],
    ['::1', 'ip6:0:0:0:0'],
  ])('%s → %s', (ip, bucket) => {
    expect(ipBucket(ip)).toBe(bucket);
  });
});

describe('rate-limit keys', () => {
  let limited: NestExpressApplication;
  let url: string;
  const login = (headers: Record<string, string> = {}) =>
    fetch(`${url}/api/v1/auth/login`, { method: 'POST', headers }).then((r) => r.status);
  const viaProxy = (ip: string, secret = PROXY_SECRET) => ({ 'x-web-proxy-secret': secret, 'x-web-client-ip': ip });

  beforeAll(async () => {
    process.env.RATE_LIMIT_AUTH_STRICT_PER_MIN = '2';
    process.env.RATE_LIMIT_AUTH_REFRESH_PER_MIN = '2';
    limited = await createGatewayApp({ logger: false });
    await limited.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${port(limited.getHttpServer() as Server)}`;
  });

  afterAll(async () => {
    await limited.close();
    delete process.env.RATE_LIMIT_AUTH_STRICT_PER_MIN;
    delete process.env.RATE_LIMIT_AUTH_REFRESH_PER_MIN;
  });

  it('buckets the login limit by the proxied client IP when the secret is right', async () => {
    expect([await login(viaProxy('203.0.113.1')), await login(viaProxy('203.0.113.1')), await login(viaProxy('203.0.113.1'))]).toEqual([200, 200, 429]);
    expect(await login(viaProxy('2001:db8::1'))).toBe(200); // another client, its own bucket
  });

  it('ignores the forwarded IP with a wrong secret, no secret or a non-IP value: all key by the caller', async () => {
    expect(await login(viaProxy('198.51.100.1', 'gateway-spec-proxy-secret-not-rea1'))).toBe(200);
    expect(await login({ 'x-web-client-ip': '198.51.100.2' })).toBe(200);
    // The caller's (127.0.0.1) bucket is now full, whatever address it claims.
    expect(await login(viaProxy('not-an-ip'))).toBe(429);
    expect(await login(viaProxy('198.51.100.3', 'wrong'))).toBe(429);
  });

  it('limits refresh per refresh token: two cookies from one IP get separate buckets', async () => {
    const refresh = (cookie: string) =>
      fetch(`${url}/api/v1/auth/refresh`, { method: 'POST', headers: { cookie } }).then((r) => r.status);
    expect([await refresh('el_refresh=token-a'), await refresh('theme=dark; el_refresh=token-a'), await refresh('el_refresh=token-a')]).toEqual([
      200, 200, 429,
    ]);
    expect(await refresh('el_refresh=token-b')).toBe(200);
  });
});
