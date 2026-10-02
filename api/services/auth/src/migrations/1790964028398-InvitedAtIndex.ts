import { MigrationInterface, QueryRunner } from 'typeorm';

// Serves the daily invite cap: invitations per institution since a cutoff.
//
// Same rules as IndexTuning: CONCURRENTLY, so `transaction = false` and one
// statement per query(); every statement is safe to repeat.
export class InvitedAtIndex1790964028398 implements MigrationInterface {
  name = 'InvitedAtIndex1790964028398';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "auth"."IDX_institution_instructors_institution_id_invited_at"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_institution_instructors_institution_id_invited_at" ON "auth"."institution_instructors" ("institution_id", "invited_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "auth"."IDX_institution_instructors_institution_id_invited_at"`);
  }
}
