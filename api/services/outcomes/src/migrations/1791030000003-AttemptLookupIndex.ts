import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 6b: index assessment_attempts (assessment_id, learner_id, submitted_at)
// for the per-learner attempt count and cooldown lookups; drop the single-column
// assessment_id index its prefix covers. The learner_id index stays.
//
// Built and dropped CONCURRENTLY, which blocks no writes but can't run inside a
// transaction: hence `transaction = false` and one statement per query() call.
// Every statement is safe to repeat, since a failure part-way keeps the earlier
// statements and the whole migration runs again: drops use IF EXISTS, and each
// index is dropped before it's built, so an INVALID index left by a failed
// build is rebuilt rather than skipped. `pnpm migration:revert` passes -t none
// so that down() runs outside a transaction too.
export class AttemptLookupIndex1791030000003 implements MigrationInterface {
  name = 'AttemptLookupIndex1791030000003';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "outcomes"."IDX_assessment_attempts_lookup"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_assessment_attempts_lookup" ON "outcomes"."assessment_attempts" ("assessment_id", "learner_id", "submitted_at")`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "outcomes"."IDX_a6580a164dbc7b3232c8a2f063"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "outcomes"."IDX_a6580a164dbc7b3232c8a2f063"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_a6580a164dbc7b3232c8a2f063" ON "outcomes"."assessment_attempts" ("assessment_id")`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "outcomes"."IDX_assessment_attempts_lookup"`);
  }
}
