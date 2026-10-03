import { Controller, Get } from '@nestjs/common';

let serviceName = 'unknown';

/** Called by bootstrapService before the app is built, so /health names the service that answered. */
export function setServiceName(name: string): void {
  serviceName = name;
}

/** Liveness only: answers at once, even on a cold start with the database or broker down (see /ready). */
@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok', service: serviceName, ts: new Date().toISOString() };
  }
}
