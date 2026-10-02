import { MigrationInterface, QueryRunner } from 'typeorm';

// P0-05: a confirmed payment whose access-granting event never reached the
// broker must be re-published. `effects_completed_at` is set once the broker
// acknowledged every required event; a cron re-runs the effects of confirmed
// rows where it is still null.
//
// Historical settled payments are marked done so the cron doesn't re-run every
// past sale, except confirmed course payments with no enrollment: those
// learners paid and never got access (P0-05 victims), so they stay null and
// the cron heals them (activation is a no-op for an existing enrollment). That
// is the one deliberate read of another service's schema, and it runs once.
// On a fresh database financial can migrate before enrollment has created its
// table; there are no historical payments then, so the plain backfill is used.
export class PaymentEffects1790966512486 implements MigrationInterface {
  name = 'PaymentEffects1790966512486';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "financial"."payments" ADD "effects_completed_at" TIMESTAMP WITH TIME ZONE`);

    const [{ exists }] = await queryRunner.query(`SELECT to_regclass('enrollment.enrollments') IS NOT NULL AS "exists"`);
    if (!exists) {
      await queryRunner.query(
        `UPDATE "financial"."payments" SET "effects_completed_at" = COALESCE("webhook_received_at", "created_at") WHERE status IN ('confirmed', 'refunded')`,
      );
      return;
    }
    await queryRunner.query(
      `UPDATE "financial"."payments" p SET "effects_completed_at" = COALESCE(p."webhook_received_at", p."created_at")
       WHERE p.status IN ('confirmed', 'refunded')
         AND NOT (
           p.status = 'confirmed'
           AND COALESCE(p.purpose, 'course') = 'course'
           AND NOT EXISTS (SELECT 1 FROM "enrollment"."enrollments" e WHERE e.learner_id = p.learner_id AND e.course_id = p.course_id)
         )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "financial"."payments" DROP COLUMN "effects_completed_at"`);
  }
}
