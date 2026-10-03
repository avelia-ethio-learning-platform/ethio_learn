import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { EventEnvelope, EventType } from '@ethiopialearn/contracts';
import { ProcessedEvent } from '@ethiopialearn/common';
import { PayeeStats } from '../entities';

type Stats = { payments: number; refunds: number; completions: number };

/**
 * A DataSource for the quality specs: `transaction` hands the given repos to the callback
 * (no isolation, no rollback), and `query` speaks the two raw statements the service sends,
 * runOnce's processed_events and the payee_stats upsert.
 */
export function fakeDataSource(repos: Map<unknown, unknown>) {
  const processed = new Map<string, unknown>();
  const stats = new Map<string, Stats>();
  const key = (params: unknown[]) => `${params[0]}|${params[1]}`;
  const manager = {
    getRepository: (entity: unknown) => {
      if (entity === ProcessedEvent) return { metadata: { tablePath: 'quality.processed_events' } };
      if (entity === PayeeStats) return { metadata: { tablePath: 'quality.payee_stats' } };
      const repo = repos.get(entity);
      if (!repo) throw new Error(`fake data source: no repo for ${String((entity as { name?: string })?.name ?? entity)}`);
      return repo;
    },
    query: jest.fn(async (sql: string, params: unknown[]) => {
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
      throw new Error(`fake data source: unexpected query ${sql}`);
    }),
  };
  const dataSource = { transaction: <T>(fn: (m: typeof manager) => Promise<T>) => fn(manager) } as unknown as DataSource;
  return { dataSource, manager, processed, stats };
}

/** An envelope as the bus delivers it: a fresh event id unless the test redelivers one. */
export function envelopeFor<P>(type: EventType, payload: P, eventId: string = randomUUID()): EventEnvelope<P> {
  return { event_type: type, payload, metadata: { event_id: eventId, timestamp: new Date().toISOString(), producer_service: 'test', correlation_id: eventId } };
}
