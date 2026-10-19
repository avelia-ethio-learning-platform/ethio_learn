import 'reflect-metadata';
import { bootstrapService, envInt } from '@ethiopialearn/common';
import { AppModule } from './app.module';
import { emailProductionRules } from './email.provider';

bootstrapService(AppModule, { serviceName: 'notification', port: envInt('PORT', 4107), productionRules: emailProductionRules });
