import { Assessment, AssessmentAttempt, Certificate, EducatorTierCache } from './entities';
import { migrations } from './migrations';
import { OutboxEvent } from '@ethiopialearn/common';

/**
 * Everything that defines the outcomes schema, shared by the app module, the
 * TypeORM CLI data source (src/data-source.ts) and `pnpm -C api db:check`.
 */
export const SCHEMA = 'outcomes';
export const entities = [Assessment, AssessmentAttempt, Certificate, EducatorTierCache, OutboxEvent];
export { migrations };
