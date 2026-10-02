import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import { entities, migrations, SCHEMA } from './database';
import { EnrollmentService } from './enrollment.service';
import { EnrollmentController, EnrollmentInternalController } from './enrollment.controller';

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions(SCHEMA, entities, migrations)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'enrollment' }),
    ScheduleModule.forRoot(),
  ],
  controllers: [EnrollmentController, EnrollmentInternalController, HealthController],
  providers: [EnrollmentService, InternalHttpClient],
})
export class AppModule {}
