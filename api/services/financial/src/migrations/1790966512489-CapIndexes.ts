import { MigrationInterface, QueryRunner } from 'typeorm';

// Indexes for the daily caps and the coupon hold counts (Phase 6a):
// - payments per coupon code, for holds and per-user counts;
// - referrals per referrer and per invited email;
// - sponsorships per sponsor (gifts), per requester (pay requests, where the
//   requester is recipient_user_id and sponsor_id is null) and per payer email
//   (pay requests, kept in organization_name).
// Emails are lowercased on write, so plain columns serve; a lower() expression
// index would show up as db:check drift.
//
// Same rules as IndexTuning: CONCURRENTLY, so `transaction = false` and one
// statement per query(); every statement is safe to repeat. No unique index,
// so no duplicate check is needed before rollout.
export class CapIndexes1790966512489 implements MigrationInterface {
  name = 'CapIndexes1790966512489';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_payments_coupon_code_created_at"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_payments_coupon_code_created_at" ON "financial"."payments" ("coupon_code", "created_at") WHERE coupon_code IS NOT NULL AND status IN ('pending', 'confirmed')`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_referrals_referrer_id_created_at"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_referrals_referrer_id_created_at" ON "financial"."referrals" ("referrer_id", "created_at")`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_referrals_referred_email_created_at"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_referrals_referred_email_created_at" ON "financial"."referrals" ("referred_email", "created_at")`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_sponsorships_source_sponsor_id_created_at"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_sponsorships_source_sponsor_id_created_at" ON "financial"."sponsorships" ("source", "sponsor_id", "created_at")`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_sponsorships_source_recipient_user_id_created_at"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_sponsorships_source_recipient_user_id_created_at" ON "financial"."sponsorships" ("source", "recipient_user_id", "created_at")`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_sponsorships_pay_request_organization_name_created_at"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_sponsorships_pay_request_organization_name_created_at" ON "financial"."sponsorships" ("organization_name", "created_at") WHERE source = 'pay_request'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_sponsorships_pay_request_organization_name_created_at"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_sponsorships_source_recipient_user_id_created_at"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_sponsorships_source_sponsor_id_created_at"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_referrals_referred_email_created_at"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_referrals_referrer_id_created_at"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_payments_coupon_code_created_at"`);
  }
}
