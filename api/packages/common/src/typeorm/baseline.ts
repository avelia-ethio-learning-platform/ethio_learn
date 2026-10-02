import type { QueryRunner } from 'typeorm';

export type BaselineState = 'empty' | 'present';

/**
 * Decides what a service's baseline migration does on the database it meets.
 *
 * Production (and every local database) was built by `synchronize` before
 * migrations existed, so the baseline must record itself there without running
 * any DDL, yet still build the whole schema on an empty database (CI, a new
 * developer). A schema holding only some of the baseline tables is neither:
 * running the DDL would fail halfway and skipping it would record a schema that
 * isn't there, so that case throws and names what is missing.
 *
 * `tables` is the baseline's own fixed list, never the live entity metadata:
 * a table added by a later migration must not make an older database look
 * half-built.
 */
export async function baselineState(
  queryRunner: Pick<QueryRunner, 'query'>,
  schema: string,
  tables: readonly string[],
): Promise<BaselineState> {
  // pg_catalog rather than information_schema: the latter hides tables the
  // connecting role has no privileges on, which would read as "missing".
  const rows: Array<{ relname: string }> = await queryRunner.query(
    `SELECT c.relname FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname = ANY($2)`,
    [schema, tables],
  );
  const found = new Set(rows.map((r) => r.relname));
  if (found.size === 0) return 'empty';
  if (found.size === tables.length) return 'present';
  const missing = tables.filter((t) => !found.has(t));
  throw new Error(
    `Schema "${schema}" is partially built: ${found.size} of ${tables.length} baseline tables exist, ` +
      `missing: ${missing.join(', ')}. Restore the missing tables (or empty the schema) before this service can migrate.`,
  );
}

/**
 * Guards a baseline's `down()`. On production the baseline was recorded over
 * tables it never created, so reverting it would drop every table in the
 * schema and all its data. Local resets opt in with ALLOW_BASELINE_REVERT=1.
 */
export function assertBaselineRevertAllowed(schema: string): void {
  if (process.env.ALLOW_BASELINE_REVERT !== '1') {
    throw new Error(
      `Refusing to revert the "${schema}" baseline: it drops every table in the schema. ` +
        `Set ALLOW_BASELINE_REVERT=1 only against a disposable local database.`,
    );
  }
}
