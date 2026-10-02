import { MigrationInterface, QueryRunner } from 'typeorm';

// Institution membership lifecycle (P0-03): invited → active on the user's own
// acceptance; suspended, removed or declined later. Existing rows are live
// affiliations, so they're backfilled as active and accepted; the default for
// new rows is invited. The unique indexes come in the next migration, built
// concurrently, so a failed build can't leave these columns half-applied.
export class MembershipStatus1790964028395 implements MigrationInterface {
  name = 'MembershipStatus1790964028395';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" ADD "status" character varying(16) NOT NULL DEFAULT 'active'`);
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" ADD "status_reason" character varying(500)`);
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" ADD "invited_by" uuid`);
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" ADD "accepted_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`UPDATE "auth"."institution_instructors" SET "accepted_at" = "created_at"`);
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" ALTER COLUMN "status" SET DEFAULT 'invited'`);
    await queryRunner.query(
      `ALTER TABLE "auth"."institution_instructors" ADD CONSTRAINT "CHK_institution_instructors_status" CHECK (status IN ('invited', 'active', 'suspended', 'removed', 'declined'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" DROP CONSTRAINT "CHK_institution_instructors_status"`);
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" DROP COLUMN "accepted_at"`);
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" DROP COLUMN "created_at"`);
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" DROP COLUMN "invited_by"`);
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" DROP COLUMN "status_reason"`);
    await queryRunner.query(`ALTER TABLE "auth"."institution_instructors" DROP COLUMN "status"`);
  }
}
