import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChapaModule } from 'chapa-nestjs';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import { Payment, Payout, PayoutHold, RefundRequest } from './entities';
import { CHAPA_PROVIDER, chapaMode, LiveChapaProvider, MockChapaProvider } from './chapa.provider';
import { PaymentService } from './payment.service';
import { RefundService } from './refund.service';
import { PayoutService } from './payout.service';
import { FinancialController } from './controllers';

const entities = [Payment, Payout, RefundRequest, PayoutHold];

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions('financial', entities)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'financial' }),
    ScheduleModule.forRoot(),
    // chapa-nestjs SDK. The secret key is env-only (never in code / client).
    // In mock mode the SDK is registered with a placeholder but never called —
    // MockChapaProvider is bound instead.
    ChapaModule.register({
      secretKey: process.env.CHAPA_SECRET_KEY ?? 'CHASECK_TEST-placeholder',
    }),
  ],
  controllers: [FinancialController, HealthController],
  providers: [
    {
      provide: CHAPA_PROVIDER,
      useClass: chapaMode() === 'live' ? LiveChapaProvider : MockChapaProvider,
    },
    PaymentService,
    RefundService,
    PayoutService,
    InternalHttpClient,
  ],
})
export class AppModule {}
