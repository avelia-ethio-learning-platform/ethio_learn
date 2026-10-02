import { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { buildTypeOrmOptions, MigrationClass } from './typeorm';

/**
 * Options for the drift check (`pnpm -C api db:check`), which must never write.
 * The shared options run pending migrations inside initialize(); against
 * production before a deploy that would create the migrations table, record
 * the baseline and build indexes, then report "no drift" because it had just
 * applied its own changes. Extensions are left alone for the same reason.
 */
export function buildSchemaCheckOptions(
  schema: string,
  entities: PostgresConnectionOptions['entities'],
  migrations: MigrationClass[],
): PostgresConnectionOptions {
  const base = buildTypeOrmOptions(schema, entities, migrations);
  return {
    ...base,
    migrationsRun: false,
    synchronize: false,
    installExtensions: false,
    logging: false,
    extra: { ...base.extra, max: 1, min: 0, application_name: `el-${schema}-db-check` },
  };
}

/**
 * The DDL that would bring the database in line with the entities. Read-only:
 * the schema builder only reads the catalog and collects SQL in memory. An
 * empty list means every entity change shipped with its migration.
 */
export async function pendingSchemaChanges(options: PostgresConnectionOptions): Promise<string[]> {
  const dataSource = new DataSource(options);
  await dataSource.initialize();
  try {
    const sql = await dataSource.driver.createSchemaBuilder().log();
    return sql.upQueries.map((q) => q.query);
  } finally {
    await dataSource.destroy();
  }
}
