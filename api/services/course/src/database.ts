import { Course, CourseChangeLog, CourseChatMessage, CourseKnowledge, CourseRevision, Lesson, Section } from './entities';
import { UploadSession } from './upload-session.entity';
import { OutboxEvent, ProcessedEvent } from '@ethiopialearn/common';
import { migrations } from './migrations';

/**
 * Everything that defines the course schema, shared by the app module, the
 * TypeORM CLI data source (src/data-source.ts) and `pnpm -C api db:check`.
 */
export const SCHEMA = 'course';
export const entities = [Course, Section, Lesson, CourseChangeLog, CourseKnowledge, CourseChatMessage, CourseRevision, UploadSession, ProcessedEvent, OutboxEvent];
export { migrations };
