import { MigrationInterface, QueryRunner } from 'typeorm';

// P2-14 index tuning (audit Appendix B): index certificates (learner_id).
//
// Built and dropped CONCURRENTLY, which blocks no writes but can't run inside a
// transaction: hence `transaction = false` and one statement per query() call.
// Every statement is safe to repeat, since a failure part-way keeps the earlier
// statements and the whole migration runs again: drops use IF EXISTS, and each
// index is dropped before it's built, so an INVALID index left by a failed
// build is rebuilt rather than skipped. `pnpm migration:revert` passes -t none
// so that down() runs outside a transaction too.
export class IndexTuning1790956084676 implements MigrationInterface {
  name = 'IndexTuning1790956084676';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A learner's certificates.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "outcomes"."IDX_certificates_learner_id"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_certificates_learner_id" ON "outcomes"."certificates" ("learner_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "outcomes"."IDX_certificates_learner_id"`);
  }
}
