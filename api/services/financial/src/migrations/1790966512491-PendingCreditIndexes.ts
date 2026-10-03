import { MigrationInterface, QueryRunner } from 'typeorm';

// Indexes for pending wallet credits (Phase 6c):
// - (user_id, available_at) over pending rows, for the release sweep;
// - (payment_id) over rows that carry a payment, for voiding a refunded
//   purchase's credits.
// The open-refund unique index already serves the refund lookups, so
// refund_requests gets nothing new.
//
// Same rules as CapIndexes: CONCURRENTLY, so `transaction = false` and one
// statement per query(); every statement is safe to repeat. No unique index,
// so no duplicate check is needed before rollout.
export class PendingCreditIndexes1790966512491 implements MigrationInterface {
  name = 'PendingCreditIndexes1790966512491';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_wallet_transactions_pending_user_id_available_at"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_wallet_transactions_pending_user_id_available_at" ON "financial"."wallet_transactions" ("user_id", "available_at") WHERE state = 'pending'`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_wallet_transactions_payment_id"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_wallet_transactions_payment_id" ON "financial"."wallet_transactions" ("payment_id") WHERE payment_id IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_wallet_transactions_payment_id"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_wallet_transactions_pending_user_id_available_at"`);
  }
}
