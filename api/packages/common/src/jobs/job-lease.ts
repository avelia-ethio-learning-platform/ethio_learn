import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';
import { requestContext } from '../context';

/**
 * One row per scheduled job (Phase 9c, decision 5): a lease that keeps two runs
 * of a job from overlapping (two instances, or the in-process cron plus the
 * GitHub schedule), and the last run's times and counts for
 * `GET /api/v1/jobs/<service>`. Each service that runs jobs lists this entity
 * and ships the table in its own schema's migration.
 */
@Entity('job_leases')
export class JobLease {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  name!: string;

  /** The lease ends here; null when no run holds it. A crashed run's lease simply expires. */
  @Column({ type: 'timestamptz', nullable: true })
  locked_until!: Date | null;

  /** The run that took the lease; only that run may clear it. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  holder!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_started_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_finished_at!: Date | null;

  /** Counts only, never personal data. `{ failed: true }` when the run threw. */
  @Column({ type: 'jsonb', nullable: true })
  last_result!: JobResult | null;
}

/** What a job reports: counts (or flags), never ids, emails or messages. */
export type JobResult = Record<string, number | boolean>;

export interface JobDefinition {
  /** How long the lease holds; a run that outlives it can be overlapped. */
  ttlMs: number;
  run: () => Promise<JobResult | null | void>;
}

export type JobStart = { started: false } | { started: true; finished: Promise<JobResult | null> };

export interface JobStatus {
  name: string;
  last_started_at: Date | null;
  last_finished_at: Date | null;
  last_result: JobResult | null;
  running: boolean;
}

const tableOf = (dataSource: DataSource) => dataSource.getRepository(JobLease).metadata.tablePath;

/**
 * Takes the job's lease and, when it got it, starts `fn` without awaiting it.
 * One statement decides the winner: the upsert updates the row only when no
 * unexpired lease is on it. No connection is held while the job runs.
 * `finished` never rejects: a failed run is logged and recorded as `{ failed: true }`.
 */
export async function startJob(
  dataSource: DataSource,
  name: string,
  ttlMs: number,
  fn: () => Promise<JobResult | null | void>,
  logger = new Logger('Jobs'),
): Promise<JobStart> {
  const table = tableOf(dataSource);
  const holder = randomUUID();
  const won: unknown[] = await dataSource.query(
    `INSERT INTO ${table} AS l (name, locked_until, holder, last_started_at) VALUES ($1, now() + make_interval(secs => $2), $3, now())
     ON CONFLICT (name) DO UPDATE SET locked_until = EXCLUDED.locked_until, holder = EXCLUDED.holder, last_started_at = EXCLUDED.last_started_at
     WHERE l.locked_until IS NULL OR l.locked_until < now()
     RETURNING l.name`,
    [name, ttlMs / 1000, holder],
  );
  if (won.length === 0) return { started: false };

  // Its own id, not the scheduler call's (9d): the run's lines, calls and events share the lease holder.
  const finished = requestContext.run({ request_id: holder }, async (): Promise<JobResult | null> => {
    let result: JobResult | null;
    try {
      result = (await fn()) ?? null;
    } catch (err) {
      logger.error(`job ${name} failed: ${(err as Error)?.message ?? err}`);
      result = { failed: true };
    }
    try {
      // Only this run's own lease: a run that outlived its TTL leaves the newer holder alone.
      const released = await dataSource.query(
        `UPDATE ${table} SET locked_until = NULL, last_finished_at = now(), last_result = $3 WHERE name = $1 AND holder = $2`,
        [name, holder, result === null ? null : JSON.stringify(result)],
      );
      if (affectedRows(released) === 0) logger.warn(`job ${name} outlived its lease; a newer run holds it, so this result is not recorded`);
    } catch (err) {
      logger.warn(`job ${name}: could not release its lease, it expires on its own: ${(err as Error)?.message ?? err}`);
    }
    return result;
  });
  return { started: true, finished };
}

/** Takes the lease and awaits the run: the result, or null when another run holds the lease. */
export async function runJob(dataSource: DataSource, name: string, ttlMs: number, fn: () => Promise<JobResult | null | void>): Promise<JobResult | null> {
  const start = await startJob(dataSource, name, ttlMs, fn);
  return start.started ? start.finished : null;
}

/** TypeORM's query() resolves an UPDATE under pg to [rows, rowCount]. */
function affectedRows(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}

/**
 * A service's named jobs, for its crons and its JobsController. Crons call `run`
 * (awaited); the endpoint calls `start` and answers before the job finishes.
 */
export class JobRunner {
  private readonly logger: Logger;

  constructor(
    private readonly dataSource: DataSource,
    private readonly jobs: Record<string, JobDefinition>,
    service: string,
  ) {
    this.logger = new Logger(`${service}Jobs`);
  }

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.jobs, name);
  }

  start(name: string): Promise<JobStart> {
    const job = this.jobs[name];
    return startJob(this.dataSource, name, job.ttlMs, job.run, this.logger);
  }

  /** For the in-process crons: never throws, so a failed lease query doesn't leave an unhandled rejection. */
  async run(name: string): Promise<JobResult | null> {
    try {
      const start = await this.start(name);
      if (!start.started) {
        this.logger.log(`job ${name} skipped: another run holds its lease`);
        return null;
      }
      return await start.finished;
    } catch (err) {
      this.logger.error(`job ${name} could not start: ${(err as Error)?.message ?? err}`);
      return null;
    }
  }

  /** Each job's last run, from the lease rows; a job that never ran shows nulls. */
  async status(): Promise<JobStatus[]> {
    const rows: Array<Omit<JobStatus, 'running'> & { running: boolean }> = await this.dataSource.query(
      `SELECT name, last_started_at, last_finished_at, last_result, (locked_until IS NOT NULL AND locked_until > now()) AS running FROM ${tableOf(this.dataSource)}`,
    );
    const byName = new Map(rows.map((r) => [r.name, r]));
    return Object.keys(this.jobs).map(
      (name) => byName.get(name) ?? { name, last_started_at: null, last_finished_at: null, last_result: null, running: false },
    );
  }
}
