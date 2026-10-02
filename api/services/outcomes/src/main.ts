import 'reflect-metadata';
import { bootstrapService, envInt } from '@ethiopialearn/common';
import { AppModule } from './app.module';

bootstrapService(AppModule, { serviceName: 'outcomes', port: envInt('PORT', 4104), requiredSecrets: ['CERT_SIGNING_SECRET'], storage: true });
