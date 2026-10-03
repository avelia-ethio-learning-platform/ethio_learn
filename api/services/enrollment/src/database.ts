import { CourseCache, Enrollment, LessonProgress, VideoProgress } from './entities';
import { migrations } from './migrations';
import { OutboxEvent } from '@ethiopialearn/common';

/**
 * Everything that defines the enrollment schema, shared by the app module, the
 * TypeORM CLI data source (src/data-source.ts) and `pnpm -C api db:check`.
 */
export const SCHEMA = 'enrollment';
export const entities = [Enrollment, LessonProgress, CourseCache, VideoProgress, OutboxEvent];
export { migrations };
