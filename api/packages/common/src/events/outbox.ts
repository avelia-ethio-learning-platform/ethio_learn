import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { Column, DataSource, Entity, EntityManager, Index, PrimaryColumn } from 'typeorm';
import { EventType } from '@ethiopialearn/contracts';
import { envInt } from '../config/env';
import { EventBusService } from './event-bus.service';

/**
 * An event committed with the state change it announces, waiting to be published.
 * Each service that emits through the outbox lists this entity and ships the table
 * in its own schema's migration. `id` is the event's `event_id`, so every re-send
 * carries the same id and the consumers' dedupe (9a) absorbs it.
 */
@Entity('outbox')
@Index('IDX_outbox_unpublished', ['created_at'], { where: '"published_at" IS NULL' })
export class OutboxEvent {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  event_type!: string;

  @Column({ type: 'jsonb' })
  payload!: unknown;

  @Column({ type: 'uuid', nullable: true })
  correlation_id!: string | null;

  /** clock_timestamp(): the time of the insert, not of the transaction's start, so emits keep their order. */
  @Column({ type: 'timestamptz', default: () => 'clock_timestamp()' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  published_at!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  last_error!: string | null;
}

/** Queues an event to commit with the surrounding outbox transaction. */
export type Emit = <P>(eventType: EventType, payload: P, opts?: { correlationId?: string }) => void;

interface OutboxRow {
  id: string;
  event_type: EventType;
  payload: unknown;
  correlation_id: string | null;
  created_at: Date;
  attempts: number;
}

/**
 * Set while the body of a transaction that runOnce or outbox.transaction owns is running.
 * Both open their own transaction on a fresh connection, so an outbox transaction started
 * inside one would commit on its own, and its events could go out for a state change that
 * then rolls back.
 */
const transactionScope = new AsyncLocalStorage<true>();

/** Runs `fn` as the body of a transaction that common's helpers own. */
export function inTransactionScope<T>(fn: () => Promise<T>): Promise<T> {
  return transactionScope.run(true, fn);
}

const RELAY_BATCH = 50;
const CLEANUP_BATCH = 500;
const CLEANUP_EVERY_MS = 60 * 60_000;
const STALE_MS = 10 * 60_000;
const FAILURES_BEFORE_ERROR = 20;

/**
 * The transactional outbox (Phase 9b). `transaction` commits events with the
 * state change they announce. After commit, a detached fast path publishes them
 * right away, and an in-service relay sends anything left over, in order:
 *
 * - The fast path is skipped while the broker is down, and when an older row is
 *   still unpublished (the relay keeps the order). A request never waits for it.
 * - The relay ticks every OUTBOX_POLL_MS. It holds no lock and no transaction
 *   while publishing, and stops its batch at the first failure, so a newer event
 *   never overtakes an older one. A row that can never be published blocks the
 *   queue by design: see the "Outbox" runbook in docs/DEPLOYMENT.md.
 * - Published rows are deleted after OUTBOX_RETENTION_DAYS.
 *
 * Order holds for sequential transactions in one service. Overlapping ones have
 * no defined order, and no consumer relies on one.
 */
@Injectable()
export class OutboxService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxService.name);
  private readonly pollMs = envInt('OUTBOX_POLL_MS', 5_000);
  private readonly retentionDays = envInt('OUTBOX_RETENTION_DAYS', 7);
  private timer?: NodeJS.Timeout;
  private relaying = false;
  private lastCleanup = 0;

  constructor(
    private readonly dataSource: DataSource,
    private readonly bus: EventBusService,
  ) {}

