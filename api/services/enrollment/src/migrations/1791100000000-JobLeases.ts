import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 9c: job leases (decision 5) for the inactivity job. A new, empty table.
export class JobLeases1791100000000 implements MigrationInterface {
  name = 'JobLeases1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "enrollment"."job_leases" ("name" character varying(64) NOT NULL, "locked_until" TIMESTAMP WITH TIME ZONE, "holder" character varying(64), "last_started_at" TIMESTAMP WITH TIME ZONE, "last_finished_at" TIMESTAMP WITH TIME ZONE, "last_result" jsonb, CONSTRAINT "PK_a5aaa7b6169ce751dd85a6f0beb" PRIMARY KEY ("name"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "enrollment"."job_leases"`);
  }
}
