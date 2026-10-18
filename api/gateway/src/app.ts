import 'reflect-metadata';
import { Controller, Get, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { Agent, Server } from 'http';
import { Agent as HttpsAgent } from 'https';
import { env, envInt } from '@ethiopialearn/common';
import { resolveRoute } from './routes';
import { gatewayAuth } from './auth-middleware';
import { classifyRequest, DEFAULT_LIMITS_PER_MIN as DEFAULTS, RatePolicy } from './rate-policy';

@Controller('health')
class GatewayHealthController {
  @Get()
  health() {
    return { status: 'ok', service: 'gateway', ts: new Date().toISOString() };
  }
}

@Module({ controllers: [GatewayHealthController] })
class GatewayModule {}

/**
 * The gateway app, configured but not listening: `main.ts` starts it, and
 * specs run it on `listen(0)` against a stub upstream.
 */
export async function createGatewayApp(options: { logger?: false } = {}): Promise<NestExpressApplication> {
  // Reuse TCP connections to the upstream services instead of opening a new
  // socket per request — the single biggest gateway win under high concurrency.
  const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: 15_000,
    maxSockets: envInt('PROXY_MAX_SOCKETS', 256),
    maxFreeSockets: 32,
  };
  const keepAliveAgent = new Agent(agentOptions);
  // An http.Agent throws ERR_INVALID_PROTOCOL on an https: target, so the scheme
  // of the resolved target decides which agent is used. Targets are http:// in
  // docker-compose and https://*.onrender.com on Render's free plan, where
  // service-to-service traffic has to leave over the public internet.
  const keepAliveHttpsAgent = new HttpsAgent(agentOptions);

  // bodyParser disabled: requests stream straight through the proxy, which
  // both preserves the raw webhook body for HMAC verification (spec §6) and
  // avoids re-serialization overhead.
  const app = await NestFactory.create<NestExpressApplication>(GatewayModule, { bodyParser: false, ...options });
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

  // ---- rate limiting -------------------------------------------------------
  // Keyed by authenticated user id when present (many learners share campus /
  // mobile-carrier NAT IPs, so pure per-IP limits would starve them), falling
  // back to IP for anonymous traffic. Credential endpoints stay IP-keyed —
  // there is no trusted user yet during a brute-force attempt. IPv6 clients
  // are bucketed by /64 so one subscriber can't rotate through a prefix.
  const ipKey = (req: Request): string => {
    const ip = req.ip ?? '';
    return ip.includes(':') ? `ip6:${ip.split(':').slice(0, 4).join(':')}` : `ip:${ip}`;
  };
  const userKey = (req: Request): string => {
    const uid = req.headers['x-user-id'];
    return typeof uid === 'string' && uid ? `u:${uid}` : ipKey(req);
  };
  const makeLimiter = (limit: number, keyGenerator: (req: Request) => string) =>
    rateLimit({
      windowMs: 60_000,
      limit,
      keyGenerator,
      standardHeaders: true,
      legacyHeaders: false,
      // Static config + explicit trust-proxy/key handling above; the startup
      // validators only flag our intentional custom IP keying.
      validate: false,
      handler: (_req, res) =>
        res.status(429).json({ statusCode: 429, message: 'Too many requests — please slow down and try again shortly.' }),
    });
  const limiters: Record<RatePolicy, ReturnType<typeof rateLimit> | null> = {
    'auth-strict': makeLimiter(envInt('RATE_LIMIT_AUTH_STRICT_PER_MIN', DEFAULTS['auth-strict']), ipKey),
    auth: makeLimiter(envInt('RATE_LIMIT_AUTH_PER_MIN', DEFAULTS.auth), ipKey),
    ai: makeLimiter(envInt('RATE_LIMIT_AI_PER_MIN', DEFAULTS.ai), userKey),
    'community-write': makeLimiter(envInt('RATE_LIMIT_COMMUNITY_PER_MIN', DEFAULTS['community-write']), userKey),
    'payment-initiate': makeLimiter(envInt('RATE_LIMIT_PAYMENT_PER_MIN', DEFAULTS['payment-initiate']), userKey),
    write: makeLimiter(envInt('RATE_LIMIT_WRITE_PER_MIN', DEFAULTS.write), userKey),
    general: null, // covered by the always-on limiter below
  };
  const generalLimiter = makeLimiter(envInt('RATE_LIMIT_PER_MIN', DEFAULTS.general), userKey);

  const targetFor = (req: Request) => resolveRoute((req.originalUrl ?? req.url).split('?')[0])?.target();

  const makeProxy = (agent: Agent | HttpsAgent) =>
    createProxyMiddleware<Request, Response>({
    changeOrigin: true,
    agent,
    // Fail fast on a stuck upstream so gateway sockets don't pile up under load.
    proxyTimeout: envInt('PROXY_TIMEOUT_MS', 30_000),
    timeout: envInt('PROXY_TIMEOUT_MS', 30_000),
    // The full request path (e.g. /api/v1/auth/login) is preserved and
    // forwarded to the target service unchanged — services answer under the
    // same /api/v1 prefix (spec §9).
    router: (req) => targetFor(req),
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

  const httpProxy = makeProxy(keepAliveAgent);
  const httpsProxy = makeProxy(keepAliveHttpsAgent);
  const proxy = (req: Request, res: Response, next: NextFunction) =>
    (targetFor(req)?.startsWith('https:') ? httpsProxy : httpProxy)(req, res, next);

  const throttle = (req: Request, res: Response, next: () => void) => {
    const specific = limiters[classifyRequest(req.method, (req.originalUrl ?? req.url).split('?')[0])];
    generalLimiter(req, res, () => {
      if (specific) specific(req, res, next);
      else next();
    });
  };

  app.use(gatewayAuth({ proxy, throttle }));

  // Once the server is closed, the upstream sockets go too.
  (app.getHttpServer() as Server).on('close', () => {
    keepAliveAgent.destroy();
    keepAliveHttpsAgent.destroy();
  });

  return app;
}
