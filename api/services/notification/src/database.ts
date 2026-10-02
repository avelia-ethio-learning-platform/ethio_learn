import { CourseComment, DmMessage, DmThread, InboxNotification, NotificationLog, NotificationPreference } from './entities';
import { migrations } from './migrations';

/**
 * Everything that defines the notification schema, shared by the app module, the
 * TypeORM CLI data source (src/data-source.ts) and `pnpm -C api db:check`.
 */
export const SCHEMA = 'notification';
export const entities = [NotificationLog, NotificationPreference, InboxNotification, CourseComment, DmThread, DmMessage];
export { migrations };
