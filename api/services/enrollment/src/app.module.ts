import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, createJobsController, EventBusModule, HealthController, InternalHttpClient, JOB_RUNNER } from '@ethiopialearn/common';
import { entities, migrations, SCHEMA } from './database';
import { EnrollmentJobs } from './jobs';
import { EnrollmentService } from './enrollment.service';
import { EnrollmentController, EnrollmentInternalController } from './enrollment.controller';

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions(SCHEMA, entities, migrations)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'enrollment', outbox: true }),
    ScheduleModule.forRoot(),
  ],
  controllers: [EnrollmentController, EnrollmentInternalController, HealthController, createJobsController('enrollment')],
  providers: [
    EnrollmentService,
    InternalHttpClient,
    EnrollmentJobs,
    { provide: JOB_RUNNER, useFactory: (jobs: EnrollmentJobs) => jobs.runner, inject: [EnrollmentJobs] },
  ],
})
export class AppModule {}
