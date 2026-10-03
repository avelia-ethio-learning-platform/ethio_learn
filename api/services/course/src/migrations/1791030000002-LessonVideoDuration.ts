import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 6b: the measured length of a lesson's current video, kept apart from the
// editor's rounded `duration_seconds` estimate. Null until a video is measured.
export class LessonVideoDuration1791030000002 implements MigrationInterface {
  name = 'LessonVideoDuration1791030000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "course"."lessons" ADD "video_duration_seconds" integer`);
    await queryRunner.query(
      `ALTER TABLE "course"."lessons" ADD CONSTRAINT "CHK_lessons_video_duration_seconds" CHECK (video_duration_seconds IS NULL OR video_duration_seconds > 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "course"."lessons" DROP CONSTRAINT "CHK_lessons_video_duration_seconds"`);
    await queryRunner.query(`ALTER TABLE "course"."lessons" DROP COLUMN "video_duration_seconds"`);
  }
}
