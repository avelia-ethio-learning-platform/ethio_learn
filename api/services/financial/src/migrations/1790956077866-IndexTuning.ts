import { MigrationInterface, QueryRunner } from 'typeorm';

// P2-14 index tuning (audit Appendix B): partial indexes for the pending-Chapa
// sweep and the payout run, and sponsorships (bulk_purchase_id).
//
// Built and dropped CONCURRENTLY, which blocks no writes but can't run inside a
// transaction: hence `transaction = false` and one statement per query() call.
// Every statement is safe to repeat, since a failure part-way keeps the earlier
// statements and the whole migration runs again: drops use IF EXISTS, and each
// index is dropped before it's built, so an INVALID index left by a failed
// build is rebuilt rather than skipped. `pnpm migration:revert` passes -t none
// so that down() runs outside a transaction too.
export class IndexTuning1790956077866 implements MigrationInterface {
  name = 'IndexTuning1790956077866';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pending-Chapa sweep and payment nudges.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_payments_pending_chapa_created_at"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_payments_pending_chapa_created_at" ON "financial"."payments" ("created_at") WHERE status = 'pending' AND method = 'chapa'`);
    // Payout run and payee balance.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_payments_confirmed_unpaid_payee_id"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_payments_confirmed_unpaid_payee_id" ON "financial"."payments" ("payee_id") WHERE status = 'confirmed' AND payout_id IS NULL`);
    // Seats of a bulk purchase.
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_sponsorships_bulk_purchase_id"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_sponsorships_bulk_purchase_id" ON "financial"."sponsorships" ("bulk_purchase_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_payments_pending_chapa_created_at"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_payments_confirmed_unpaid_payee_id"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_sponsorships_bulk_purchase_id"`);
  }
}
