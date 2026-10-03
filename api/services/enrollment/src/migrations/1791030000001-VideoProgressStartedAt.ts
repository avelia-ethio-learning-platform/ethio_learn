import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 6b: when the learner started a lesson's video, so completion can require
// real elapsed time. Existing rows are backfilled to one lesson length before
// their last heartbeat, so a learner mid-lesson at deploy isn't blocked. The
// default applies to rows created from now on; the column stays nullable because
// a replaced video resets it to null.
export class VideoProgressStartedAt1791030000001 implements MigrationInterface {
  name = 'VideoProgressStartedAt1791030000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "enrollment"."video_progress" ADD "started_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `UPDATE "enrollment"."video_progress" SET "started_at" = "updated_at" - make_interval(secs => "duration_seconds")`,
    );
    await queryRunner.query(`ALTER TABLE "enrollment"."video_progress" ALTER COLUMN "started_at" SET DEFAULT now()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "enrollment"."video_progress" DROP COLUMN "started_at"`);
  }
}
