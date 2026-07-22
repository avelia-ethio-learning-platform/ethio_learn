import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok', service: process.env.SERVICE_NAME ?? 'unknown', ts: new Date().toISOString() };
  }
}
