import { MigrationInterface, QueryRunner } from 'typeorm';
import { assertBaselineRevertAllowed, baselineState } from '@ethiopialearn/common';

// Generated from the entities against an empty database, then hand-edited:
// the guard below.
// Databases built by `synchronize` (production included) already have every
// table: there the baseline records itself and runs no DDL.
const TABLES = ['users', 'email_verifications', 'password_resets', 'educator_profiles', 'institutions', 'institution_instructors', 'audit_log'];

export class Baseline1790955680203 implements MigrationInterface {
  name = 'Baseline1790955680203';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if ((await baselineState(queryRunner, 'auth', TABLES)) === 'present') return;
    await queryRunner.query(`
      CREATE TYPE "auth"."user_role" AS ENUM(
          'learner',
          'educator',
          'institution_admin',
          'quality_officer',
          'platform_admin'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "auth"."user_status" AS ENUM('active', 'suspended', 'banned')
    `);
    await queryRunner.query(`
      CREATE TABLE "auth"."users" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "role" "auth"."user_role" NOT NULL,
          "name" character varying NOT NULL,
          "email" character varying NOT NULL,
          "password_hash" character varying,
          "google_id" character varying,
          "avatar_url" character varying,
          "email_verified_at" TIMESTAMP WITH TIME ZONE,
          "phone" character varying,
          "must_change_password" boolean NOT NULL DEFAULT false,
          "status" "auth"."user_status" NOT NULL DEFAULT 'active',
          "status_reason" character varying,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "auth"."users" ("email")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_9ec532792efcc39bd7a29a31d1" ON "auth"."users" ("google_id")
      WHERE google_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE TABLE "auth"."email_verifications" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "user_id" uuid NOT NULL,
          "token" character varying NOT NULL,
          "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
          "used_at" TIMESTAMP WITH TIME ZONE,
          CONSTRAINT "PK_c1ea2921e767f83cd44c0af203f" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_595be4c36e66b21d3fd14c73a2" ON "auth"."email_verifications" ("token")
    `);
    await queryRunner.query(`
      CREATE TABLE "auth"."password_resets" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "user_id" uuid NOT NULL,
          "token" character varying NOT NULL,
          "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
          "used_at" TIMESTAMP WITH TIME ZONE,
          CONSTRAINT "PK_4816377aa98211c1de34469e742" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_9b34edd5264effbbc875c266a9" ON "auth"."password_resets" ("token")
    `);
    await queryRunner.query(`
      CREATE TYPE "auth"."trust_tier" AS ENUM('new', 'proven', 'trusted')
    `);
    await queryRunner.query(`
      CREATE TABLE "auth"."educator_profiles" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "user_id" uuid NOT NULL,
          "bio" text NOT NULL DEFAULT '',
          "expertise_area" character varying NOT NULL DEFAULT '',
          "photo_url" character varying,
          "trust_tier" "auth"."trust_tier" NOT NULL DEFAULT 'new',
          "sample_video_url" character varying,
          CONSTRAINT "REL_2080c94891f76ce625e19874b6" UNIQUE ("user_id"),
          CONSTRAINT "PK_efba257e0b3b3cdce007612abe4" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_2080c94891f76ce625e19874b6" ON "auth"."educator_profiles" ("user_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "auth"."institutions" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "name" character varying NOT NULL,
          "logo_url" character varying,
          "owner_user_id" uuid NOT NULL,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_0be7539dcdba335470dc05e9690" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "auth"."institution_instructors" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "institution_id" uuid NOT NULL,
          "user_id" uuid NOT NULL,
          "role_in_org" character varying NOT NULL DEFAULT 'instructor',
          CONSTRAINT "PK_992f789545a304c3add69f69b39" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_4ed97bb1119f0ab8da94fee59e" ON "auth"."institution_instructors" ("institution_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "auth"."audit_log" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "actor_id" uuid NOT NULL,
          "action" character varying NOT NULL,
          "target" character varying NOT NULL,
          "detail" jsonb NOT NULL DEFAULT '{}',
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_07fefa57f7f5ab8fc3f52b3ed0b" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "auth"."educator_profiles"
      ADD CONSTRAINT "FK_2080c94891f76ce625e19874b6c" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    assertBaselineRevertAllowed('auth');
    await queryRunner.query(`
      ALTER TABLE "auth"."educator_profiles" DROP CONSTRAINT "FK_2080c94891f76ce625e19874b6c"
    `);
    await queryRunner.query(`
      DROP TABLE "auth"."audit_log"
    `);
    await queryRunner.query(`
      DROP INDEX "auth"."IDX_4ed97bb1119f0ab8da94fee59e"
    `);
    await queryRunner.query(`
      DROP TABLE "auth"."institution_instructors"
    `);
    await queryRunner.query(`
      DROP TABLE "auth"."institutions"
    `);
    await queryRunner.query(`
      DROP INDEX "auth"."IDX_2080c94891f76ce625e19874b6"
    `);
    await queryRunner.query(`
      DROP TABLE "auth"."educator_profiles"
    `);
    await queryRunner.query(`
      DROP TYPE "auth"."trust_tier"
    `);
    await queryRunner.query(`
      DROP INDEX "auth"."IDX_9b34edd5264effbbc875c266a9"
    `);
    await queryRunner.query(`
      DROP TABLE "auth"."password_resets"
    `);
    await queryRunner.query(`
      DROP INDEX "auth"."IDX_595be4c36e66b21d3fd14c73a2"
    `);
    await queryRunner.query(`
      DROP TABLE "auth"."email_verifications"
    `);
    await queryRunner.query(`
      DROP INDEX "auth"."IDX_9ec532792efcc39bd7a29a31d1"
    `);
    await queryRunner.query(`
      DROP INDEX "auth"."IDX_97672ac88f789774dd47f7c8be"
    `);
    await queryRunner.query(`
      DROP TABLE "auth"."users"
    `);
    await queryRunner.query(`
      DROP TYPE "auth"."user_status"
    `);
    await queryRunner.query(`
      DROP TYPE "auth"."user_role"
    `);
  }
}
