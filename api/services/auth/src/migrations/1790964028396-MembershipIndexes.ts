import { MigrationInterface, QueryRunner } from 'typeorm';

// One membership row per (institution, user), and at most one active
// membership per user (the institution new courses route to). The first
// unique index makes the old single-column institution_id index redundant.
//
// Same rules as IndexTuning: CONCURRENTLY, so `transaction = false` and one
// statement per query(); every statement is safe to repeat. A build fails if
// production already holds duplicates (rollout step 1 checks first).
export class MembershipIndexes1790964028396 implements MigrationInterface {
  name = 'MembershipIndexes1790964028396';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "auth"."IDX_institution_instructors_institution_id_user_id"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "IDX_institution_instructors_institution_id_user_id" ON "auth"."institution_instructors" ("institution_id", "user_id")`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "auth"."IDX_institution_instructors_active_user_id"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "IDX_institution_instructors_active_user_id" ON "auth"."institution_instructors" ("user_id") WHERE status = 'active'`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "auth"."IDX_4ed97bb1119f0ab8da94fee59e"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "auth"."IDX_4ed97bb1119f0ab8da94fee59e"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_4ed97bb1119f0ab8da94fee59e" ON "auth"."institution_instructors" ("institution_id")`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "auth"."IDX_institution_instructors_active_user_id"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "auth"."IDX_institution_instructors_institution_id_user_id"`);
  }
}
