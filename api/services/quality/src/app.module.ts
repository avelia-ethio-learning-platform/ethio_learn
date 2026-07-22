import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import {
  CourseReview,
  EducatorTrustTier,
  FraudSignal,
  PayeeStats,
  QaReviewItem,
  QualityCourseCache,
  RefundLog,
} from './entities';
import { QualityService } from './quality.service';
import { QualityController, QualityInternalController } from './controllers';

const entities = [QaReviewItem, CourseReview, FraudSignal, EducatorTrustTier, QualityCourseCache, PayeeStats, RefundLog];

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions('quality', entities)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'quality' }),
  ],
  controllers: [QualityController, QualityInternalController, HealthController],
  providers: [QualityService, InternalHttpClient],
})
export class AppModule {}
