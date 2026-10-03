import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 9a: a redelivered event writes no second inbox row and sends no second
// email. Each row records the event that wrote it, and two partial indexes key
// the dedupe on it. Older rows keep a null event id and are left alone.
//
// The unique inbox index is NULLS NOT DISTINCT (Postgres 15+), so a role row
// (user_id null) dedupes too. TypeORM can't express that, so the entity
// declares the same index by name without it.
//
// The indexes are built and dropped CONCURRENTLY, which blocks no writes but
// can't run inside a transaction: hence `transaction = false`. Every statement
// is safe to repeat after a failure part-way: the columns use IF NOT EXISTS,
// and each index is dropped before it's built, so an INVALID index left by a
// failed build is rebuilt.
export class EventDedupe1791050068634 implements MigrationInterface {
  name = 'EventDedupe1791050068634';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notification"."notification_log" ADD COLUMN IF NOT EXISTS "event_id" uuid`);
    await queryRunner.query(`ALTER TABLE "notification"."inbox_notifications" ADD COLUMN IF NOT EXISTS "source_event_id" uuid`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "notification"."IDX_notification_log_sent_event"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_notification_log_sent_event" ON "notification"."notification_log" ("event_id", "recipient", "event_type") WHERE "status" = 'sent'`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "notification"."UQ_inbox_notifications_source_event"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "UQ_inbox_notifications_source_event" ON "notification"."inbox_notifications" ("source_event_id", "user_id", "target_role", "type") NULLS NOT DISTINCT WHERE "source_event_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "notification"."UQ_inbox_notifications_source_event"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "notification"."IDX_notification_log_sent_event"`);
    await queryRunner.query(`ALTER TABLE "notification"."inbox_notifications" DROP COLUMN IF EXISTS "source_event_id"`);
    await queryRunner.query(`ALTER TABLE "notification"."notification_log" DROP COLUMN IF EXISTS "event_id"`);
  }
}
