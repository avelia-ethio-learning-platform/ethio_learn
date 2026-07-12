import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import { S3StorageProvider } from '@ethiopialearn/storage';
import { Assessment, AssessmentAttempt, Certificate, EducatorTierCache } from './entities';
import { AssessmentService } from './assessment.service';
import { CertificateService } from './certificate.service';
import { OutcomesController } from './controllers';
import { OutcomesInternalController } from './internal.controller';

const entities = [Assessment, AssessmentAttempt, Certificate, EducatorTierCache];

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions('outcomes', entities)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'outcomes' }),
  ],
  controllers: [OutcomesController, OutcomesInternalController, HealthController],
  providers: [AssessmentService, CertificateService, InternalHttpClient, S3StorageProvider],
})
export class AppModule {}
