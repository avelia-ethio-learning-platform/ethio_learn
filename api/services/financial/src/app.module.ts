import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, createJobsController, EventBusModule, HealthController, InternalHttpClient, JOB_RUNNER } from '@ethiopialearn/common';
import { entities, migrations, SCHEMA } from './database';
import { FinancialJobs } from './jobs';
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
  ],
  controllers: [FinancialController, GrowthController, PayRequestPublicController, HealthController, createJobsController('financial')],
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
    FinancialJobs,
    { provide: JOB_RUNNER, useFactory: (jobs: FinancialJobs) => jobs.runner, inject: [FinancialJobs] },
  ],
})
export class AppModule {}
