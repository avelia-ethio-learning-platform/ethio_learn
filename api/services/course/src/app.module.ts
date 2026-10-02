import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import { S3StorageProvider } from '@ethiopialearn/storage';
import { entities, migrations, SCHEMA } from './database';
import { CourseService } from './course.service';
import { CourseExtrasService } from './course-extras.service';
import { CourseController } from './course.controller';
import { CourseInternalController } from './internal.controller';
import { RevisionService } from './revision.service';
import { RevisionController } from './revision.controller';
import { UploadService } from './upload.service';
import { UploadController } from './upload.controller';
import { VideoKeyService } from './video-key.service';

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions(SCHEMA, entities, migrations)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'course' }),
  ],
  controllers: [CourseController, RevisionController, UploadController, CourseInternalController, HealthController],
  providers: [CourseService, CourseExtrasService, RevisionService, UploadService, VideoKeyService, InternalHttpClient, S3StorageProvider],
})
export class AppModule {}
