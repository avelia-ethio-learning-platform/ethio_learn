import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 9b: the transactional outbox. Events are inserted in the same
// transaction as the state change they announce, then published after commit
// (common/src/events/outbox.ts). A new, empty table, so building the partial
// index in the same transaction locks nothing in use.
export class Outbox1791054801417 implements MigrationInterface {
  name = 'Outbox1791054801417';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "financial"."outbox" ("id" uuid NOT NULL, "event_type" character varying(64) NOT NULL, "payload" jsonb NOT NULL, "correlation_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(), "published_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT '0', "last_error" character varying(500), CONSTRAINT "PK_340ab539f309f03bdaa14aa7649" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_outbox_unpublished" ON "financial"."outbox" ("created_at") WHERE "published_at" IS NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "financial"."IDX_outbox_unpublished"`);
    await queryRunner.query(`DROP TABLE "financial"."outbox"`);
  }
}
