import 'reflect-metadata';
import { Controller, Get, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import * as jwt from 'jsonwebtoken';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { timingSafeEqual } from 'crypto';
import { Agent } from 'http';
import { env, envInt } from '@ethiopialearn/common';
import { AuthMode, resolveRoute } from './routes';

// Reuse TCP connections to the upstream services instead of opening a new
// socket per request — the single biggest gateway win under high concurrency.
const keepAliveAgent = new Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: envInt('PROXY_MAX_SOCKETS', 256),
  maxFreeSockets: 32,
});

@Controller('health')
class GatewayHealthController {
  @Get()
  health() {
    return { status: 'ok', service: 'gateway', ts: new Date().toISOString() };
  }
}

@Module({ controllers: [GatewayHealthController] })
class GatewayModule {}

interface TokenClaims {
  sub: string;
  role: string;
  email?: string;
}

function verifyBearer(req: Request): TokenClaims | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7), env('JWT_SECRET'), { issuer: 'ethiopialearn' }) as unknown as TokenClaims;
  } catch {
    return null;
  }
}

function validInternalToken(presented: string | undefined): boolean {
  const expected = env('INTERNAL_API_TOKEN', '');
  if (!expected || !presented || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

async function bootstrap() {
  // bodyParser disabled: requests stream straight through the proxy, which
  // both preserves the raw webhook body for HMAC verification (spec §6) and
  // avoids re-serialization overhead.
  const app = await NestFactory.create<NestExpressApplication>(GatewayModule, { bodyParser: false });
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.use(helmet());
  // Allow the configured web origin(s); in dev also reflect any localhost /
  // 127.0.0.1 port so the exact dev-server port never breaks the browser call.
  // Set CORS_ORIGINS (comma-separated) for extra production origins.
  const allowedOrigins = (env('CORS_ORIGINS', env('WEB_URL', 'http://localhost:3000')))
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const devLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  const isProd = process.env.NODE_ENV === 'production';
  app.enableCors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / server-to-server / curl
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (!isProd && devLocalhost.test(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
    credentials: true,
  });

  app.use(
    '/api/v1/auth',
    rateLimit({ windowMs: 60_000, limit: envInt('RATE_LIMIT_AUTH_PER_MIN', 30), standardHeaders: true, legacyHeaders: false }),
  );
  app.use(
    rateLimit({ windowMs: 60_000, limit: envInt('RATE_LIMIT_PER_MIN', 300), standardHeaders: true, legacyHeaders: false }),
  );

  const proxy = createProxyMiddleware<Request, Response>({
    changeOrigin: true,
    agent: keepAliveAgent,
    // Fail fast on a stuck upstream so gateway sockets don't pile up under load.
    proxyTimeout: envInt('PROXY_TIMEOUT_MS', 30_000),
    timeout: envInt('PROXY_TIMEOUT_MS', 30_000),
    // The full request path (e.g. /api/v1/auth/login) is preserved and
    // forwarded to the target service unchanged — services answer under the
    // same /api/v1 prefix (spec §9).
    router: (req) => resolveRoute((req.originalUrl ?? req.url).split('?')[0])?.target(),
    on: {
      error: (err, _req, res) => {
        Logger.error(`proxy error: ${err.message}`, 'Gateway');
        const httpRes = res as Response;
        if (httpRes && typeof httpRes.writeHead === 'function' && !httpRes.headersSent) {
          httpRes.writeHead(502, { 'Content-Type': 'application/json' });
          httpRes.end(JSON.stringify({ statusCode: 502, message: 'Upstream service unavailable' }));
        } else if (httpRes && typeof (httpRes as any).end === 'function') {
          (httpRes as any).end();
        }
      },
    },
  });

  // Mounted at the ROOT so Express never strips the /api/v1 prefix — the full
  // path is used both for route resolution and for forwarding upstream.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const path = (req.originalUrl ?? req.url).split('?')[0];
    if (!path.startsWith('/api/v1')) {
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

    const mode: AuthMode = typeof rule.auth === 'function' ? rule.auth(req.method, path) : rule.auth;

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

    proxy(req, res, next);
  });

  const port = envInt('PORT', 4000);
  await app.listen(port);
  Logger.log(`gateway listening on :${port}`, 'Bootstrap');
}

bootstrap();