  /**
   * Runs `fn` in a transaction. Events queued with `emit` are inserted at the end of
   * `fn`, in emit order, and commit with its writes, or roll back with them.
   * Refuses to run inside runOnce or another outbox transaction: emit after it commits.
   */
  async transaction<T>(fn: (manager: EntityManager, emit: Emit) => Promise<T>): Promise<T> {
    if (transactionScope.getStore()) {
      throw new Error('outbox.transaction cannot run inside another transaction (runOnce or outbox.transaction): emit after it commits');
    }
    const emitted: OutboxRow[] = [];
    const result = await this.dataSource.transaction((manager) =>
      inTransactionScope(async () => {
        const queued: Array<{ eventType: EventType; payload: unknown; correlationId: string | null }> = [];
        const emit: Emit = (eventType, payload, opts = {}) => {
          queued.push({ eventType, payload, correlationId: opts.correlationId ?? null });
        };
        const value = await fn(manager, emit);
        for (const event of queued) {
          const id = randomUUID();
          const [row]: Array<{ created_at: Date }> = await manager.query(
            `INSERT INTO ${this.table} (id, event_type, payload, correlation_id) VALUES ($1, $2, $3, $4) RETURNING created_at`,
            [id, event.eventType, JSON.stringify(event.payload), event.correlationId],
          );
          emitted.push({ id, event_type: event.eventType, payload: event.payload, correlation_id: event.correlationId, created_at: row.created_at, attempts: 0 });
        }
        return value;
      }),
    );
    if (emitted.length > 0) void this.fastPath(emitted);
    return result;
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.relay(), this.pollMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** One relay tick: sends unpublished rows in order, warns about stale ones, and cleans up hourly. Never throws. */
  async relay(): Promise<void> {
    if (this.relaying) return;
    this.relaying = true;
    try {
      const rows: OutboxRow[] = await this.dataSource.query(
        `SELECT id, event_type, payload, correlation_id, created_at, attempts FROM ${this.table} WHERE published_at IS NULL ORDER BY created_at, id LIMIT ${RELAY_BATCH}`,
      );
      const stale = rows.filter((row) => Date.now() - new Date(row.created_at).getTime() > STALE_MS).length;
      if (stale > 0) {
        this.logger.warn(`outbox relay: ${stale === RELAY_BATCH ? `${stale}+` : stale} event(s) older than 10 min still unpublished`);
      }
      // While the broker is down, a publish only waits and fails: leave the rows, uncounted.
      if (this.bus.isConnected()) {
        for (const row of rows) if (!(await this.send(row))) break;
      }
      if (Date.now() - this.lastCleanup >= CLEANUP_EVERY_MS) {
        this.lastCleanup = Date.now();
        await this.dataSource.query(
          `DELETE FROM ${this.table} WHERE ctid IN (SELECT ctid FROM ${this.table} WHERE published_at < now() - make_interval(days => $1) LIMIT ${CLEANUP_BATCH})`,
          [this.retentionDays],
        );
      }
    } catch (err) {
      this.logger.warn(`outbox relay tick failed: ${errorText(err)}`);
    } finally {
      this.relaying = false;
    }
  }

  /** Publishes a committed transaction's rows, unless the broker is down or an older row waits. Never throws. */
  private async fastPath(rows: OutboxRow[]): Promise<void> {
    try {
      if (!this.bus.isConnected()) return;
      const older: unknown[] = await this.dataSource.query(
        `SELECT 1 FROM ${this.table} o WHERE o.published_at IS NULL AND (o.created_at, o.id) < (SELECT created_at, id FROM ${this.table} WHERE id = $1) LIMIT 1`,
        [rows[0].id],
      );
      if (older.length > 0) return;
      for (const row of rows) if (!(await this.send(row))) return;
    } catch (err) {
      this.logger.warn(`outbox fast path failed, the relay will send the rest: ${errorText(err)}`);
    }
  }

  /** Publishes one row with its id as the event id and marks it published. False when the publish failed. */
  private async send(row: OutboxRow): Promise<boolean> {
    try {
      await this.bus.publishConfirmed(row.event_type, row.payload, { eventId: row.id, correlationId: row.correlation_id ?? undefined });
    } catch (err) {
      const message = errorText(err);
      await this.dataSource.query(`UPDATE ${this.table} SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [row.id, message]);
      if (row.attempts + 1 === FAILURES_BEFORE_ERROR) {
        this.logger.error(`outbox row ${row.id} (${row.event_type}) failed ${FAILURES_BEFORE_ERROR} times: ${message}`);
      }
      return false;
    }
    await this.dataSource.query(`UPDATE ${this.table} SET published_at = now() WHERE id = $1 AND published_at IS NULL`, [row.id]);
    return true;
  }

  private get table(): string {
    return this.dataSource.getRepository(OutboxEvent).metadata.tablePath;
  }
}

function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 500);
}
