import { MigrationInterface, QueryRunner } from 'typeorm';
import { assertBaselineRevertAllowed, baselineState } from '@ethiopialearn/common';

// Generated from the entities against an empty database, then hand-edited:
// the guard below, and one of the two CREATE/DROP TYPE "outcomes"."trust_tier" statements
// TypeORM emits for an enum that two tables share.
// Databases built by `synchronize` (production included) already have every
// table: there the baseline records itself and runs no DDL.
const TABLES = ['assessments', 'assessment_attempts', 'certificates', 'educator_tier_cache'];

export class Baseline1790955689247 implements MigrationInterface {
  name = 'Baseline1790955689247';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if ((await baselineState(queryRunner, 'outcomes', TABLES)) === 'present') return;
    await queryRunner.query(`
      CREATE TYPE "outcomes"."assessment_type" AS ENUM('quiz', 'ai_viva', 'project')
    `);
    await queryRunner.query(`
      CREATE TABLE "outcomes"."assessments" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "course_id" uuid NOT NULL,
          "type" "outcomes"."assessment_type" NOT NULL,
          "is_required" boolean NOT NULL DEFAULT true,
          "config" jsonb NOT NULL DEFAULT '{}',
          "pass_score" integer NOT NULL DEFAULT '60',
          "state" character varying(16) NOT NULL DEFAULT 'live',
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_a3442bd80a00e9111cefca57f6c" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_2d76c87300726d247589833f63" ON "outcomes"."assessments" ("course_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "outcomes"."assessment_attempts" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "assessment_id" uuid NOT NULL,
          "learner_id" uuid NOT NULL,
          "enrollment_id" uuid NOT NULL,
          "score" integer,
          "passed" boolean,
          "detail" jsonb NOT NULL DEFAULT '{}',
          "flagged" boolean NOT NULL DEFAULT false,
          "terminated" boolean NOT NULL DEFAULT false,
          "proctor_log" jsonb NOT NULL DEFAULT '[]',
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "submitted_at" TIMESTAMP WITH TIME ZONE,
          CONSTRAINT "PK_3761b6653b00f7df0ca4c1049ce" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_a6580a164dbc7b3232c8a2f063" ON "outcomes"."assessment_attempts" ("assessment_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_c0cd58abdd13077fdfdac839a0" ON "outcomes"."assessment_attempts" ("learner_id")
    `);
    await queryRunner.query(`
      CREATE TYPE "outcomes"."trust_tier" AS ENUM('new', 'proven', 'trusted')
    `);
    await queryRunner.query(`
      CREATE TABLE "outcomes"."certificates" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "enrollment_id" uuid NOT NULL,
          "certificate_uid" character varying NOT NULL,
          "signature" character varying NOT NULL,
          "pdf_s3_key" character varying NOT NULL,
          "qr_code_url" character varying NOT NULL,
          "learner_id" uuid NOT NULL,
          "learner_name" character varying NOT NULL,
          "course_id" uuid NOT NULL,
          "course_title" character varying NOT NULL,
          "educator_name" character varying NOT NULL DEFAULT '',
          "assessment_badges" jsonb NOT NULL DEFAULT '[]',
          "trust_tier_snapshot" "outcomes"."trust_tier" NOT NULL DEFAULT 'new',
          "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "invalidated" boolean NOT NULL DEFAULT false,
          CONSTRAINT "PK_e4c7e31e2144300bea7d89eb165" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_f0f3773b2ccb7811da9ccd63d9" ON "outcomes"."certificates" ("enrollment_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_872fc625a80faed7dbddb746be" ON "outcomes"."certificates" ("certificate_uid")
    `);
    await queryRunner.query(`
      CREATE TABLE "outcomes"."educator_tier_cache" (
          "educator_id" uuid NOT NULL,
          "tier" "outcomes"."trust_tier" NOT NULL DEFAULT 'new',
          CONSTRAINT "PK_28c8b4e7d10583d7fa2e9cc0c09" PRIMARY KEY ("educator_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    assertBaselineRevertAllowed('outcomes');
    await queryRunner.query(`
      DROP TABLE "outcomes"."educator_tier_cache"
    `);
    await queryRunner.query(`
      DROP INDEX "outcomes"."IDX_872fc625a80faed7dbddb746be"
    `);
    await queryRunner.query(`
      DROP INDEX "outcomes"."IDX_f0f3773b2ccb7811da9ccd63d9"
    `);
    await queryRunner.query(`
      DROP TABLE "outcomes"."certificates"
    `);
    await queryRunner.query(`
      DROP TYPE "outcomes"."trust_tier"
    `);
    await queryRunner.query(`
      DROP INDEX "outcomes"."IDX_c0cd58abdd13077fdfdac839a0"
    `);
    await queryRunner.query(`
      DROP INDEX "outcomes"."IDX_a6580a164dbc7b3232c8a2f063"
    `);
    await queryRunner.query(`
      DROP TABLE "outcomes"."assessment_attempts"
    `);
    await queryRunner.query(`
      DROP INDEX "outcomes"."IDX_2d76c87300726d247589833f63"
    `);
    await queryRunner.query(`
      DROP TABLE "outcomes"."assessments"
    `);
    await queryRunner.query(`
      DROP TYPE "outcomes"."assessment_type"
    `);
  }
}
