import { MigrationInterface, QueryRunner } from 'typeorm';
import { assertBaselineRevertAllowed, baselineState } from '@ethiopialearn/common';

// Generated from the entities against an empty database, then hand-edited:
// the guard below.
// Databases built by `synchronize` (production included) already have every
// table: there the baseline records itself and runs no DDL.
const TABLES = ['courses', 'sections', 'lessons', 'course_revisions', 'course_changelog', 'course_knowledge', 'course_chat_messages', 'upload_sessions'];

export class Baseline1790955681997 implements MigrationInterface {
  name = 'Baseline1790955681997';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if ((await baselineState(queryRunner, 'course', TABLES)) === 'present') return;
    await queryRunner.query(`
      CREATE TYPE "course"."owner_type" AS ENUM('educator', 'institution')
    `);
    await queryRunner.query(`
      CREATE TYPE "course"."pricing_type" AS ENUM('free', 'freemium', 'paid')
    `);
    await queryRunner.query(`
      CREATE TYPE "course"."course_status" AS ENUM(
          'draft',
          'institution_review',
          'submitted',
          'under_review',
          'published',
          'flagged',
          'unlisted',
          'archived'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "course"."courses" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "owner_id" uuid NOT NULL,
          "owner_type" "course"."owner_type" NOT NULL,
          "created_by" uuid NOT NULL,
          "institution_id" uuid,
          "title" character varying(120) NOT NULL,
          "description" text NOT NULL,
          "category" character varying NOT NULL DEFAULT 'other',
          "language" character varying NOT NULL DEFAULT 'en',
          "thumbnail_url" character varying,
          "pricing_type" "course"."pricing_type" NOT NULL,
          "price_etb" numeric(12, 2),
          "status" "course"."course_status" NOT NULL DEFAULT 'draft',
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "published_at" TIMESTAMP WITH TIME ZONE,
          "rating_avg" numeric(3, 2),
          "rating_count" integer NOT NULL DEFAULT '0',
          "rating_points" integer NOT NULL DEFAULT '0',
          "enrolled_count" integer NOT NULL DEFAULT '0',
          "last_review_action" character varying,
          "last_review_notes" text,
          "last_reviewed_at" TIMESTAMP WITH TIME ZONE,
          "last_major_update_at" TIMESTAMP WITH TIME ZONE,
          "pending" jsonb,
          CONSTRAINT "PK_3f70a487cc718ad8eda4e6d58c9" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_8e2bcdb457d982b1dc39e5e0ed" ON "course"."courses" ("owner_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_16fcd8ab8bc042688984d5b393" ON "course"."courses" ("created_by")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_3a5da6162f1519c25665fa730b" ON "course"."courses" ("institution_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_889f2701163f86b2faf62a6247" ON "course"."courses" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_f1e5b9c7cc36448d6abe943403" ON "course"."courses" ("status", "published_at")
    `);
    await queryRunner.query(`
      CREATE TABLE "course"."sections" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "course_id" uuid NOT NULL,
          "title" character varying(160) NOT NULL,
          "order_index" integer NOT NULL,
          "is_free_preview" boolean NOT NULL DEFAULT false,
          "pending_state" character varying,
          "pending" jsonb,
          CONSTRAINT "PK_f9749dd3bffd880a497d007e450" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_53ccbd6e2fa20dac9062f4f4c3" ON "course"."sections" ("course_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "course"."lessons" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "section_id" uuid NOT NULL,
          "title" character varying(160) NOT NULL,
          "summary" text,
          "video_s3_key" character varying,
          "duration_seconds" integer NOT NULL DEFAULT '0',
          "order_index" integer NOT NULL,
          "pending_state" character varying,
          "pending" jsonb,
          CONSTRAINT "PK_9b9a8d455cac672d262d7275730" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_19261e484ffd22b40ea596ece4" ON "course"."lessons" ("section_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "course"."course_revisions" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "course_id" uuid NOT NULL,
          "status" character varying NOT NULL DEFAULT 'draft',
          "created_by" uuid NOT NULL,
          "changelog_summary" text,
          "changelog_major" boolean NOT NULL DEFAULT false,
          "diff" jsonb,
          "content_hash" character varying,
          "submitted_at" TIMESTAMP WITH TIME ZONE,
          "decided_at" TIMESTAMP WITH TIME ZONE,
          "decided_by" uuid,
          "decision_notes" text,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_1efa3d727acf43e8772832bc056" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_93109917bd4b012e05e3011de3" ON "course"."course_revisions" ("course_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_course_revisions_open" ON "course"."course_revisions" ("course_id")
      WHERE "status" IN ('draft', 'institution_review', 'submitted')
    `);
    await queryRunner.query(`
      CREATE TABLE "course"."course_changelog" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "course_id" uuid NOT NULL,
          "kind" character varying NOT NULL DEFAULT 'minor',
          "summary" text NOT NULL,
          "created_by" uuid NOT NULL,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_0a15ac24ddf2d9e8b6944821a23" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_7fd83d4cf30c70cbf7dd12eb32" ON "course"."course_changelog" ("course_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "course"."course_knowledge" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "course_id" uuid NOT NULL,
          "source" character varying NOT NULL DEFAULT 'notes',
          "title" character varying(200) NOT NULL,
          "chunk_index" integer NOT NULL DEFAULT '0',
          "text" text NOT NULL,
          "state" character varying NOT NULL DEFAULT 'live',
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_ba124b8081b44012aefae3bcc2f" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_36d55762ed1fab096c3d13886a" ON "course"."course_knowledge" ("course_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "course"."course_chat_messages" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "course_id" uuid NOT NULL,
          "learner_id" uuid NOT NULL,
          "role" character varying NOT NULL,
          "content" text NOT NULL,
          "sources" text array NOT NULL DEFAULT '{}',
          "not_covered" boolean NOT NULL DEFAULT false,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_d1d361949babfe3332ab57e22e5" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_f03639024c29045db32a09f48f" ON "course"."course_chat_messages" ("course_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_32157b6e5bafe2b4ce853bae82" ON "course"."course_chat_messages" ("learner_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "course"."upload_sessions" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "owner_id" uuid NOT NULL,
          "kind" character varying NOT NULL DEFAULT 'video',
          "lesson_id" uuid,
          "key" character varying(400) NOT NULL,
          "upload_id" text NOT NULL,
          "filename" character varying(200) NOT NULL,
          "content_type" character varying(100) NOT NULL,
          "size" bigint NOT NULL,
          "part_size" integer NOT NULL,
          "part_count" integer NOT NULL,
          "status" character varying NOT NULL DEFAULT 'uploading',
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "completed_at" TIMESTAMP WITH TIME ZONE,
          CONSTRAINT "PK_4b6ca30b8bb2baa0de9c6bf8fea" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_49ca4b1d07ccef03d92aa3e853" ON "course"."upload_sessions" ("owner_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_b6e4925fce6ec865e94e9e80ec" ON "course"."upload_sessions" ("key")
    `);
    await queryRunner.query(`
      ALTER TABLE "course"."sections"
      ADD CONSTRAINT "FK_53ccbd6e2fa20dac9062f4f4c36" FOREIGN KEY ("course_id") REFERENCES "course"."courses"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "course"."lessons"
      ADD CONSTRAINT "FK_19261e484ffd22b40ea596ece4d" FOREIGN KEY ("section_id") REFERENCES "course"."sections"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    assertBaselineRevertAllowed('course');
    await queryRunner.query(`
      ALTER TABLE "course"."lessons" DROP CONSTRAINT "FK_19261e484ffd22b40ea596ece4d"
    `);
    await queryRunner.query(`
      ALTER TABLE "course"."sections" DROP CONSTRAINT "FK_53ccbd6e2fa20dac9062f4f4c36"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_b6e4925fce6ec865e94e9e80ec"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_49ca4b1d07ccef03d92aa3e853"
    `);
    await queryRunner.query(`
      DROP TABLE "course"."upload_sessions"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_32157b6e5bafe2b4ce853bae82"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_f03639024c29045db32a09f48f"
    `);
    await queryRunner.query(`
      DROP TABLE "course"."course_chat_messages"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_36d55762ed1fab096c3d13886a"
    `);
    await queryRunner.query(`
      DROP TABLE "course"."course_knowledge"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_7fd83d4cf30c70cbf7dd12eb32"
    `);
    await queryRunner.query(`
      DROP TABLE "course"."course_changelog"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."uq_course_revisions_open"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_93109917bd4b012e05e3011de3"
    `);
    await queryRunner.query(`
      DROP TABLE "course"."course_revisions"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_19261e484ffd22b40ea596ece4"
    `);
    await queryRunner.query(`
      DROP TABLE "course"."lessons"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_53ccbd6e2fa20dac9062f4f4c3"
    `);
    await queryRunner.query(`
      DROP TABLE "course"."sections"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_f1e5b9c7cc36448d6abe943403"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_889f2701163f86b2faf62a6247"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_3a5da6162f1519c25665fa730b"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_16fcd8ab8bc042688984d5b393"
    `);
    await queryRunner.query(`
      DROP INDEX "course"."IDX_8e2bcdb457d982b1dc39e5e0ed"
    `);
    await queryRunner.query(`
      DROP TABLE "course"."courses"
    `);
    await queryRunner.query(`
      DROP TYPE "course"."course_status"
    `);
    await queryRunner.query(`
      DROP TYPE "course"."pricing_type"
    `);
    await queryRunner.query(`
      DROP TYPE "course"."owner_type"
    `);
  }
}
