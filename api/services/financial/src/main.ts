import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { bootstrapService, envInt } from '@ethiopialearn/common';
import { AppModule } from './app.module';
import { chapaProductionProblems, chapaProductionWarnings } from './production-rules';

for (const warning of chapaProductionWarnings(process.env)) Logger.warn(warning, 'Bootstrap');

// rawBody: required for HMAC verification of the Chapa webhook (spec §6).
bootstrapService(AppModule, { serviceName: 'financial', port: envInt('PORT', 4105), rawBody: true, productionRules: chapaProductionProblems });
