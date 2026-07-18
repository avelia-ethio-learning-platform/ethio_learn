import 'reflect-metadata';
import { bootstrapService, envInt } from '@ethiopialearn/common';
import { AppModule } from './app.module';

// rawBody: required for HMAC verification of the Chapa webhook (spec §6).
bootstrapService(AppModule, { serviceName: 'financial', port: envInt('PORT', 4105), rawBody: true });
