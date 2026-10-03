import { EducatorProfile, EmailVerification, Institution, InstitutionInstructor, PasswordReset, User } from './entities';
import { AuditLog } from './audit';
import { migrations } from './migrations';
import { OutboxEvent } from '@ethiopialearn/common';

/**
 * Everything that defines the auth schema, shared by the app module, the
 * TypeORM CLI data source (src/data-source.ts) and `pnpm -C api db:check`.
 */
export const SCHEMA = 'auth';
export const entities = [User, EmailVerification, PasswordReset, EducatorProfile, Institution, InstitutionInstructor, AuditLog, OutboxEvent];
export { migrations };
