import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

export interface BootstrapOptions {
  serviceName: string;
  port: number;
  /** Keep the raw request body available (needed for Chapa HMAC verification). */
  rawBody?: boolean;
}

export async function bootstrapService(appModule: unknown, options: BootstrapOptions): Promise<INestApplication> {
  const app = await NestFactory.create(appModule as any, { rawBody: options.rawBody ?? false });
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
