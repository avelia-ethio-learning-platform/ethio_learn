import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import { S3StorageProvider } from '@ethiopialearn/storage';
import { entities, migrations, SCHEMA } from './database';
import { AssessmentService } from './assessment.service';
import { CertificateService } from './certificate.service';
import { OutcomesController } from './controllers';
import { OutcomesInternalController } from './internal.controller';

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions(SCHEMA, entities, migrations)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'outcomes', outbox: true }),
  ],
  controllers: [OutcomesController, OutcomesInternalController, HealthController],
  providers: [AssessmentService, CertificateService, InternalHttpClient, S3StorageProvider],
})
export class AppModule {}
