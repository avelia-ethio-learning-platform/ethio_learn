import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { envBool, envInt, envOrLocalDefault } from '../config/env';

/**
 * Schema-per-service on a single PostgreSQL instance (spec §4.4).
 * Schemas are created by docker/postgres-init.sql; TypeORM owns the tables.
 */
export function buildTypeOrmOptions(schema: string, entities: TypeOrmModuleOptions['entities']): TypeOrmModuleOptions {
  const url = envOrLocalDefault('DATABASE_URL', 'postgres://ethiopialearn:ethiopialearn@localhost:5432/ethiopialearn');
  // Managed Postgres (Neon, RDS, Supabase) requires TLS. Inferred from the
  // connection string so `?sslmode=require` alone is enough; DB_SSL overrides
  // either way. Managed providers terminate TLS with their own chain, so cert
  // verification is opt-in via DB_SSL_STRICT rather than on by default.
  const sslEnabled = process.env.DB_SSL ? envBool('DB_SSL', false) : /sslmode=(require|verify)/.test(url);
  return {
    type: 'postgres',
    url,
    schema,
    entities,
    ...(sslEnabled ? { ssl: { rejectUnauthorized: envBool('DB_SSL_STRICT', false) } } : {}),
    // Dev convenience only. TODO(spec-open-question): replace with generated
    // migrations before any production deploy.
    synchronize: envBool('DB_SYNC', true),
    uuidExtension: 'pgcrypto',
    logging: envBool('DB_LOGGING', false),
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
