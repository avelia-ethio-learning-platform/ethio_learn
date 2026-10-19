import { MigrationInterface, QueryRunner } from 'typeorm';

// One live seat per email on a bulk purchase and one invite per (referrer, email)
// (Phase 9c step 9, P2-03): the backstops behind assignSeats' order lock and the
// invite's ON CONFLICT DO NOTHING.
//
// Same rules as IndexTuning: CONCURRENTLY, so `transaction = false` and one
// statement per query(); every statement is safe to repeat. A build fails if
// production already holds duplicates and leaves an INVALID index, which the
// rerun drops first (plan.md Rollout lists the duplicate checks).
export class UniqueSeatsAndInvites1791100000001 implements MigrationInterface {
  name = 'UniqueSeatsAndInvites1791100000001';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_sponsorships_bulk_purchase_id_recipient_email_unique"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "IDX_sponsorships_bulk_purchase_id_recipient_email_unique" ON "financial"."sponsorships" ("bulk_purchase_id", "recipient_email") WHERE bulk_purchase_id IS NOT NULL AND status <> 'cancelled'`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_referrals_referrer_id_referred_email_unique"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "IDX_referrals_referrer_id_referred_email_unique" ON "financial"."referrals" ("referrer_id", "referred_email") WHERE referred_email <> ''`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_referrals_referrer_id_referred_email_unique"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "financial"."IDX_sponsorships_bulk_purchase_id_recipient_email_unique"`);
  }
}
