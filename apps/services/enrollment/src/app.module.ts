import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import { CourseCache, Enrollment, LessonProgress } from './entities';
import { EnrollmentService } from './enrollment.service';
import { EnrollmentController, EnrollmentInternalController } from './enrollment.controller';

const entities = [Enrollment, LessonProgress, CourseCache];

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions('enrollment', entities)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'enrollment' }),
  ],
  controllers: [EnrollmentController, EnrollmentInternalController, HealthController],
  providers: [EnrollmentService, InternalHttpClient],
})
export class AppModule {}
