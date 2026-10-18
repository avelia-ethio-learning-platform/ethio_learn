import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { EventEnvelope, EventType, FraudSignalStatus } from '@ethiopialearn/contracts';
import { OutboxEvent, ProcessedEvent } from '@ethiopialearn/common';
import { FraudSignal, PayeeStats } from '../entities';

type Stats = { payments: number; refunds: number; completions: number };
type Row = Record<string, any>;
/** A quality.outbox row, its payload parsed back. */
export type OutboxRow = { id: string; event_type: string; payload: Row; correlation_id: string | null; created_at: Date; published_at: Date | null };

/** quality.fraud_signals: the rows the raise inserts and resolveFlag reads and saves. */
function fraudSignalsRepo() {
  const rows: Row[] = [];
  const find = (where: Row) => rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
  return {
    rows,
    metadata: { tablePath: 'quality.fraud_signals' },
    findOne: jest.fn(async ({ where }: { where: Row }) => {
      const row = find(where);
      return row ? { ...row } : null;
    }),
    findOneOrFail: jest.fn(async ({ where }: { where: Row }) => {
      const row = find(where);
      if (!row) throw new Error('fake fraud_signals: no matching row');
      return { ...row };
    }),
    save: jest.fn(async (x: Row) => {
      const i = rows.findIndex((r) => r.id === x.id);
      if (i >= 0) rows[i] = { ...x };
      else rows.push({ ...x });
      return x;
    }),
  };
}

/**
 * A DataSource for the quality specs, also good for a real OutboxService. `query` speaks the
 * raw statements the service and common's helpers send: runOnce's processed_events, the
 * payee_stats upsert, the fraud raise (with the open-signal unique index), and the outbox's
 * insert, relay read, mark and cleanup.
 *
 * `transaction` hands the given repos to the callback, with no isolation. When it throws, the
 * fake tables and the rows of every repo that keeps `rows` go back to where they were, as a
 * rollback would. Concurrent transactions see each other's writes, so a spec that makes one
 * fail runs it alone. Set `failNextOutboxInsert` to make the next outbox insert throw, as a
 * database error before commit would.
 */
export function fakeDataSource(repos: Map<unknown, unknown>) {
  const processed = new Map<string, unknown>();
  const stats = new Map<string, Stats>();
  const fraudSignals = fraudSignalsRepo();
  const outbox: OutboxRow[] = [];
  const opts = { failNextOutboxInsert: false };
  const key = (params: unknown[]) => `${params[0]}|${params[1]}`;
  const manager = {
    getRepository: (entity: unknown) => {
      if (entity === ProcessedEvent) return { metadata: { tablePath: 'quality.processed_events' } };
      if (entity === PayeeStats) return { metadata: { tablePath: 'quality.payee_stats' } };
      if (entity === OutboxEvent) return { metadata: { tablePath: 'quality.outbox' } };
      if (entity === FraudSignal) return fraudSignals;
      const repo = repos.get(entity);
      if (!repo) throw new Error(`fake data source: no repo for ${String((entity as { name?: string })?.name ?? entity)}`);
      return repo;
    },
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('processed_events')) {
        if (sql.startsWith('INSERT')) {
          if (processed.has(key(params))) return [];
          processed.set(key(params), null);
          return [{}];
        }
        if (sql.startsWith('SELECT')) return processed.has(key(params)) ? [{ result: processed.get(key(params)) }] : [];
        if (sql.startsWith('UPDATE')) processed.set(key(params), JSON.parse(params[2] as string));
        return [];
      }
      if (sql.includes('payee_stats')) {
        const [payeeId, payments, refunds, completions] = params as [string, number, number, number];
        const row = stats.get(payeeId) ?? { payments: 0, refunds: 0, completions: 0 };
        stats.set(payeeId, { payments: row.payments + payments, refunds: row.refunds + refunds, completions: row.completions + completions });
        return [];
      }
      if (sql.startsWith('INSERT INTO quality.fraud_signals')) {
        const [subject_type, subject_id, signal_type, detail, payee_id, status] = params as string[];
        const open = { subject_type, subject_id, signal_type, status: FraudSignalStatus.OPEN };
        if (status === FraudSignalStatus.OPEN && fraudSignals.rows.some((r) => Object.entries(open).every(([k, v]) => r[k] === v))) return [];
        const row = { id: randomUUID(), subject_type, subject_id, signal_type, detail, payee_id, status, created_at: new Date(), resolved_at: null, resolved_by: null };
        fraudSignals.rows.push(row);
        return [{ ...row }];
      }
      if (sql.includes('quality.outbox')) {
        if (sql.startsWith('INSERT')) {
          if (opts.failNextOutboxInsert) {
            opts.failNextOutboxInsert = false;
            throw new Error('outbox insert failed');
          }
          const [id, event_type, payload, correlation_id] = params as string[];
          const row = { id, event_type, payload: JSON.parse(payload), correlation_id, created_at: new Date(), published_at: null };
          outbox.push(row);
          return [{ created_at: row.created_at }];
        }
        // The relay's read, its mark after a publish, and its cleanup.
        if (sql.startsWith('SELECT id')) return outbox.filter((r) => !r.published_at).map((r) => ({ ...r, attempts: 0 }));
        if (sql.startsWith('UPDATE') && sql.includes('SET published_at = now()')) {
          const row = outbox.find((r) => r.id === params[0] && !r.published_at);
          if (row) row.published_at = new Date();
          return [];
        }
        if (sql.startsWith('DELETE')) return [];
      }
      throw new Error(`fake data source: unexpected query ${sql}`);
    }),
  };
  const restore = <V>(live: Map<string, V>, saved: Map<string, V>) => {
    live.clear();
    saved.forEach((v, k) => live.set(k, v));
  };
  const transaction = async <T>(fn: (m: typeof manager) => Promise<T>): Promise<T> => {
    const repoRows = [...repos.values()].map((repo) => (repo as { rows?: Row[] }).rows).filter((rows): rows is Row[] => Array.isArray(rows));
    const tables: Row[][] = [fraudSignals.rows, outbox, ...repoRows];
    const before = { tables: tables.map((rows) => rows.map((r) => ({ ...r }))), processed: new Map(processed), stats: new Map(stats) };
    try {
      return await fn(manager);
    } catch (err) {
      tables.forEach((rows, i) => rows.splice(0, rows.length, ...before.tables[i]));
      restore(processed, before.processed);
      restore(stats, before.stats);
      throw err;
    }
  };
  const dataSource = { transaction, query: manager.query, getRepository: manager.getRepository } as unknown as DataSource;
  return { dataSource, manager, processed, stats, fraudSignals, outbox, opts };
}

/** An envelope as the bus delivers it: a fresh event id unless the test redelivers one. */
export function envelopeFor<P>(type: EventType, payload: P, eventId: string = randomUUID()): EventEnvelope<P> {
  return { event_type: type, payload, metadata: { event_id: eventId, timestamp: new Date().toISOString(), producer_service: 'test', correlation_id: eventId } };
}
