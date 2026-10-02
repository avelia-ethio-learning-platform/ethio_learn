import { MigrationInterface, QueryRunner } from 'typeorm';

// Exactly-once money effects (P0-04), enforced by the database:
// - one wallet credit or purchase debit per (kind, reference); admin
//   adjustments reuse their reference and stay non-unique;
// - one referral per referred account;
// - at most one open (pending or approved) refund request per payment;
// - and the scan of the cron that re-publishes lost access events (P0-05).
//
// Same rules as IndexTuning: CONCURRENTLY, so `transaction = false` and one
// statement per query(); every statement is safe to repeat. A unique build
// fails if production already holds duplicates (rollout step 1 checks first).
export class PaymentIntegrityIndexes1790966512487 implements MigrationInterface {
  name = 'PaymentIntegrityIndexes1790966512487';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_wallet_transactions_kind_reference"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "IDX_wallet_transactions_kind_reference" ON "financial"."wallet_transactions" ("kind", "reference") WHERE kind IN ('topup', 'cashback', 'referral_reward', 'purchase')`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_referrals_referred_user_id_unique"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "IDX_referrals_referred_user_id_unique" ON "financial"."referrals" ("referred_user_id") WHERE referred_user_id IS NOT NULL`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_refund_requests_open_payment_id"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "IDX_refund_requests_open_payment_id" ON "financial"."refund_requests" ("payment_id") WHERE status IN ('pending', 'approved')`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_payments_effects_pending_webhook_received_at"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_payments_effects_pending_webhook_received_at" ON "financial"."payments" ("webhook_received_at") WHERE status = 'confirmed' AND effects_completed_at IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_payments_effects_pending_webhook_received_at"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_refund_requests_open_payment_id"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_referrals_referred_user_id_unique"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_wallet_transactions_kind_reference"`);
  }
}
