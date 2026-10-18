/**
 * Forwards the cookie routes (/api/v1/auth/* and PUT /api/v1/profiles/password)
 * from the web origin to the gateway, so the refresh cookie is first-party on
 * the web host (Phase 11b). Every other API call goes straight to the gateway.
 *
 * Server only: it reads WEB_PROXY_SECRET, which proves to the gateway that the
 * client IP it adds came from here (x-web-client-ip).
 */
const TIMEOUT_MS = 20_000; // under the route's maxDuration (30 s)

const FORWARDED_REQUEST_HEADERS = ['content-type', 'authorization', 'accept-language', 'user-agent', 'x-request-id'];

// fetch already decoded the body, so its encoding and length no longer apply.
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie', // copied one by one below
]);

/** Only these paths may be forwarded with the proxy secret. */
function allowed(path: string): boolean {
  return path.startsWith('/api/v1/auth/') || path === '/api/v1/profiles/password';
}

function gatewayBase(): string {
  return (process.env.GATEWAY_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
}

/** Only the refresh cookie leaves the web origin. */
function refreshCookie(header: string | null): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === 'el_refresh') return `el_refresh=${part.slice(eq + 1).trim()}`;
  }
  return undefined;
}

/** The browser's address as Vercel reports it; Vercel overwrites both headers, so a client can't forge them. */
function clientIp(req: Request): string | undefined {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined;
}

function waking(): Response {
  return Response.json(
    { statusCode: 503, code: 'service_waking', message: 'The server is waking up. Try again in a minute.' },
    { status: 503 },
  );
}

export async function proxyToGateway(req: Request): Promise<Response> {
  // The path from the URL itself (as req.nextUrl), never the route's params.
  const url = new URL(req.url);
  if (!allowed(url.pathname)) return Response.json({ statusCode: 404, message: 'Not found' }, { status: 404 });

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const cookie = refreshCookie(req.headers.get('cookie'));
  if (cookie) headers.set('cookie', cookie);
  const secret = process.env.WEB_PROXY_SECRET;
  if (secret) {
    headers.set('x-web-proxy-secret', secret);
    const ip = clientIp(req);
    if (ip) headers.set('x-web-client-ip', ip);
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(`${gatewayBase()}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Unreachable or no answer in time: the client treats it like any sleeping service.
    return waking();
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) out.set(name, value);
  });
  for (const setCookie of upstream.headers.getSetCookie()) out.append('set-cookie', setCookie);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
