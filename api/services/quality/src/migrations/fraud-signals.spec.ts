import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';
import { FraudFlagPayload } from '@ethiopialearn/contracts';
import { FraudSignalDedupe1791060000000 } from './1791060000000-FraudSignalDedupe';
import { FraudSignalOpenUnique1791060000001 } from './1791060000001-FraudSignalOpenUnique';
import { migrations } from './index';

/** Records every statement. The dedupe returns one row per outbox row it inserted, as Postgres does: `resolved` of them. */
function recorder(resolved = 0) {
  const sql: string[] = [];
  const query = jest.fn(async (statement: string) => {
    sql.push(statement);
    return statement.includes(`'FraudFlagResolved'`) ? Array.from({ length: resolved }, (_, i) => ({ id: `outbox-${i}` })) : [];
  });
  return { sql, queryRunner: { query } as unknown as QueryRunner };
}

/** resolveFlag's FraudFlagResolved payload is a FraudFlagPayload; the type keeps this list to exactly its keys. */
const PAYLOAD_KEYS: Record<keyof FraudFlagPayload, true> = { flag_id: true, subject_type: true, subject_id: true, signal_type: true, payee_id: true, detail: true };

describe('FraudSignalDedupe migration', () => {
  it('resolves every open duplicate but the oldest per (subject_type, subject_id, signal_type), in one statement', async () => {
    const { sql, queryRunner } = recorder();
    await new FraudSignalDedupe1791060000000().up(queryRunner);

    expect(sql).toHaveLength(1);
    const [dedupe] = sql;
    expect(dedupe).toContain(`row_number() OVER (PARTITION BY subject_type, subject_id, signal_type ORDER BY created_at, id) AS n`);
    expect(dedupe).toContain(`FROM "quality"."fraud_signals" WHERE status = 'open'`);
    expect(dedupe).toContain(`SET status = 'resolved', resolved_at = now(), detail = trim(s.detail || ' (duplicate)')`);
    // n = 1 is the oldest, kept open; a signal resolved meanwhile is skipped, so it gets no second event.
    expect(dedupe).toContain(`WHERE s.id = r.id AND r.n > 1 AND s.status = 'open'`);
  });

  it('inserts one FraudFlagResolved outbox row per resolved duplicate, in the payload shape resolveFlag emits', async () => {
    const { sql, queryRunner } = recorder();
    await new FraudSignalDedupe1791060000000().up(queryRunner);
    const [dedupe] = sql;

    // The INSERT is the top-level command and selects from the UPDATE's RETURNING: one outbox row per resolved signal.
    const insert = dedupe.match(
      /\)\s+INSERT INTO "quality"\."outbox" \(id, event_type, payload\)\s+SELECT gen_random_uuid\(\), 'FraudFlagResolved', jsonb_build_object\(([^)]*)\)\s+FROM resolved\s+RETURNING id$/,
    );
    expect(insert).not.toBeNull();
    const pairs = [...insert![1].matchAll(/'(\w+)', (\w+)/g)].map(([, key, column]) => [key, column]);
    expect(pairs).toEqual([
      ['flag_id', 'id'],
      ['subject_type', 'subject_type'],
      ['subject_id', 'subject_id'],
      ['signal_type', 'signal_type'],
      ['payee_id', 'payee_id'],
      ['detail', 'detail'],
    ]);
    expect(pairs.map(([key]) => key).sort()).toEqual(Object.keys(PAYLOAD_KEYS).sort());
    // Every column the payload reads comes back from the resolved rows (detail with its " (duplicate)").
    expect(dedupe).toContain('RETURNING s.id, s.subject_type, s.subject_id, s.signal_type, s.payee_id, s.detail');
  });

  it('logs how many it resolved: the rows the INSERT returns, one per outbox row', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const { queryRunner } = recorder(3);
      await new FraudSignalDedupe1791060000000().up(queryRunner);
      expect(log).toHaveBeenCalledWith('resolved 3 duplicate open fraud signal(s), each with a FraudFlagResolved outbox row');
    } finally {
      log.mockRestore();
    }
  });

  it('down() leaves the data as it is', async () => {
    const { sql, queryRunner } = recorder();
    const migration: MigrationInterface = new FraudSignalDedupe1791060000000();
    await migration.down(queryRunner);
    expect(sql).toEqual([]);
  });
});

describe('FraudSignalOpenUnique migration', () => {
  it('repeats the dedupe, then drops and builds the partial unique index concurrently, outside a transaction', async () => {
    const migration = new FraudSignalOpenUnique1791060000001();
    expect(migration.transaction).toBe(false);

    const dedupe = recorder();
    await new FraudSignalDedupe1791060000000().up(dedupe.queryRunner);
    const up = recorder();
    await migration.up(up.queryRunner);
    expect(up.sql).toEqual([
      dedupe.sql[0],
      'DROP INDEX CONCURRENTLY IF EXISTS "quality"."IDX_fraud_signals_open_subject_signal"',
      `CREATE UNIQUE INDEX CONCURRENTLY "IDX_fraud_signals_open_subject_signal" ON "quality"."fraud_signals" ("subject_type", "subject_id", "signal_type") WHERE status = 'open'`,
    ]);

    const down = recorder();
    await migration.down(down.queryRunner);
    expect(down.sql).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS "quality"."IDX_fraud_signals_open_subject_signal"']);
  });

  it('both run after the outbox table they write to, dedupe first', () => {
    const names = migrations.map((m) => m.name);
    const from = names.indexOf('Outbox1791054805346');
    expect(from).toBeGreaterThanOrEqual(0);
    expect(names.slice(from)).toEqual(['Outbox1791054805346', 'FraudSignalDedupe1791060000000', 'FraudSignalOpenUnique1791060000001']);
  });
});
