import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { timingSafeEqual } from 'crypto';
import { envBool } from './config/env';

export interface BootstrapOptions {
  serviceName: string;
  port: number;
  /** Keep the raw request body available (needed for Chapa HMAC verification). */
  rawBody?: boolean;
}

export async function bootstrapService(appModule: unknown, options: BootstrapOptions): Promise<INestApplication> {
  const app = await NestFactory.create(appModule as any, { rawBody: options.rawBody ?? false });

  // RolesGuard trusts the gateway's x-user-* headers, which is only safe while
  // services are unreachable from the internet. Render's free web services each
  // get a public URL and cannot be made private, so there the gateway is not
  // the only possible caller and those headers would otherwise be forgeable by
  // anyone. Requiring the shared token on EVERY route (not just /internal)
  // restores "the gateway is the only entry point". Opt-in so local dev and
  // tests, where services are not exposed, keep working unchanged.
  if (envBool('REQUIRE_INTERNAL_TOKEN', false)) {
    const expected = Buffer.from(process.env.INTERNAL_API_TOKEN ?? '');
    if (expected.length === 0) {
      throw new Error('REQUIRE_INTERNAL_TOKEN is set but INTERNAL_API_TOKEN is empty — every request would be rejected.');
    }
    app.use((req: any, res: any, next: () => void) => {
      if (req.path === '/health') return next();
      const presented = Buffer.from(String(req.headers['x-internal-token'] ?? ''));
      if (presented.length === expected.length && timingSafeEqual(presented, expected)) return next();
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ statusCode: 401, message: 'Direct access denied — requests must arrive via the API gateway' }));
    });
  }

  // All spec endpoints live under /api/v1 (spec §9). The gateway forwards the
  // full path unchanged, so every service must answer under this prefix.
  // `health` is excluded so container/liveness probes can hit bare /health.
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(options.port);
  Logger.log(`${options.serviceName} listening on :${options.port}`, 'Bootstrap');
  return app;
}
