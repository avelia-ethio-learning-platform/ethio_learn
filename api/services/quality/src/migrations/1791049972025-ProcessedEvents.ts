import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 9a: the dedupe markers of runOnce, so a redelivered event doesn't repeat
// a handler's effect. One row per (handler, event); runOnce prunes rows older
// than 30 days on its own.
export class ProcessedEvents1791049972025 implements MigrationInterface {
  name = 'ProcessedEvents1791049972025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "quality"."processed_events" ("consumer" character varying(120) NOT NULL, "event_id" uuid NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "result" jsonb, CONSTRAINT "PK_270df9e0013dff41bb91d555db4" PRIMARY KEY ("consumer", "event_id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "quality"."processed_events"`);
  }
}
