import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { JobRunner } from '@ethiopialearn/common';
import { PaymentService } from './payment.service';
import { PayoutService } from './payout.service';

const MIN = 60_000;

/**
 * Financial's scheduled jobs (Phase 9c, decision 5). Each runs under a lease in
 * `job_leases`, so the in-process crons (which run only while the instance is
 * awake) and the GitHub schedule (POST /api/v1/jobs/financial/<job>) never overlap.
 */
@Injectable()
export class FinancialJobs {
  readonly runner: JobRunner;

  constructor(dataSource: DataSource, payments: PaymentService, payouts: PayoutService) {
    this.runner = new JobRunner(
      dataSource,
      {
        // The Chapa safety net, then the expiry of abandoned checkouts (P2-01).
        sweep: { ttlMs: 10 * MIN, run: async () => ({ ...(await payments.sweepPendingPayments()), ...(await payments.expireAbandonedCheckouts()) }) },
        effects: { ttlMs: 10 * MIN, run: () => payments.completePendingEffects() },
        nudges: { ttlMs: 30 * MIN, run: () => payments.nudgeAbandonedCheckouts() },
        payouts: { ttlMs: 30 * MIN, run: () => payouts.runPayouts() },
      },
      'Financial',
    );
  }

  @Cron('*/2 * * * *')
  sweep() {
    return this.runner.run('sweep');
  }

  @Cron('*/2 * * * *')
  effects() {
    return this.runner.run('effects');
  }

  @Cron('15 * * * *')
  nudges() {
    return this.runner.run('nudges');
  }

  /** Nightly payout run (spec §12.3). */
  @Cron('0 2 * * *')
  payouts() {
    return this.runner.run('payouts');
  }
}
