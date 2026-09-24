import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import { S3StorageProvider } from '@ethiopialearn/storage';
import { Course, CourseChangeLog, CourseChatMessage, CourseKnowledge, CourseRevision, Lesson, Section } from './entities';
import { UploadSession } from './upload-session.entity';
import { CourseService } from './course.service';
import { CourseExtrasService } from './course-extras.service';
import { CourseController } from './course.controller';
import { CourseInternalController } from './internal.controller';
import { RevisionService } from './revision.service';
import { RevisionController } from './revision.controller';
import { UploadService } from './upload.service';
import { UploadController } from './upload.controller';
import { VideoKeyService } from './video-key.service';

const entities = [Course, Section, Lesson, CourseChangeLog, CourseKnowledge, CourseChatMessage, CourseRevision, UploadSession];

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions('course', entities)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'course' }),
  ],
  controllers: [CourseController, RevisionController, UploadController, CourseInternalController, HealthController],
  providers: [CourseService, CourseExtrasService, RevisionService, UploadService, VideoKeyService, InternalHttpClient, S3StorageProvider],
})
export class AppModule {}
