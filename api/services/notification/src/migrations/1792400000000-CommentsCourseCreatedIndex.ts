import { MigrationInterface, QueryRunner } from 'typeorm';

// Index course_comments (course_id, created_at) for a course page's newest-50
// discussions, which a load check showed as a sequential scan; drop the
// single-column course_id index its prefix covers.
//
// Built and dropped CONCURRENTLY, which blocks no writes but can't run inside a
// transaction: hence `transaction = false` and one statement per query() call.
// Every statement is safe to repeat: drops use IF EXISTS, and each index is
// dropped before it's built, so an INVALID index left by a failed build is
// rebuilt rather than skipped. `pnpm migration:revert` passes -t none so that
// down() runs outside a transaction too.
export class CommentsCourseCreatedIndex1792400000000 implements MigrationInterface {
  name = 'CommentsCourseCreatedIndex1792400000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "notification"."IDX_course_comments_course_id_created_at"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_course_comments_course_id_created_at" ON "notification"."course_comments" ("course_id", "created_at")`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "notification"."IDX_2fe6d118a6e60842d38b1e5fe1"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "notification"."IDX_2fe6d118a6e60842d38b1e5fe1"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_2fe6d118a6e60842d38b1e5fe1" ON "notification"."course_comments" ("course_id")`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "notification"."IDX_course_comments_course_id_created_at"`);
  }
}
