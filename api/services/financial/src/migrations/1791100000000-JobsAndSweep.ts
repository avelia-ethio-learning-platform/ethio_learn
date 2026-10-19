import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 9c: job leases (decision 5) and the sweep's turn order (decision 8).
// A new, empty table, and two metadata-only ADD COLUMNs (a nullable column, and
// a NOT NULL one with a constant default, which PG 11+ stores without a rewrite).
export class JobsAndSweep1791100000000 implements MigrationInterface {
  name = 'JobsAndSweep1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "financial"."job_leases" ("name" character varying(64) NOT NULL, "locked_until" TIMESTAMP WITH TIME ZONE, "holder" character varying(64), "last_started_at" TIMESTAMP WITH TIME ZONE, "last_finished_at" TIMESTAMP WITH TIME ZONE, "last_result" jsonb, CONSTRAINT "PK_a5aaa7b6169ce751dd85a6f0beb" PRIMARY KEY ("name"))`,
    );
    await queryRunner.query(`ALTER TABLE "financial"."payments" ADD "verify_checked_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "financial"."payments" ADD "verify_attempts" integer NOT NULL DEFAULT '0'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "financial"."payments" DROP COLUMN "verify_attempts"`);
    await queryRunner.query(`ALTER TABLE "financial"."payments" DROP COLUMN "verify_checked_at"`);
    await queryRunner.query(`DROP TABLE "financial"."job_leases"`);
  }
}
