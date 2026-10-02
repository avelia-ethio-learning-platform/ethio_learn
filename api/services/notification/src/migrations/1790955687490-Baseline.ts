import { MigrationInterface, QueryRunner } from 'typeorm';
import { assertBaselineRevertAllowed, baselineState } from '@ethiopialearn/common';

// Generated from the entities against an empty database, then hand-edited:
// the guard below.
// Databases built by `synchronize` (production included) already have every
// table: there the baseline records itself and runs no DDL.
const TABLES = ['notification_log', 'notification_preferences', 'course_comments', 'dm_threads', 'dm_messages', 'inbox_notifications'];

export class Baseline1790955687490 implements MigrationInterface {
  name = 'Baseline1790955687490';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if ((await baselineState(queryRunner, 'notification', TABLES)) === 'present') return;
    await queryRunner.query(`
      CREATE TABLE "notification"."notification_log" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "user_id" uuid,
          "event_type" character varying NOT NULL,
          "channel" character varying NOT NULL DEFAULT 'email',
          "recipient" character varying NOT NULL,
          "subject" character varying NOT NULL,
          "status" character varying NOT NULL DEFAULT 'sent',
          "provider_message_id" character varying,
          "error" character varying(500),
          "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_6f761cfbbd064e0f326960877d6" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_2318594e750647311b24da4ae5" ON "notification"."notification_log" ("user_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "notification"."notification_preferences" (
          "user_id" uuid NOT NULL,
          "marketing_opt_out" boolean NOT NULL DEFAULT false,
          "new_course_categories" text array NOT NULL DEFAULT '{}',
          "new_course_instructor_ids" uuid array NOT NULL DEFAULT '{}',
          "new_course_email" boolean NOT NULL DEFAULT true,
          "new_course_in_app" boolean NOT NULL DEFAULT true,
          "course_updates_email" boolean NOT NULL DEFAULT true,
          "progress_emails" boolean NOT NULL DEFAULT true,
          "inactivity_emails" boolean NOT NULL DEFAULT true,
          CONSTRAINT "PK_64c90edc7310c6be7c10c96f675" PRIMARY KEY ("user_id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "notification"."course_comments" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "course_id" uuid NOT NULL,
          "parent_id" uuid,
          "author_id" uuid NOT NULL,
          "author_name" character varying NOT NULL,
          "author_role" character varying NOT NULL DEFAULT 'learner',
          "body" text NOT NULL,
          "deleted" boolean NOT NULL DEFAULT false,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_12badc103abef80c36ea9658a5f" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_2fe6d118a6e60842d38b1e5fe1" ON "notification"."course_comments" ("course_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_8decacbd91880f3ca09b61a48d" ON "notification"."course_comments" ("parent_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "notification"."dm_threads" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "a_id" uuid NOT NULL,
          "b_id" uuid NOT NULL,
          "a_name" character varying NOT NULL DEFAULT '',
          "b_name" character varying NOT NULL DEFAULT '',
          "a_role" character varying NOT NULL DEFAULT '',
          "b_role" character varying NOT NULL DEFAULT '',
          "last_message_at" TIMESTAMP WITH TIME ZONE,
          "last_preview" character varying NOT NULL DEFAULT '',
          "a_unread" integer NOT NULL DEFAULT '0',
          "b_unread" integer NOT NULL DEFAULT '0',
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_4b786631b6c4098179b16beed51" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_ed9c016a6c1cedddb9ac75fdfe" ON "notification"."dm_threads" ("a_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_b64f6a8981cdf824b5d64e4bfc" ON "notification"."dm_threads" ("b_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_2dd7ac8f765330182432082161" ON "notification"."dm_threads" ("a_id", "b_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "notification"."dm_messages" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "thread_id" uuid NOT NULL,
          "sender_id" uuid NOT NULL,
          "body" text NOT NULL,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_24b287ad446f01f5a364a277627" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_9e781649c6a6b1e316b0a7de95" ON "notification"."dm_messages" ("thread_id")
    `);
    await queryRunner.query(`
      CREATE TABLE "notification"."inbox_notifications" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "user_id" uuid,
          "target_role" character varying,
          "type" character varying NOT NULL,
          "title" character varying NOT NULL,
          "body" text NOT NULL DEFAULT '',
          "link" character varying,
          "read_at" TIMESTAMP WITH TIME ZONE,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_4be13fe6bbda895aea731fd8390" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_1e585de8fc606a8ff83c11bbd3" ON "notification"."inbox_notifications" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_99c47bf3b9bb6b4d718b67c991" ON "notification"."inbox_notifications" ("target_role")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    assertBaselineRevertAllowed('notification');
    await queryRunner.query(`
      DROP INDEX "notification"."IDX_99c47bf3b9bb6b4d718b67c991"
    `);
    await queryRunner.query(`
      DROP INDEX "notification"."IDX_1e585de8fc606a8ff83c11bbd3"
    `);
    await queryRunner.query(`
      DROP TABLE "notification"."inbox_notifications"
    `);
    await queryRunner.query(`
      DROP INDEX "notification"."IDX_9e781649c6a6b1e316b0a7de95"
    `);
    await queryRunner.query(`
      DROP TABLE "notification"."dm_messages"
    `);
    await queryRunner.query(`
      DROP INDEX "notification"."IDX_2dd7ac8f765330182432082161"
    `);
    await queryRunner.query(`
      DROP INDEX "notification"."IDX_b64f6a8981cdf824b5d64e4bfc"
    `);
    await queryRunner.query(`
      DROP INDEX "notification"."IDX_ed9c016a6c1cedddb9ac75fdfe"
    `);
    await queryRunner.query(`
      DROP TABLE "notification"."dm_threads"
    `);
    await queryRunner.query(`
      DROP INDEX "notification"."IDX_8decacbd91880f3ca09b61a48d"
    `);
    await queryRunner.query(`
      DROP INDEX "notification"."IDX_2fe6d118a6e60842d38b1e5fe1"
    `);
    await queryRunner.query(`
      DROP TABLE "notification"."course_comments"
    `);
    await queryRunner.query(`
      DROP TABLE "notification"."notification_preferences"
    `);
    await queryRunner.query(`
      DROP INDEX "notification"."IDX_2318594e750647311b24da4ae5"
    `);
    await queryRunner.query(`
      DROP TABLE "notification"."notification_log"
    `);
  }
}
