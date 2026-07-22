import 'reflect-metadata';
import { bootstrapService, envInt } from '@ethiopialearn/common';
import { AppModule } from './app.module';

bootstrapService(AppModule, { serviceName: 'auth', port: envInt('PORT', 4101) });
