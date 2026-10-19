import { Controller, Get, HttpCode, Inject, Logger, NotFoundException, Param, Post, Type, UseGuards } from '@nestjs/common';
import { InternalGuard } from '../auth/internal.guard';
import { JobNamePipe } from '../http/params';
import { JobRunner, JobStatus } from './job-lease';

/** The provider token for a service's JobRunner (see createJobsController). */
export const JOB_RUNNER = Symbol('JOB_RUNNER');

/**
 * `POST /api/v1/jobs/<service>/<job>` starts a job and answers 202 at once, so the
 * gateway's proxy timeout never cuts one; `GET /api/v1/jobs/<service>` lists each
 * job's last run. Reached only through the gateway's `jobs` mode (JOBS_TOKEN),
 * which stamps the internal token this guard checks.
 */
export function createJobsController(service: string): Type<unknown> {
  @Controller(`jobs/${service}`)
  @UseGuards(InternalGuard)
  class JobsController {
    private readonly logger = new Logger(`${service}JobsController`);

    constructor(@Inject(JOB_RUNNER) private readonly runner: JobRunner) {}

    @Post(':job')
    @HttpCode(202)
    async start(@Param('job', new JobNamePipe()) job: string): Promise<{ job: string; started: boolean; reason?: 'running' }> {
      if (!this.runner.has(job)) throw new NotFoundException('Unknown job');
      const start = await this.runner.start(job);
      if (!start.started) return { job, started: false, reason: 'running' };
      this.logger.log(`job ${job} started by the scheduler`);
      void start.finished; // never rejects; the lease row records the result
      return { job, started: true };
    }

    @Get()
    status(): Promise<JobStatus[]> {
      return this.runner.status();
    }
  }
  return JobsController;
}
