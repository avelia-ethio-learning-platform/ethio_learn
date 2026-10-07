import { Column, DataSource, Entity, EntityManager, PrimaryColumn } from 'typeorm';
import { envInt } from '../config/env';
import { inTransactionScope } from './outbox';

/**
 * One row per (handler, event) that ran its effect: the dedupe marker for
 * `runOnce`. Each service that dedupes lists this entity and ships the table
 * in its own schema's migration.
 */
@Entity('processed_events')
export class ProcessedEvent {
  /** The handler's stable name, as given to `subscribe(…, { name })`. */
  @PrimaryColumn({ type: 'varchar', length: 120 })
  consumer!: string;

  @PrimaryColumn('uuid')
  event_id!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  processed_at!: Date;

  /** The effect's small result (e.g. `{ item_id }`), handed back to a redelivery so it can resume. */
  @Column({ type: 'jsonb', nullable: true })
  result!: unknown;
}

export interface RunOnceResult<T> {
  /** False when this (consumer, event) already ran: `fn` was skipped and `result` is what it stored. */
  ran: boolean;
  result: T | null;
}

/** About one call in this many also deletes old markers, so the table stays small without a scheduler. */
const PRUNE_ONE_IN = 1000;
const PRUNE_BATCH = 1000;

/**
 * Runs `fn` at most once per (consumer, event id). The marker, `fn`'s writes
 * and its stored result commit in one transaction, so a crash between them
 * repeats neither. A concurrent duplicate waits on the marker's primary key
 * until the first commits, then skips.
 *
 * `consumer` must be the handler's explicit, stable name: a positional default
 * shifts when a handler is added ahead of it, and a redelivery after that
 * deploy would run the effect again.
 */
export async function runOnce<T>(
  dataSource: DataSource,
  consumer: string,
  eventId: string,
  fn: (manager: EntityManager) => Promise<T>,
): Promise<RunOnceResult<T>> {
  if (!consumer) throw new Error('runOnce needs the handler’s explicit name (subscribe(…, { name }))');
  if (!eventId) throw new Error(`runOnce (${consumer}) needs the event id`);
  return dataSource.transaction((manager) =>
    inTransactionScope(async () => {
      const table = manager.getRepository(ProcessedEvent).metadata.tablePath;
      const inserted: unknown[] = await manager.query(
        `INSERT INTO ${table} (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1`,
        [consumer, eventId],
      );
      if (inserted.length === 0) {
        const rows: { result: T | null }[] = await manager.query(`SELECT result FROM ${table} WHERE consumer = $1 AND event_id = $2`, [
          consumer,
          eventId,
        ]);
        return { ran: false, result: rows[0]?.result ?? null };
      }
      const result = await fn(manager);
      if (result !== undefined && result !== null) {
        await manager.query(`UPDATE ${table} SET result = $3 WHERE consumer = $1 AND event_id = $2`, [consumer, eventId, JSON.stringify(result)]);
      }
      if (Math.random() < 1 / PRUNE_ONE_IN) {
        const days = envInt('PROCESSED_EVENTS_RETENTION_DAYS', 30);
        await manager.query(
          `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE processed_at < now() - make_interval(days => $1) LIMIT ${PRUNE_BATCH})`,
          [days],
        );
      }
      return { ran: true, result: result ?? null };
    }),
  );
}
