import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { JobRunner } from '@ethiopialearn/common';
import { EnrollmentService } from './enrollment.service';

/**
 * Enrollment's scheduled job (Phase 9c, decision 5), under a lease in `job_leases`:
 * the in-process cron runs while the instance is awake, and the GitHub schedule
 * starts it through POST /api/v1/jobs/enrollment/inactivity.
 */
@Injectable()
export class EnrollmentJobs {
  readonly runner: JobRunner;

  constructor(dataSource: DataSource, enrollments: EnrollmentService) {
    this.runner = new JobRunner(dataSource, { inactivity: { ttlMs: 30 * 60_000, run: () => enrollments.nudgeInactiveLearners() } }, 'Enrollment');
  }

  /** Daily at 06:00 UTC (09:00 Addis). */
  @Cron('0 6 * * *')
  inactivity() {
    return this.runner.run('inactivity');
  }
}
