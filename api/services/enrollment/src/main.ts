import 'reflect-metadata';
import { bootstrapService, envInt } from '@ethiopialearn/common';
import { AppModule } from './app.module';

bootstrapService(AppModule, { serviceName: 'enrollment', port: envInt('PORT', 4103) });
