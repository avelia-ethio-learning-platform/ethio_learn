import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 13a: a role row (target_role set, shared by everyone with that role) is
// read per person. One row per (notification, reader); the shared read_at stays
// for user rows. Role rows already marked read keep that mark for everyone.
// Additive and small, so it runs in the default transaction.
export class InboxReads1792355000565 implements MigrationInterface {
  name = 'InboxReads1792355000565';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification"."inbox_notification_reads" (
        "notification_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "read_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ecf037d586a75f641c4d40f3da9" PRIMARY KEY ("notification_id", "user_id"),
        CONSTRAINT "FK_18915d776f31d866cfaf6176b7c" FOREIGN KEY ("notification_id") REFERENCES "notification"."inbox_notifications"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification"."inbox_notification_reads"`);
  }
}
