import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { timingSafeEqual } from 'crypto';
import { envBool } from './config/env';
import { assertProductionConfig } from './config/production-config';
import { DbErrorFilter } from './http/db-error.filter';

export interface BootstrapOptions {
  serviceName: string;
  port: number;
  /** Keep the raw request body available (needed for Chapa HMAC verification). */
  rawBody?: boolean;
  /** Secrets this service reads besides INTERNAL_API_TOKEN; checked at boot in production. */
  requiredSecrets?: readonly string[];
  /** Uses S3 storage, so production must not run on the local MinIO keys. */
  storage?: boolean;
  /** The service's own production rules (see ProductionConfigSpec.rules). */
  productionRules?: (environment: NodeJS.ProcessEnv) => string[];
}

export async function bootstrapService(appModule: unknown, options: BootstrapOptions): Promise<INestApplication> {
  // Before the app module is built, so nothing (migrations included) runs on
  // an unsafe production configuration.
  assertProductionConfig({
    service: options.serviceName,
    secrets: options.requiredSecrets,
    storage: options.storage,
    rules: options.productionRules,
  });
  const app = await NestFactory.create(appModule as any, { rawBody: options.rawBody ?? false });

  // RolesGuard trusts the gateway's x-user-* headers, which is only safe while
  // services are unreachable from the internet. Render's free web services each
  // get a public URL and cannot be made private, so there the gateway is not
  // the only possible caller and those headers would otherwise be forgeable by
  // anyone. Requiring the shared token on EVERY route (not just /internal)
  // restores "the gateway is the only entry point". On by default in
  // production (and assertProductionConfig refuses `false` there); off by
  // default in local dev and tests, where services are not exposed.
  if (envBool('REQUIRE_INTERNAL_TOKEN', process.env.NODE_ENV === 'production')) {
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

  // Express's default 100kb JSON limit answers ~34k Amharic characters (3 bytes
  // each) of AI-outline source text with a bare 413 before the DTO's readable
  // length error can run. 512kb is a backstop; each DTO still bounds its
  // fields. Registered after the token check so unauthenticated callers cannot
  // make us parse large bodies. The cast: useBodyParser is declared on the
  // Express app type, and this package does not depend on platform-express.
  (app as INestApplication & { useBodyParser(parser: 'json', options: { limit: string }): unknown }).useBodyParser('json', { limit: '512kb' });

  // All spec endpoints live under /api/v1 (spec §9). The gateway forwards the
  // full path unchanged, so every service must answer under this prefix.
  // `health` is excluded so container/liveness probes can hit bare /health.
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new DbErrorFilter(app.getHttpAdapter()));
  app.enableShutdownHooks();
  await app.listen(options.port);
  Logger.log(`${options.serviceName} listening on :${options.port}`, 'Bootstrap');
  return app;
}
