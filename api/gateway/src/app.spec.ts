import { createServer, IncomingHttpHeaders, Server } from 'http';
import { AddressInfo } from 'net';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as jwt from 'jsonwebtoken';
import { createGatewayApp } from './app';

/**
 * The gateway's request pipeline, run for real on `listen(0)` against a stub
 * upstream that records what it receives (Phase 11b, P1-29).
 */
const JWT_SECRET = 'gateway-spec-jwt-secret-not-real';
const INTERNAL = 'gateway-spec-internal-token-not-real';

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
  app = await createGatewayApp({ logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port(app.getHttpServer() as Server)}`;
});

afterAll(async () => {
  await app.close();
  await new Promise((r) => upstream.close(r));
  delete process.env.AUTH_SERVICE_URL;
  delete process.env.INTERNAL_API_TOKEN;
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
