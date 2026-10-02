import { MigrationInterface, QueryRunner } from 'typeorm';
import { assertBaselineRevertAllowed, baselineState } from '@ethiopialearn/common';

// Generated from the entities against an empty database, then hand-edited:
// the guard below, and one of the two CREATE/DROP TYPE "financial"."owner_type" statements
// TypeORM emits for an enum that two tables share.
// Databases built by `synchronize` (production included) already have every
// table: there the baseline records itself and runs no DDL.
const TABLES = ['payments', 'payouts', 'refund_requests', 'payout_holds', 'coupons', 'wallets', 'wallet_transactions', 'sponsorships', 'bulk_purchases', 'referral_codes', 'referrals'];

export class Baseline1790955685613 implements MigrationInterface {
  name = 'Baseline1790955685613';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if ((await baselineState(queryRunner, 'financial', TABLES)) === 'present') return;
    await queryRunner.query(`
      CREATE TYPE "financial"."payment_method" AS ENUM('chapa', 'bank_transfer', 'wallet', 'coupon')
    `);
    await queryRunner.query(`
      CREATE TYPE "financial"."payment_status" AS ENUM('pending', 'confirmed', 'failed', 'refunded')
    `);
    await queryRunner.query(`
      CREATE TYPE "financial"."owner_type" AS ENUM('educator', 'institution')
    `);
    await queryRunner.query(`
      CREATE TABLE "financial"."payments" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "learner_id" uuid NOT NULL,
          "course_id" uuid NOT NULL,
          "amount_etb" numeric(12, 2) NOT NULL,
          "method" "financial"."payment_method" NOT NULL,
          "status" "financial"."payment_status" NOT NULL DEFAULT 'pending',
          "chapa_tx_ref" character varying NOT NULL,
          "chapa_checkout_url" character varying,
          "webhook_received_at" TIMESTAMP WITH TIME ZONE,
          "payee_id" uuid NOT NULL,
          "payee_type" "financial"."owner_type" NOT NULL,
          "course_title" character varying NOT NULL DEFAULT '',
          "payout_id" uuid,
          "purpose" character varying NOT NULL DEFAULT 'course',
          "meta" jsonb,
          "list_price_etb" numeric(12, 2),
          "discount_etb" numeric(12, 2) NOT NULL DEFAULT '0',
          "coupon_code" character varying,
          "nudged_at" TIMESTAMP WITH TIME ZONE,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_e93402a8b0907f91b1359b8edf" ON "financial"."payments" ("learner_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_c5fa169d2de9407d99f2c6e4fa" ON "financial"."payments" ("course_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_332dfc678c46113c4de23bedae" ON "financial"."payments" ("chapa_tx_ref")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_10578ef284a65afc54fb7c5aea" ON "financial"."payments" ("payee_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_23b8fcfa9f1849347daa419aac" ON "financial"."payments" ("purpose")
    `);
    await queryRunner.query(`
      CREATE TYPE "financial"."payout_status" AS ENUM('pending', 'scheduled', 'paid', 'held')
    `);
    await queryRunner.query(`
      CREATE TABLE "financial"."payouts" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "payee_id" uuid NOT NULL,
          "payee_type" "financial"."owner_type" NOT NULL,
          "gross_amount_etb" numeric(12, 2) NOT NULL,
          "platform_fee_etb" numeric(12, 2) NOT NULL,
          "net_amount_etb" numeric(12, 2) NOT NULL,
          "status" "financial"."payout_status" NOT NULL DEFAULT 'pending',
          "hold_reason" character varying,
          "scheduled_for" TIMESTAMP WITH TIME ZONE,
          "paid_at" TIMESTAMP WITH TIME ZONE,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_76855dc4f0a6c18c72eea302e87" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_02d909049c697b097c79a25eb2" ON "financial"."payouts" ("payee_id")
    `);
    await queryRunner.query(`
      CREATE TYPE "financial"."refund_status" AS ENUM('pending', 'approved', 'denied')
    `);
    await queryRunner.query(`
      CREATE TABLE "financial"."refund_requests" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "payment_id" uuid NOT NULL,
          "learner_id" uuid NOT NULL,
          "reason" text NOT NULL,
          "status" "financial"."refund_status" NOT NULL DEFAULT 'pending',
          "decision_rule" character varying NOT NULL DEFAULT '',
          "decided_at" TIMESTAMP WITH TIME ZONE,
          "decided_by" uuid,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_00c88ecd40a63abe92a3dc69897" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_6cffffc4e01e1e212c3538f40e" ON "financial"."refund_requests" ("payment_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "financial"."payout_holds" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "payee_id" uuid NOT NULL,
          "flag_id" character varying NOT NULL,
          "reason" character varying NOT NULL DEFAULT '',
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_7b68b9814674713fee0423f8459" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_271b4ef967b254879f2469853f" ON "financial"."payout_holds" ("payee_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_859e411e86a182194f0afa0454" ON "financial"."payout_holds" ("flag_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "financial"."coupons" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "code" character varying(32) NOT NULL,
          "kind" character varying NOT NULL,
          "value" numeric(12, 2) NOT NULL,
          "course_id" uuid,
          "created_by" uuid NOT NULL,
          "creator_role" character varying NOT NULL DEFAULT '',
          "max_uses" integer,
          "uses" integer NOT NULL DEFAULT '0',
          "expires_at" TIMESTAMP WITH TIME ZONE,
          "active" boolean NOT NULL DEFAULT true,
          "note" character varying NOT NULL DEFAULT '',
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_d7ea8864a0150183770f3e9a8cb" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_e025109230e82925843f2a14c4" ON "financial"."coupons" ("code")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_cbfc36859d6d455581303e8508" ON "financial"."coupons" ("course_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "financial"."wallets" (
          "user_id" uuid NOT NULL,
          "balance_etb" numeric(12, 2) NOT NULL DEFAULT '0',
          "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_92558c08091598f7a4439586cda" PRIMARY KEY ("user_id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial"."wallet_transactions" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "user_id" uuid NOT NULL,
          "amount_etb" numeric(12, 2) NOT NULL,
          "kind" character varying NOT NULL,
          "reference" character varying NOT NULL DEFAULT '',
          "note" character varying NOT NULL DEFAULT '',
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_5120f131bde2cda940ec1a621db" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_4796762c619893704abbc3dce6" ON "financial"."wallet_transactions" ("user_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "financial"."sponsorships" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "source" character varying NOT NULL,
          "status" character varying NOT NULL DEFAULT 'pending_payment',
          "sponsor_id" uuid,
          "sponsor_name" character varying NOT NULL DEFAULT '',
          "recipient_user_id" uuid,
          "recipient_email" character varying NOT NULL,
          "course_id" uuid NOT NULL,
          "course_title" character varying NOT NULL DEFAULT '',
          "message" text NOT NULL DEFAULT '',
          "payment_id" uuid,
          "bulk_purchase_id" uuid,
          "organization_name" character varying,
          "token" character varying(48) NOT NULL,
          "granted_at" TIMESTAMP WITH TIME ZONE,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_393571b62d6dd0f63c6d3eb154b" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_35ae20905a1fd68c529df865c2" ON "financial"."sponsorships" ("sponsor_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_699d5c69ba27012e522eff16b6" ON "financial"."sponsorships" ("recipient_user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_5b5baa2fbb5bc67f8e5367dfb4" ON "financial"."sponsorships" ("recipient_email")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_ea28a19c60aef07371c82091ec" ON "financial"."sponsorships" ("token")
    `);
    await queryRunner.query(`
      CREATE TABLE "financial"."bulk_purchases" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "buyer_id" uuid NOT NULL,
          "buyer_role" character varying NOT NULL DEFAULT '',
          "organization_name" character varying NOT NULL DEFAULT '',
          "course_id" uuid NOT NULL,
          "course_title" character varying NOT NULL DEFAULT '',
          "seats" integer NOT NULL,
          "unit_price_etb" numeric(12, 2) NOT NULL,
          "discount_percent" integer NOT NULL DEFAULT '0',
          "total_etb" numeric(12, 2) NOT NULL,
          "status" character varying NOT NULL DEFAULT 'pending_payment',
          "payment_id" uuid,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_906ea7bd9183bcbb6d179878db5" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_6e1d39f92b6c65a01f04985171" ON "financial"."bulk_purchases" ("buyer_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "financial"."referral_codes" (
          "user_id" uuid NOT NULL,
          "code" character varying(16) NOT NULL,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_c369901fa4e5d32ad6bc69a11e0" PRIMARY KEY ("user_id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_adda7b9deda346ff710695f496" ON "financial"."referral_codes" ("code")
    `);
    await queryRunner.query(`
      CREATE TABLE "financial"."referrals" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "referrer_id" uuid NOT NULL,
          "referred_user_id" uuid,
          "referred_email" character varying NOT NULL DEFAULT '',
          "status" character varying NOT NULL DEFAULT 'invited',
          "reward_etb" numeric(12, 2) NOT NULL DEFAULT '0',
          "rewarded_at" TIMESTAMP WITH TIME ZONE,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_ea9980e34f738b6252817326c08" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_18af9fcaffac6d6d3b28130e14" ON "financial"."referrals" ("referrer_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_6e8e92ccfe617224a7f30adb6b" ON "financial"."referrals" ("referred_user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_f6596784a841a6e36e7ae7a9dc" ON "financial"."referrals" ("referred_email")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    assertBaselineRevertAllowed('financial');
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_f6596784a841a6e36e7ae7a9dc"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_6e8e92ccfe617224a7f30adb6b"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_18af9fcaffac6d6d3b28130e14"
    `);
    await queryRunner.query(`
      DROP TABLE "financial"."referrals"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_adda7b9deda346ff710695f496"
    `);
    await queryRunner.query(`
      DROP TABLE "financial"."referral_codes"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_6e1d39f92b6c65a01f04985171"
    `);
    await queryRunner.query(`
      DROP TABLE "financial"."bulk_purchases"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_ea28a19c60aef07371c82091ec"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_5b5baa2fbb5bc67f8e5367dfb4"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_699d5c69ba27012e522eff16b6"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_35ae20905a1fd68c529df865c2"
    `);
    await queryRunner.query(`
      DROP TABLE "financial"."sponsorships"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_4796762c619893704abbc3dce6"
    `);
    await queryRunner.query(`
      DROP TABLE "financial"."wallet_transactions"
    `);
    await queryRunner.query(`
      DROP TABLE "financial"."wallets"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_cbfc36859d6d455581303e8508"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_e025109230e82925843f2a14c4"
    `);
    await queryRunner.query(`
      DROP TABLE "financial"."coupons"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_859e411e86a182194f0afa0454"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_271b4ef967b254879f2469853f"
    `);
    await queryRunner.query(`
      DROP TABLE "financial"."payout_holds"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_6cffffc4e01e1e212c3538f40e"
    `);
    await queryRunner.query(`
      DROP TABLE "financial"."refund_requests"
    `);
    await queryRunner.query(`
      DROP TYPE "financial"."refund_status"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_02d909049c697b097c79a25eb2"
    `);
    await queryRunner.query(`
      DROP TABLE "financial"."payouts"
    `);
    await queryRunner.query(`
      DROP TYPE "financial"."payout_status"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_23b8fcfa9f1849347daa419aac"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_10578ef284a65afc54fb7c5aea"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_332dfc678c46113c4de23bedae"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_c5fa169d2de9407d99f2c6e4fa"
    `);
    await queryRunner.query(`
      DROP INDEX "financial"."IDX_e93402a8b0907f91b1359b8edf"
    `);
    await queryRunner.query(`
      DROP TABLE "financial"."payments"
    `);
    await queryRunner.query(`
      DROP TYPE "financial"."owner_type"
    `);
    await queryRunner.query(`
      DROP TYPE "financial"."payment_status"
    `);
    await queryRunner.query(`
      DROP TYPE "financial"."payment_method"
    `);
  }
}
