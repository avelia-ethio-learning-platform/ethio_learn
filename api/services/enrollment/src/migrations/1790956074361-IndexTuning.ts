import { MigrationInterface, QueryRunner } from 'typeorm';

// P2-14 index tuning (audit Appendix B): index video_progress (lesson_id); drop
// three single-column indexes their unique constraints cover.
//
// Built and dropped CONCURRENTLY, which blocks no writes but can't run inside a
// transaction: hence `transaction = false` and one statement per query() call.
// Every statement is safe to repeat, since a failure part-way keeps the earlier
// statements and the whole migration runs again: drops use IF EXISTS, and each
// index is dropped before it's built, so an INVALID index left by a failed
// build is rebuilt rather than skipped. `pnpm migration:revert` passes -t none
// so that down() runs outside a transaction too.
export class IndexTuning1790956074361 implements MigrationInterface {
  name = 'IndexTuning1790956074361';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // For the revision reset, which updates every learner's row for a lesson.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "enrollment"."IDX_video_progress_lesson_id"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_video_progress_lesson_id" ON "enrollment"."video_progress" ("lesson_id")`);
    // enrollments (learner_id): covered by the (learner_id, course_id) unique.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "enrollment"."IDX_bb53c1a95eb92bf25d7c632058"`);
    // lesson_progress (enrollment_id): covered by the (enrollment_id, lesson_id) unique.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "enrollment"."IDX_2374c15822383f7e5362e27d41"`);
    // video_progress (enrollment_id): covered by the (enrollment_id, lesson_id) unique.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "enrollment"."IDX_92d69a37eefba833cfc1dc39c7"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "enrollment"."IDX_bb53c1a95eb92bf25d7c632058"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_bb53c1a95eb92bf25d7c632058" ON "enrollment"."enrollments" ("learner_id")`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "enrollment"."IDX_2374c15822383f7e5362e27d41"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_2374c15822383f7e5362e27d41" ON "enrollment"."lesson_progress" ("enrollment_id")`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "enrollment"."IDX_92d69a37eefba833cfc1dc39c7"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_92d69a37eefba833cfc1dc39c7" ON "enrollment"."video_progress" ("enrollment_id")`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "enrollment"."IDX_video_progress_lesson_id"`);
  }
}
