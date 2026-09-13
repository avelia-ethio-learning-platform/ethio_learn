import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import { S3StorageProvider } from '@ethiopialearn/storage';
import { Course, CourseChangeLog, CourseChatMessage, CourseKnowledge, Lesson, Section } from './entities';
import { CourseService } from './course.service';
import { CourseExtrasService } from './course-extras.service';
import { CourseController } from './course.controller';
import { CourseInternalController } from './internal.controller';

const entities = [Course, Section, Lesson, CourseChangeLog, CourseKnowledge, CourseChatMessage];

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions('course', entities)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'course' }),
  ],
  controllers: [CourseController, CourseInternalController, HealthController],
  providers: [CourseService, CourseExtrasService, InternalHttpClient, S3StorageProvider],
})
export class AppModule {}
