import { Logger } from '@nestjs/common';
import type { MigrationInterface } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { envBool, envInt, envOrLocalDefault } from '../config/env';

export type MigrationClass = new () => MigrationInterface;

/**
 * Schema-per-service on a single PostgreSQL instance (spec §4.4).
 * Schemas are created by docker/postgres-init.sql; each service's versioned
 * migrations (src/migrations) own the tables and run on boot, before the
 * service listens.
 *
 * `migrations` is an explicit class list rather than a glob: dev runs
 * ts-node on src/ and production runs dist/, and imported classes resolve in
 * both (and in the CLI and jest).
 */
export function buildTypeOrmOptions(
  schema: string,
  entities: PostgresConnectionOptions['entities'],
  migrations: MigrationClass[],
): PostgresConnectionOptions {
  const url = envOrLocalDefault('DATABASE_URL', 'postgres://ethiopialearn:ethiopialearn@localhost:5432/ethiopialearn');
  // Managed Postgres (Neon, RDS, Supabase) requires TLS. Inferred from the
  // connection string so `?sslmode=require` alone is enough; DB_SSL overrides
  // either way. Managed providers terminate TLS with their own chain, so cert
  // verification is opt-in via DB_SSL_STRICT rather than on by default.
  const sslEnabled = process.env.DB_SSL ? envBool('DB_SSL', false) : /sslmode=(require|verify)/.test(url);
  // `synchronize` used to be switchable through DB_SYNC (default on), and that
  // switch is how it reached production, where an entity edit can drop a live
  // column. There is no way back: schema changes ship as migrations.
  if (envBool('DB_SYNC', false)) {
    Logger.warn('DB_SYNC is ignored; schema changes go through migrations (README: "Changing the schema")', 'TypeORM');
  }
  return {
    type: 'postgres',
    url,
    schema,
    entities,
    migrations,
    ...(sslEnabled ? { ssl: { rejectUnauthorized: envBool('DB_SSL_STRICT', false) } } : {}),
    synchronize: false,
    // Pending migrations run inside DataSource.initialize(), so a service only
    // starts listening (and passes its health check) once its schema is current.
    migrationsRun: true,
    // One transaction per migration, so a migration can opt out with
    // `transaction = false` (CREATE INDEX CONCURRENTLY). Under the default
    // 'all', any such migration makes the whole run throw.
    migrationsTransactionMode: 'each',
    uuidExtension: 'pgcrypto',
    // 'schema' is what prints "Migration … has been executed successfully" at
    // boot; with synchronize off it emits nothing else. Not 'error': the
    // default logger prints a failing query with its parameter values, which
    // would put emails and password hashes into the logs. Migration failures
    // and slow-query warnings print regardless.
    logging: envBool('DB_LOGGING', false) ? true : ['schema'],
    // Warn on any query slower than 500ms so bottlenecks surface under load.
    maxQueryExecutionTime: envInt('DB_SLOW_QUERY_MS', 500),
    // Connection pool tuning for 1000+ concurrent users. Each of the ~7 services
    // keeps its own bounded pool; total stays well under Postgres max_connections.
    extra: {
      max: envInt('DB_POOL_MAX', 20),
      min: envInt('DB_POOL_MIN', 2),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: `el-${schema}`,
    },
  };
}
