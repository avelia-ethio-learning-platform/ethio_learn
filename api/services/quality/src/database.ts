import {
  CourseReview,
  EducatorTrustTier,
  FraudSignal,
  PayeeStats,
  QaReviewItem,
  QualityCourseCache,
  RefundLog,
} from './entities';
import { ProcessedEvent } from '@ethiopialearn/common';
import { migrations } from './migrations';

/**
 * Everything that defines the quality schema, shared by the app module, the
 * TypeORM CLI data source (src/data-source.ts) and `pnpm -C api db:check`.
 */
export const SCHEMA = 'quality';
export const entities = [QaReviewItem, CourseReview, FraudSignal, EducatorTrustTier, QualityCourseCache, PayeeStats, RefundLog, ProcessedEvent];
export { migrations };
