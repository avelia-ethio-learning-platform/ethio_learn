import { MigrationInterface, QueryRunner } from 'typeorm';

// When each verification link was issued (Phase 7b resend caps: 1 per 60 s and
// 5 per 24 h per account, counted from these rows). A constant default, so no
// table rewrite on PG 11+; existing rows get the migration time, which only
// makes them count toward the 24 h cap for one day.
export class EmailVerificationCreatedAt1791018655934 implements MigrationInterface {
  name = 'EmailVerificationCreatedAt1791018655934';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "auth"."email_verifications" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "auth"."email_verifications" DROP COLUMN "created_at"`);
  }
}
