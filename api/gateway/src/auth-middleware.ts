import { Logger } from '@nestjs/common';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { isIP } from 'net';
import { env } from '@ethiopialearn/common';
import { AuthMode, authModeFor, resolveRoute } from './routes';
import { matchPath } from './request-path';
import { matchesSecret, validJobsToken } from './secrets';

interface TokenClaims {
  sub: string;
  role: string;
  email?: string;
}

export function verifyBearer(req: Request): TokenClaims | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7), env('JWT_SECRET'), { issuer: 'ethiopialearn', algorithms: ['HS256'] }) as unknown as TokenClaims;
  } catch {
    return null;
  }
}

export function validInternalToken(presented: string | undefined): boolean {
  return matchesSecret(presented, env('INTERNAL_API_TOKEN', ''));
}

const PROXY_SECRET_HEADER = 'x-web-proxy-secret';
const CLIENT_IP_HEADER = 'x-web-client-ip';

type WithClientIp = Request & { clientIp?: string };

/** The caller's address for rate limits (and the access log): set by `clientIp()`, else `req.ip`. */
export function clientIpOf(req: Request): string {
  return (req as WithClientIp).clientIp ?? req.ip ?? '';
}

/**
 * The web's route handler (Vercel) forwards the browser's address in
 * `x-web-client-ip`, proved by `x-web-proxy-secret` = WEB_PROXY_SECRET. Only
 * then is that address trusted; otherwise it's `req.ip` (trust proxy 1). Both
 * headers are removed in every case, so they never reach a service.
 */
export function clientIp(): RequestHandler {
  let lastWarned = -Infinity;
  return (req: Request, _res: Response, next: NextFunction) => {
    const presented = req.headers[PROXY_SECRET_HEADER];
    const forwarded = req.headers[CLIENT_IP_HEADER];
    delete req.headers[PROXY_SECRET_HEADER];
    delete req.headers[CLIENT_IP_HEADER];
    const proven = typeof presented === 'string' && matchesSecret(presented, env('WEB_PROXY_SECRET', '').trim());
    // A web that sends a secret the gateway doesn't share puts every user in the
    // web's own IP buckets: say so, at most once a minute, never with the value.
    if (presented !== undefined && !proven && Date.now() - lastWarned >= 60_000) {
      lastWarned = Date.now();
      Logger.warn(`${PROXY_SECRET_HEADER} does not match WEB_PROXY_SECRET: rate limits key by the web's address, not the user's`, 'Gateway');
    }
    const trusted = proven && typeof forwarded === 'string' && isIP(forwarded) !== 0;
    (req as WithClientIp).clientIp = trusted ? (forwarded as string) : (req.ip ?? '');
    next();
  };
}

/**
 * The rate-limit bucket for an address: IPv4 as is, IPv6 by its /64 (the
 * address expanded first, so `2001:db8::a:b:c:d` and `2001:db8:0:0:…` agree).
 */
export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return `ip:${mapped[1]}`;
  if (isIP(ip) !== 6) return `ip:${ip}`;
  const groups = (part: string) => (part ? part.split(':') : []);
  const [head, tail] = ip.split('::');
  const h = groups(head);
  const full =
    tail === undefined
      ? h
      : [...h, ...Array(8 - h.length - groups(tail).reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0)).fill('0'), ...groups(tail)];
  return `ip6:${full
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}`;
}

/** `el_refresh` from a raw Cookie header, without logging or storing it. */
function refreshCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === 'el_refresh') return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

/** The refresh bucket's key: a hash prefix of the refresh token, so the token never sits in the limiter. */
export function refreshTokenKey(req: Request): string | undefined {
  const token = refreshCookie(req.headers.cookie);
  return token ? `rt:${createHash('sha256').update(token).digest('hex').slice(0, 32)}` : undefined;
}

export interface GatewayAuthDeps {
  /** Forwards the request to its upstream service. */
  proxy: (req: Request, res: Response, next: NextFunction) => void;
  /** Applies the rate limits for the request, then calls `next`. */
  throttle: (req: Request, res: Response, next: () => void) => void;
}

/**
 * The gateway's request pipeline for /api/v1: route lookup, identity headers,
 * the internal and jobs tokens, JWT verification, rate limits, then the proxy.
 * Mounted at the ROOT so Express never strips the /api/v1 prefix — the full
 * path is used both for route resolution and for forwarding upstream.
 */
export function gatewayAuth({ proxy, throttle }: GatewayAuthDeps): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Upstream routing ignores case and a trailing slash, so the prefix check,
    // route table and rate buckets all use the normalised path. The request is
    // forwarded with its original URL.
    const path = (req.originalUrl ?? req.url).split('?')[0];
    if (!matchPath(path).startsWith('/api/v1')) {
      next();
      return;
    }
    const rule = resolveRoute(path);
    if (!rule) {
      // Scope discipline (spec §0 rule 1): anything not specified is out of scope.
      res.status(404).json({ statusCode: 404, message: 'Not found (out of MVP scope or unknown route)' });
      return;
    }

    // Identity headers are ONLY ever set by the gateway — strip client spoofing.
    const presentedInternal = String(req.headers['x-internal-token'] ?? '');
    delete req.headers['x-user-id'];
    delete req.headers['x-user-role'];
    delete req.headers['x-user-email'];
    delete req.headers['x-internal-token'];

    const mode: AuthMode = authModeFor(rule, req.method, path);

    // Proof to the upstream service that this request came through the gateway
    // rather than straight off the internet (services enforce it when
    // REQUIRE_INTERNAL_TOKEN is on). Set from our own env, never echoed from
    // the client — the client-presented value was already stripped above.
    const ownInternalToken = env('INTERNAL_API_TOKEN', '');
    if (ownInternalToken) req.headers['x-internal-token'] = ownInternalToken;

    // The scheduler (GitHub Actions): its own token, never a JWT, never the mesh-wide
    // internal token. Stripped before proxying; the service sees the internal token above.
    if (mode === 'jobs') {
      const ok = validJobsToken(req.headers.authorization);
      delete req.headers.authorization;
      if (!ok) {
        res.status(401).json({ statusCode: 401, message: 'Jobs endpoint' });
        return;
      }
      proxy(req, res, next);
      return;
    }

    if (mode === 'internal') {
      if (!validInternalToken(presentedInternal)) {
        res.status(401).json({ statusCode: 401, message: 'Internal endpoint' });
        return;
      }
      req.headers['x-internal-token'] = presentedInternal;
      proxy(req, res, next);
      return;
    }

    // Attach identity whenever a valid token is presented (public routes can
    // still personalize, e.g. an owner previewing an unpublished course).
    const claims = verifyBearer(req);
    if (claims) {
      req.headers['x-user-id'] = claims.sub;
      req.headers['x-user-role'] = claims.role;
      req.headers['x-user-email'] = encodeURIComponent(claims.email ?? '');
    }

    if (mode === 'jwt' && !claims) {
      res.status(401).json({ statusCode: 401, message: 'Authentication required' });
      return;
    }

    // Throttle after identity is attached so authenticated traffic is keyed
    // per user: the general cap always applies, plus the per-bucket cap.
    throttle(req, res, () => proxy(req, res, next));
  };
}
