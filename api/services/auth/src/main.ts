import 'reflect-metadata';
import { bootstrapService, envInt } from '@ethiopialearn/common';
import { AppModule } from './app.module';
import { AuthService } from './auth.service';

bootstrapService(AppModule, {
  serviceName: 'auth',
  port: envInt('PORT', 4101),
  requiredSecrets: ['JWT_SECRET'],
  readyChecks: (app) => ({ redis: () => app.get(AuthService).pingRedis() }),
});
