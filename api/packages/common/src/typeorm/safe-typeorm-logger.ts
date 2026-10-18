import { Logger } from '@nestjs/common';
import type { Logger as TypeOrmLogger, LoggerOptions } from 'typeorm';

const SQL_MAX = 1000;

function sql(query: string): string {
  const flat = query.replace(/\s+/g, ' ').trim();
  return flat.length > SQL_MAX ? `${flat.slice(0, SQL_MAX)}…` : flat;
}

/**
 * TypeORM's logger for every service (Phase 9d). It never prints parameter
 * values (emails, password hashes, reset tokens) and never a query error's
 * `message`, which Postgres builds from the input (`invalid input syntax for
 * type uuid: "<value>"`). It honours `logging` the way TypeORM's own loggers
 * do, since TypeORM calls a custom logger whatever `logging` says:
 * - a slow query is always logged, as its duration and SQL;
 * - query errors only with `error` (DB_LOGGING=true): the SQLSTATE code, the
 *   constraint and the SQL. Otherwise Nest's exception handler and
 *   DbErrorFilter report them, and expected unique violations stay quiet;
 * - each query only with `query` (DB_LOGGING=true), as SQL.
 * Pass the same `logging` the data source gets; a caller that overrides
 * `logging` overrides `logger` too.
 */
export class SafeTypeOrmLogger implements TypeOrmLogger {
  private readonly logger: Logger;

  constructor(
    schema: string,
    private readonly logging: LoggerOptions,
  ) {
    this.logger = new Logger(`TypeORM:${schema}`);
  }

  /** TypeORM's parameters are left out of the signatures: never printed, the point of this logger. */
  logQuery(query: string): void {
    if (this.enabled('query')) this.logger.log(sql(query));
  }

  logQueryError(error: string | Error, query: string): void {
    if (!this.enabled('error')) return;
    const { code, constraint } = (typeof error === 'object' && error ? error : {}) as { code?: string; constraint?: string };
    this.logger.error(`query failed (${code ?? 'no code'}${constraint ? `, constraint ${constraint}` : ''}): ${sql(query)}`);
  }

  logQuerySlow(time: number, query: string): void {
    this.logger.warn(`slow query ${time} ms: ${sql(query)}`);
  }

  logSchemaBuild(message: string): void {
    if (this.enabled('schema')) this.logger.log(message);
  }

  logMigration(message: string): void {
    this.logger.log(message);
  }

  log(level: 'log' | 'info' | 'warn', message: unknown): void {
    if (!this.enabled(level)) return;
    if (level === 'warn') this.logger.warn(String(message));
    else this.logger.log(String(message));
  }

  /** As TypeORM's AbstractLogger decides it. */
  private enabled(kind: 'query' | 'error' | 'schema' | 'log' | 'info' | 'warn'): boolean {
    if (this.logging === 'all') return true;
    if (this.logging === true) return kind === 'query' || kind === 'error';
    return Array.isArray(this.logging) && (this.logging as string[]).includes(kind);
  }
}
