import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChapaModule } from 'chapa-nestjs';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import {
  BulkPurchase,
  Coupon,
  Payment,
  Payout,
  PayoutHold,
  Referral,
  ReferralCode,
  RefundRequest,
  Sponsorship,
  Wallet,
  WalletTransaction,
} from './entities';
import { CHAPA_PROVIDER, chapaMode, LiveChapaProvider, MockChapaProvider } from './chapa.provider';
import { PaymentService } from './payment.service';
import { RefundService } from './refund.service';
import { PayoutService } from './payout.service';
import { GrowthService } from './growth.service';
import { SponsorshipService } from './sponsorship.service';
import { FinancialController } from './controllers';
import { GrowthController } from './growth.controller';

const entities = [Payment, Payout, RefundRequest, PayoutHold, Coupon, Wallet, WalletTransaction, Sponsorship, BulkPurchase, ReferralCode, Referral];

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
  controllers: [FinancialController, GrowthController, HealthController],
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
