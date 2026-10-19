import { createHash } from 'crypto';
import { createServer, IncomingHttpHeaders, Server } from 'http';
import { AddressInfo } from 'net';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createGatewayApp } from './app';

/**
 * The HTTP behaviour the gateway gets from Express and Nest rather than from
 * its own code: query strings, bodies, cookies, CORS, trust proxy and error
 * responses. Pinned so a framework upgrade (Nest 11 / Express 5, P2-45) cannot
 * change them silently.
 */
interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  bodyLength: number;
  bodySha: string;
}

let upstream: Server;
let seen: Seen[] = [];
let app: NestExpressApplication;
let base: string;
const port = (s: Server) => (s.address() as AddressInfo).port;
const SET_COOKIE = 'el_refresh=rotated-value; Max-Age=604800; Path=/api/v1/auth; HttpOnly; Secure; SameSite=None';

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        bodyLength: body.length,
        bodySha: createHash('sha256').update(body).digest('hex'),
      });
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/api/v1/auth/refresh')) res.setHeader('set-cookie', SET_COOKIE);
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.JWT_SECRET = 'gateway-http-spec-jwt-secret-not-real';
  process.env.AUTH_SERVICE_URL = `127.0.0.1:${port(upstream)}`;
  process.env.CORS_ORIGINS = 'https://app.example.et';
  process.env.RATE_LIMIT_AUTH_STRICT_PER_MIN = '2';
  app = await createGatewayApp({ logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port(app.getHttpServer() as Server)}`;
});

afterAll(async () => {
  await app.close();
  await new Promise((r) => upstream.close(r));
  delete process.env.AUTH_SERVICE_URL;
  delete process.env.CORS_ORIGINS;
  delete process.env.RATE_LIMIT_AUTH_STRICT_PER_MIN;
});

beforeEach(() => {
  seen = [];
});

describe('query strings', () => {
  it.each([
    '?ids=a,b&pairs=c:1,d:2',
    '?x[]=1&x[]=2',
    '?y[z]=2&y[z]=3',
    '?q=%E1%8A%A0%E1%88%9B&q=two&empty=',
  ])('reach the service byte for byte: %s', async (query) => {
    expect((await fetch(`${base}/api/v1/auth/invite/abc${query}`)).status).toBe(200);
    expect(seen[0].url).toBe(`/api/v1/auth/invite/abc${query}`);
  });
});

describe('request bodies', () => {
  it.each([
    ['application/json', 600 * 1024],
    ['application/x-www-form-urlencoded', 200 * 1024],
    ['text/plain', 10],
  ])('stream through unparsed and unlimited: %s, %d bytes', async (type, size) => {
    const body = Buffer.alloc(size, type === 'application/json' ? '7' : 'a');
    const res = await fetch(`${base}/api/v1/auth/body-check`, { method: 'POST', headers: { 'content-type': type }, body });
    expect(res.status).toBe(200);
    expect(seen[0].bodyLength).toBe(size);
    expect(seen[0].bodySha).toBe(createHash('sha256').update(body).digest('hex'));
    expect(seen[0].headers['content-type']).toBe(type);
  });
});

describe('cookies', () => {
  it('forwards the Cookie header and returns the service Set-Cookie unchanged', async () => {
    const res = await fetch(`${base}/api/v1/auth/refresh`, { method: 'POST', headers: { cookie: 'theme=dark; el_refresh=old-value' } });
    expect(res.status).toBe(200);
    expect(seen[0].headers.cookie).toBe('theme=dark; el_refresh=old-value');
    expect(res.headers.getSetCookie()).toEqual([SET_COOKIE]);
  });
});

describe('CORS', () => {
  const preflight = (origin: string) =>
    fetch(`${base}/api/v1/auth/login`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' },
    });

  it('answers a preflight from an allowed origin itself, with credentials', async () => {
    const res = await preflight('https://app.example.et');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.et');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type,authorization');
    expect(seen).toHaveLength(0);
  });

  it('exposes x-request-id on a simple request from an allowed origin', async () => {
    const res = await fetch(`${base}/api/v1/auth/invite/abc`, { headers: { origin: 'https://app.example.et' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.et');
    expect(res.headers.get('access-control-expose-headers')).toBe('x-request-id');
  });

  it('refuses another origin with a 500 and no CORS headers, before any service is called', async () => {
    const res = await preflight('https://evil.example');
    expect(res.status).toBe(500);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(await res.text()).not.toContain('at ');
    expect(seen).toHaveLength(0);
  });
});

describe('trust proxy 1', () => {
  const login = (xff: string) =>
    fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'x-forwarded-for': xff } }).then((r) => r.status);

  it('keys by the right-most X-Forwarded-For entry, ignoring what the client prepends', async () => {
    expect([await login('198.51.100.9'), await login('203.0.113.50, 198.51.100.9'), await login('203.0.113.51, 198.51.100.9')]).toEqual([
      200, 200, 429,
    ]);
    expect(await login('198.51.100.9, 203.0.113.52')).toBe(200);
  });
});

describe('responses the gateway makes itself', () => {
  it('answers its own /health', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'gateway' });
  });

  it("answers Nest's JSON 404 outside /api/v1", async () => {
    const res = await fetch(`${base}/nope?x=1`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ statusCode: 404, error: 'Not Found', message: 'Cannot GET /nope?x=1' });
  });

  it('answers its own 404 for an unknown /api/v1 route', async () => {
    const res = await fetch(`${base}/api/v1/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ statusCode: 404, message: 'Not found (out of MVP scope or unknown route)' });
  });

  it('answers 502 JSON when the service is down', async () => {
    const down = createServer();
    await new Promise<void>((r) => down.listen(0, '127.0.0.1', r));
    const downPort = port(down);
    await new Promise((r) => down.close(r));
    process.env.AUTH_SERVICE_URL = `127.0.0.1:${downPort}`;
    try {
      const res = await fetch(`${base}/api/v1/auth/invite/abc`);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ statusCode: 502, message: 'Upstream service unavailable' });
    } finally {
      process.env.AUTH_SERVICE_URL = `127.0.0.1:${port(upstream)}`;
    }
  });
});
