import { MigrationInterface, QueryRunner } from 'typeorm';

// P2-14 index tuning (audit Appendix B): drop courses (status).
//
// Built and dropped CONCURRENTLY, which blocks no writes but can't run inside a
// transaction: hence `transaction = false` and one statement per query() call.
// Every statement is safe to repeat, since a failure part-way keeps the earlier
// statements and the whole migration runs again: drops use IF EXISTS, and each
// index is dropped before it's built, so an INVALID index left by a failed
// build is rebuilt rather than skipped. `pnpm migration:revert` passes -t none
// so that down() runs outside a transaction too.
export class IndexTuning1790956071059 implements MigrationInterface {
  name = 'IndexTuning1790956071059';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // courses (status): covered by (status, published_at).
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "course"."IDX_889f2701163f86b2faf62a6247"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "course"."IDX_889f2701163f86b2faf62a6247"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_889f2701163f86b2faf62a6247" ON "course"."courses" ("status")`);
  }
}
