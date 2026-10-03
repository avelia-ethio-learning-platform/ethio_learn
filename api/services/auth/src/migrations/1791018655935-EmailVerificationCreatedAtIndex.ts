import { MigrationInterface, QueryRunner } from 'typeorm';

// Serves the resend caps: one account's verification links since a cutoff.
//
// Same rules as IndexTuning: CONCURRENTLY, so `transaction = false` and one
// statement per query(); every statement is safe to repeat.
export class EmailVerificationCreatedAtIndex1791018655935 implements MigrationInterface {
  name = 'EmailVerificationCreatedAtIndex1791018655935';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "auth"."IDX_email_verifications_user_id_created_at"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_email_verifications_user_id_created_at" ON "auth"."email_verifications" ("user_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "auth"."IDX_email_verifications_user_id_created_at"`);
  }
}
