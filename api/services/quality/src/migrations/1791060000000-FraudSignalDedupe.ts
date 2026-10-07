import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Resolves every open fraud signal that repeats an older open one (same subject_type,
 * subject_id and signal_type), keeping the oldest, and inserts one FraudFlagResolved
 * outbox row per signal it resolves, in the payload shape resolveFlag emits. Financial
 * holds payouts per flag_id, so without those events a duplicate's hold would outlive
 * its signal and keep the payee held after the kept one is resolved (9b plan-review B2).
 * Returns how many it resolved, and logs it.
 *
 * - There is no note column and resolved_by is a uuid, so `detail` says "(duplicate)".
 * - One statement with the INSERT on top: TypeORM's query() returns the rows of an
 *   INSERT, but [rows, count] for an UPDATE.
 * - The UPDATE re-checks `status = 'open'`, so a signal an admin resolves meanwhile
 *   gets no second event.
 */
export async function resolveDuplicateOpenSignals(queryRunner: QueryRunner): Promise<number> {
  const inserted: unknown[] = await queryRunner.query(
    `WITH ranked AS (
       SELECT id, row_number() OVER (PARTITION BY subject_type, subject_id, signal_type ORDER BY created_at, id) AS n
       FROM "quality"."fraud_signals" WHERE status = 'open'
     ), resolved AS (
       UPDATE "quality"."fraud_signals" s SET status = 'resolved', resolved_at = now(), detail = trim(s.detail || ' (duplicate)')
       FROM ranked r WHERE s.id = r.id AND r.n > 1 AND s.status = 'open'
       RETURNING s.id, s.subject_type, s.subject_id, s.signal_type, s.payee_id, s.detail
     )
     INSERT INTO "quality"."outbox" (id, event_type, payload)
     SELECT gen_random_uuid(), 'FraudFlagResolved', jsonb_build_object('flag_id', id, 'subject_type', subject_type, 'subject_id', subject_id, 'signal_type', signal_type, 'payee_id', payee_id, 'detail', detail)
     FROM resolved
     RETURNING id`,
  );
  new Logger('FraudSignalDedupe').log(`resolved ${inserted.length} duplicate open fraud signal(s), each with a FraudFlagResolved outbox row`);
  return inserted.length;
}

// Phase 9b: before the open-signal unique index (FraudSignalOpenUnique) can be built,
// duplicate open signals must go. Runs after Outbox1791054805346, whose table it
// writes to; the relay delivers the rows once the service is up.
export class FraudSignalDedupe1791060000000 implements MigrationInterface {
  name = 'FraudSignalDedupe1791060000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await resolveDuplicateOpenSignals(queryRunner);
  }

  public async down(): Promise<void> {
    // Nothing to undo: the duplicates stay resolved. Their FraudFlagResolved events may
    // already have released their holds, and reopening them would bring the duplicates back.
  }
}
