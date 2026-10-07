import { MigrationInterface, QueryRunner } from 'typeorm';
import { resolveDuplicateOpenSignals } from './1791060000000-FraudSignalDedupe';

// Phase 9b: at most one open fraud signal per (subject_type, subject_id, signal_type).
// raiseFraudSignal inserts with ON CONFLICT DO NOTHING against it, so a redelivered
// event or a repeated check can't open a second one.
//
// It first repeats FraudSignalDedupe's resolution: during a deploy the old instance
// still serves and can raise a duplicate after that migration committed, which would
// fail this build on every re-run. Then the same rules as IndexTuning: CONCURRENTLY,
// so `transaction = false` and one statement per query(), and the index is dropped
// before it's built, so an INVALID index left by a failed build is rebuilt.
export class FraudSignalOpenUnique1791060000001 implements MigrationInterface {
  name = 'FraudSignalOpenUnique1791060000001';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await resolveDuplicateOpenSignals(queryRunner);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "quality"."IDX_fraud_signals_open_subject_signal"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "IDX_fraud_signals_open_subject_signal" ON "quality"."fraud_signals" ("subject_type", "subject_id", "signal_type") WHERE status = 'open'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "quality"."IDX_fraud_signals_open_subject_signal"`);
  }
}
