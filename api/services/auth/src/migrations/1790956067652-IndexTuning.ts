import { MigrationInterface, QueryRunner } from 'typeorm';

// P2-14 index tuning (audit Appendix B): drop the second unique index on
// educator_profiles.user_id.
//
// Built and dropped CONCURRENTLY, which blocks no writes but can't run inside a
// transaction: hence `transaction = false` and one statement per query() call.
// Every statement is safe to repeat, since a failure part-way keeps the earlier
// statements and the whole migration runs again: drops use IF EXISTS, and each
// index is dropped before it's built, so an INVALID index left by a failed
// build is rebuilt rather than skipped. `pnpm migration:revert` passes -t none
// so that down() runs outside a transaction too.
export class IndexTuning1790956067652 implements MigrationInterface {
  name = 'IndexTuning1790956067652';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Duplicate of the @OneToOne constraint REL_2080c94891f76ce625e19874b6.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "auth"."IDX_2080c94891f76ce625e19874b6"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "auth"."IDX_2080c94891f76ce625e19874b6"`);
    await queryRunner.query(`CREATE UNIQUE INDEX CONCURRENTLY "IDX_2080c94891f76ce625e19874b6" ON "auth"."educator_profiles" ("user_id")`);
  }
}
