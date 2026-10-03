import { MigrationInterface, QueryRunner } from 'typeorm';

// Money integrity II (Phase 6c):
// - wallet_transactions gets a state ('available' | 'pending' | 'void'), the
//   time a pending credit becomes spendable, and the purchase that earned it.
//   The constant default is metadata-only, so there is no table rewrite, and
//   every existing row stays 'available': credits already in balances are not
//   reclassified.
// - payments gets refund_requested_at, the mark a refund request leaves so the
//   payout claim can skip the payment. Open (pending) refund requests are
//   backfilled from their creation time.
export class PendingCreditsRefundMark1790966512490 implements MigrationInterface {
  name = 'PendingCreditsRefundMark1790966512490';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "financial"."wallet_transactions" ADD "state" character varying(16) NOT NULL DEFAULT 'available'`);
    await queryRunner.query(
      `ALTER TABLE "financial"."wallet_transactions" ADD CONSTRAINT "CHK_wallet_transactions_state" CHECK (state IN ('available', 'pending', 'void'))`,
    );
    await queryRunner.query(`ALTER TABLE "financial"."wallet_transactions" ADD "available_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "financial"."wallet_transactions" ADD "payment_id" uuid`);
    await queryRunner.query(`ALTER TABLE "financial"."payments" ADD "refund_requested_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `UPDATE "financial"."payments" p SET refund_requested_at = r.created_at FROM "financial"."refund_requests" r WHERE r.payment_id = p.id AND r.status = 'pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "financial"."payments" DROP COLUMN "refund_requested_at"`);
    await queryRunner.query(`ALTER TABLE "financial"."wallet_transactions" DROP COLUMN "payment_id"`);
    await queryRunner.query(`ALTER TABLE "financial"."wallet_transactions" DROP COLUMN "available_at"`);
    await queryRunner.query(`ALTER TABLE "financial"."wallet_transactions" DROP CONSTRAINT "CHK_wallet_transactions_state"`);
    await queryRunner.query(`ALTER TABLE "financial"."wallet_transactions" DROP COLUMN "state"`);
  }
}
