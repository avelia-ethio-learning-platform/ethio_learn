import { MigrationInterface, QueryRunner } from 'typeorm';

// P2-14 index tuning (audit Appendix B): drop course_reviews (course_id).
//
// Built and dropped CONCURRENTLY, which blocks no writes but can't run inside a
// transaction: hence `transaction = false` and one statement per query() call.
// Every statement is safe to repeat, since a failure part-way keeps the earlier
// statements and the whole migration runs again: drops use IF EXISTS, and each
// index is dropped before it's built, so an INVALID index left by a failed
// build is rebuilt rather than skipped. `pnpm migration:revert` passes -t none
// so that down() runs outside a transaction too.
export class IndexTuning1790956088164 implements MigrationInterface {
  name = 'IndexTuning1790956088164';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // course_reviews (course_id): covered by the (course_id, learner_id) unique.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "quality"."IDX_1f69fdcbd7ea5f0e52c3230c00"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "quality"."IDX_1f69fdcbd7ea5f0e52c3230c00"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_1f69fdcbd7ea5f0e52c3230c00" ON "quality"."course_reviews" ("course_id")`);
  }
}
