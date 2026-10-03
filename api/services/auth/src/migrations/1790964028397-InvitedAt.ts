import { MigrationInterface, QueryRunner } from 'typeorm';

// When an institution last invited this user (Phase 6a invite cap). Existing
// rows were invited when created, so they're backfilled from created_at; new
// rows default to now(). addInstructor sets it again on every re-invite.
export class InvitedAt1790964028397 implements MigrationInterface {
  name = 'InvitedAt1790964028397';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" ADD "invited_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`UPDATE "auth"."institution_instructors" SET "invited_at" = "created_at"`);
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" ALTER COLUMN "invited_at" SET DEFAULT now()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" DROP COLUMN "invited_at"`);
  }
}
