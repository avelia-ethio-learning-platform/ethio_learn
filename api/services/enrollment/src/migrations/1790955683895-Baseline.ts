import { MigrationInterface, QueryRunner } from 'typeorm';
import { assertBaselineRevertAllowed, baselineState } from '@ethiopialearn/common';

// Generated from the entities against an empty database, then hand-edited:
// the guard below.
// Databases built by `synchronize` (production included) already have every
// table: there the baseline records itself and runs no DDL.
const TABLES = ['enrollments', 'lesson_progress', 'video_progress', 'course_cache'];

export class Baseline1790955683895 implements MigrationInterface {
  name = 'Baseline1790955683895';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if ((await baselineState(queryRunner, 'enrollment', TABLES)) === 'present') return;
    await queryRunner.query(`
      CREATE TYPE "enrollment"."entitlement_status" AS ENUM('none', 'active', 'refunded')
    `);
    await queryRunner.query(`
      CREATE TABLE "enrollment"."enrollments" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "learner_id" uuid NOT NULL,
          "course_id" uuid NOT NULL,
          "entitlement_status" "enrollment"."entitlement_status" NOT NULL DEFAULT 'none',
          "enrolled_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "completed_at" TIMESTAMP WITH TIME ZONE,
          "source" character varying NOT NULL DEFAULT 'payment',
          "sponsor_id" uuid,
          "last_activity_at" TIMESTAMP WITH TIME ZONE,
          "nudge_level" integer NOT NULL DEFAULT '0',
          "milestones_sent" integer array NOT NULL DEFAULT '{}',
          "changelog_seen_at" TIMESTAMP WITH TIME ZONE,
          CONSTRAINT "UQ_03e9ab2de7d400eefae2707e74f" UNIQUE ("learner_id", "course_id"),
          CONSTRAINT "PK_7c0f752f9fb68bf6ed7367ab00f" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_bb53c1a95eb92bf25d7c632058" ON "enrollment"."enrollments" ("learner_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_b79d0bf01779fdf9cfb6b092af" ON "enrollment"."enrollments" ("course_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "enrollment"."lesson_progress" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "enrollment_id" uuid NOT NULL,
          "lesson_id" uuid NOT NULL,
          "completed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
          CONSTRAINT "UQ_db0cdb221e98de3ff32470ecfed" UNIQUE ("enrollment_id", "lesson_id"),
          CONSTRAINT "PK_e6223ebbc5f8f5fce40e0193de1" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_2374c15822383f7e5362e27d41" ON "enrollment"."lesson_progress" ("enrollment_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "enrollment"."video_progress" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "enrollment_id" uuid NOT NULL,
          "lesson_id" uuid NOT NULL,
          "position_seconds" double precision NOT NULL DEFAULT '0',
          "duration_seconds" double precision NOT NULL DEFAULT '0',
          "percent_watched" integer NOT NULL DEFAULT '0',
          "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "UQ_99b9af1e97922c7d94f3af0d0f7" UNIQUE ("enrollment_id", "lesson_id"),
          CONSTRAINT "PK_369873ab0ef49028bcb882a6827" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_92d69a37eefba833cfc1dc39c7" ON "enrollment"."video_progress" ("enrollment_id")
    `);
    await queryRunner.query(`
      CREATE TYPE "enrollment"."pricing_type" AS ENUM('free', 'freemium', 'paid')
    `);
    await queryRunner.query(`
      CREATE TABLE "enrollment"."course_cache" (
          "course_id" uuid NOT NULL,
          "title" character varying NOT NULL,
          "pricing_type" "enrollment"."pricing_type" NOT NULL,
          "owner_id" uuid NOT NULL,
          "owner_type" character varying NOT NULL,
          CONSTRAINT "PK_3fa755eb4092b0833f7016bd847" PRIMARY KEY ("course_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    assertBaselineRevertAllowed('enrollment');
    await queryRunner.query(`
      DROP TABLE "enrollment"."course_cache"
    `);
    await queryRunner.query(`
      DROP TYPE "enrollment"."pricing_type"
    `);
    await queryRunner.query(`
      DROP INDEX "enrollment"."IDX_92d69a37eefba833cfc1dc39c7"
    `);
    await queryRunner.query(`
      DROP TABLE "enrollment"."video_progress"
    `);
    await queryRunner.query(`
      DROP INDEX "enrollment"."IDX_2374c15822383f7e5362e27d41"
    `);
    await queryRunner.query(`
      DROP TABLE "enrollment"."lesson_progress"
    `);
    await queryRunner.query(`
      DROP INDEX "enrollment"."IDX_b79d0bf01779fdf9cfb6b092af"
    `);
    await queryRunner.query(`
      DROP INDEX "enrollment"."IDX_bb53c1a95eb92bf25d7c632058"
    `);
    await queryRunner.query(`
      DROP TABLE "enrollment"."enrollments"
    `);
    await queryRunner.query(`
      DROP TYPE "enrollment"."entitlement_status"
    `);
  }
}
