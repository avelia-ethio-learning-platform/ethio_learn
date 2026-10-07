import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChapaModule } from 'chapa-nestjs';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import { entities, migrations, SCHEMA } from './database';
import { CHAPA_PROVIDER, chapaMode, LiveChapaProvider, MockChapaProvider } from './chapa.provider';
import { PaymentService } from './payment.service';
import { RefundService } from './refund.service';
import { PayoutService } from './payout.service';
import { GrowthService } from './growth.service';
import { SponsorshipService } from './sponsorship.service';
import { FinancialController } from './controllers';
import { GrowthController } from './growth.controller';
import { PayRequestPublicController } from './pay-request-public.controller';

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions(SCHEMA, entities, migrations)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'financial', outbox: true }),
    ScheduleModule.forRoot(),
    // chapa-nestjs SDK. The secret key is env-only (never in code / client).
    // In mock mode the SDK is registered with a placeholder but never called —
    // MockChapaProvider is bound instead.
    ChapaModule.register({
      secretKey: process.env.CHAPA_SECRET_KEY ?? 'CHASECK_TEST-placeholder',
    }),
  ],
  controllers: [FinancialController, GrowthController, PayRequestPublicController, HealthController],
  providers: [
    {
      provide: CHAPA_PROVIDER,
      useClass: chapaMode() === 'live' ? LiveChapaProvider : MockChapaProvider,
    },
    GrowthService,
    PaymentService,
    SponsorshipService,
    RefundService,
    PayoutService,
    InternalHttpClient,
  ],
})
export class AppModule {}
