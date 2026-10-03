import { MigrationInterface, QueryRunner } from 'typeorm';

// Per-user coupon limit (Phase 6a): how many times one learner may use a
// coupon, counting pending holds as well as confirmed payments. Null keeps the
// old behaviour (no per-user limit), so existing coupons are unchanged.
export class CouponPerUserLimit1790966512488 implements MigrationInterface {
  name = 'CouponPerUserLimit1790966512488';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "financial"."coupons" ADD "max_uses_per_user" integer`);
    await queryRunner.query(
      `ALTER TABLE "financial"."coupons" ADD CONSTRAINT "CHK_coupons_max_uses_per_user" CHECK (max_uses_per_user IS NULL OR max_uses_per_user > 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "financial"."coupons" DROP CONSTRAINT "CHK_coupons_max_uses_per_user"`);
    await queryRunner.query(`ALTER TABLE "financial"."coupons" DROP COLUMN "max_uses_per_user"`);
  }
}
