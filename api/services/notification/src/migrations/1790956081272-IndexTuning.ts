import { MigrationInterface, QueryRunner } from 'typeorm';

// P2-14 index tuning (audit Appendix B): index dm_messages (thread_id,
// created_at); drop dm_threads (a_id).
//
// Built and dropped CONCURRENTLY, which blocks no writes but can't run inside a
// transaction: hence `transaction = false` and one statement per query() call.
// Every statement is safe to repeat, since a failure part-way keeps the earlier
// statements and the whole migration runs again: drops use IF EXISTS, and each
// index is dropped before it's built, so an INVALID index left by a failed
// build is rebuilt rather than skipped. `pnpm migration:revert` passes -t none
// so that down() runs outside a transaction too.
export class IndexTuning1790956081272 implements MigrationInterface {
  name = 'IndexTuning1790956081272';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A thread's messages in order, polled every few seconds.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "notification"."IDX_dm_messages_thread_id_created_at"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_dm_messages_thread_id_created_at" ON "notification"."dm_messages" ("thread_id", "created_at")`);
    // dm_threads (a_id): covered by the (a_id, b_id) unique.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "notification"."IDX_ed9c016a6c1cedddb9ac75fdfe"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "notification"."IDX_ed9c016a6c1cedddb9ac75fdfe"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_ed9c016a6c1cedddb9ac75fdfe" ON "notification"."dm_threads" ("a_id")`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "notification"."IDX_dm_messages_thread_id_created_at"`);
  }
}
