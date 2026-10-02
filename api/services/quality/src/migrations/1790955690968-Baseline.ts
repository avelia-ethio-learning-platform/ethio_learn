import { MigrationInterface, QueryRunner } from 'typeorm';
import { assertBaselineRevertAllowed, baselineState } from '@ethiopialearn/common';

// Generated from the entities against an empty database, then hand-edited:
// the guard below, and one of the two CREATE/DROP TYPE "quality"."owner_type" statements
// TypeORM emits for an enum that two tables share.
// Databases built by `synchronize` (production included) already have every
// table: there the baseline records itself and runs no DDL.
const TABLES = ['qa_review_items', 'course_reviews', 'fraud_signals', 'educator_trust_tiers', 'course_cache', 'payee_stats', 'refund_log'];

export class Baseline1790955690968 implements MigrationInterface {
  name = 'Baseline1790955690968';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if ((await baselineState(queryRunner, 'quality', TABLES)) === 'present') return;
    await queryRunner.query(`
      CREATE TYPE "quality"."owner_type" AS ENUM('educator', 'institution')
    `);
    await queryRunner.query(`
      CREATE TYPE "quality"."qa_review_status" AS ENUM(
          'pending',
          'in_review',
          'approved',
          'coached',
          'flagged',
          'rejected',
          'withdrawn'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "quality"."qa_review_items" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "course_id" uuid NOT NULL,
          "course_title" character varying NOT NULL,
          "owner_id" uuid NOT NULL,
          "owner_type" "quality"."owner_type" NOT NULL,
          "owner_user_id" uuid,
          "owner_email" character varying NOT NULL DEFAULT '',
          "owner_name" character varying NOT NULL DEFAULT '',
          "qo_id" uuid,
          "status" "quality"."qa_review_status" NOT NULL DEFAULT 'pending',
          "coaching_notes" text NOT NULL DEFAULT '',
          "plagiarism" jsonb NOT NULL DEFAULT '{}',
          "trigger" character varying NOT NULL DEFAULT 'submission',
          "kind" character varying(20) NOT NULL DEFAULT 'new_course',
          "revision_id" uuid,
          "content_hash" character varying,
          "diff_summary" jsonb NOT NULL DEFAULT '{}',
          "changelog_summary" text NOT NULL DEFAULT '',
          "priority" integer NOT NULL DEFAULT '0',
          "claimed_by" uuid,
          "claimed_at" TIMESTAMP WITH TIME ZONE,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "reviewed_at" TIMESTAMP WITH TIME ZONE,
          CONSTRAINT "PK_541f52f5b69ec3d435824183821" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_b5294de42d2caef7c75a9906ea" ON "quality"."qa_review_items" ("course_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "quality"."course_reviews" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "course_id" uuid NOT NULL,
          "learner_id" uuid NOT NULL,
          "rating" integer NOT NULL,
          "comment" text,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "UQ_c901611bc48cfca84d2ced44891" UNIQUE ("course_id", "learner_id"),
          CONSTRAINT "PK_2dc117d5b688a2040125a09d1f1" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_1f69fdcbd7ea5f0e52c3230c00" ON "quality"."course_reviews" ("course_id")
    `);
    await queryRunner.query(`
      CREATE TYPE "quality"."fraud_subject_type" AS ENUM('user', 'course', 'payment')
    `);
    await queryRunner.query(`
      CREATE TYPE "quality"."fraud_signal_status" AS ENUM('open', 'resolved')
    `);
    await queryRunner.query(`
      CREATE TABLE "quality"."fraud_signals" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "subject_type" "quality"."fraud_subject_type" NOT NULL,
          "subject_id" uuid NOT NULL,
          "signal_type" character varying NOT NULL,
          "detail" text NOT NULL DEFAULT '',
          "payee_id" uuid,
          "status" "quality"."fraud_signal_status" NOT NULL DEFAULT 'open',
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "resolved_at" TIMESTAMP WITH TIME ZONE,
          "resolved_by" uuid,
          CONSTRAINT "PK_6d07a75e9b30fbf85c6ed3129d0" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_c894972835881fad046e1d5ed9" ON "quality"."fraud_signals" ("status")
    `);
    await queryRunner.query(`
      CREATE TYPE "quality"."trust_tier" AS ENUM('new', 'proven', 'trusted')
    `);
    await queryRunner.query(`
      CREATE TABLE "quality"."educator_trust_tiers" (
          "educator_id" uuid NOT NULL,
          "tier" "quality"."trust_tier" NOT NULL DEFAULT 'new',
          "computed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_5b78d451e83ef3a6a257b3a538b" PRIMARY KEY ("educator_id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "quality"."course_cache" (
          "course_id" uuid NOT NULL,
          "owner_id" uuid NOT NULL,
          "owner_type" "quality"."owner_type" NOT NULL,
          "title" character varying NOT NULL,
          CONSTRAINT "PK_3fa755eb4092b0833f7016bd847" PRIMARY KEY ("course_id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "quality"."payee_stats" (
          "payee_id" uuid NOT NULL,
          "payments" integer NOT NULL DEFAULT '0',
          "refunds" integer NOT NULL DEFAULT '0',
          "completions" integer NOT NULL DEFAULT '0',
          CONSTRAINT "PK_de712e1d060cc3bc44f93b5f891" PRIMARY KEY ("payee_id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "quality"."refund_log" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "learner_id" uuid NOT NULL,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_6a5d3169f63abe9094049e86c9e" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_7dda5e259a04603196f6b8ca15" ON "quality"."refund_log" ("learner_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    assertBaselineRevertAllowed('quality');
    await queryRunner.query(`
      DROP INDEX "quality"."IDX_7dda5e259a04603196f6b8ca15"
    `);
    await queryRunner.query(`
      DROP TABLE "quality"."refund_log"
    `);
    await queryRunner.query(`
      DROP TABLE "quality"."payee_stats"
    `);
    await queryRunner.query(`
      DROP TABLE "quality"."course_cache"
    `);
    await queryRunner.query(`
      DROP TABLE "quality"."educator_trust_tiers"
    `);
    await queryRunner.query(`
      DROP TYPE "quality"."trust_tier"
    `);
    await queryRunner.query(`
      DROP INDEX "quality"."IDX_c894972835881fad046e1d5ed9"
    `);
    await queryRunner.query(`
      DROP TABLE "quality"."fraud_signals"
    `);
    await queryRunner.query(`
      DROP TYPE "quality"."fraud_signal_status"
    `);
    await queryRunner.query(`
      DROP TYPE "quality"."fraud_subject_type"
    `);
    await queryRunner.query(`
      DROP INDEX "quality"."IDX_1f69fdcbd7ea5f0e52c3230c00"
    `);
    await queryRunner.query(`
      DROP TABLE "quality"."course_reviews"
    `);
    await queryRunner.query(`
      DROP INDEX "quality"."IDX_b5294de42d2caef7c75a9906ea"
    `);
    await queryRunner.query(`
      DROP TABLE "quality"."qa_review_items"
    `);
    await queryRunner.query(`
      DROP TYPE "quality"."qa_review_status"
    `);
    await queryRunner.query(`
      DROP TYPE "quality"."owner_type"
    `);
  }
}
