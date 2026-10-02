# Plan review: Phase 2, schema migrations and `synchronize` off

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)"), against `origin/main` and the installed TypeORM 0.3.30 and @nestjs/typeorm 10.0.2 sources, plus the local database's catalog.

Checked and OK (no action needed):
- `DataSource.initialize()` runs migrations with `migrationsTransactionMode` before any synchronize (`typeorm/data-source/DataSource.js:151-157`).
- `'all'` throws `ForbiddenTransactionModeOverrideError` for any migration that sets `transaction` (`MigrationExecutor.js:179-190`). `'each'` gives every migration its own transaction and honors `transaction = false`. So decision 3 is right.
- `createSchemaBuilder().log()` only collects SQL in memory and executes nothing (`RdbmsSchemaBuilder.js:101-124`). There are no `@ViewEntity`s, so it doesn't create `typeorm_metadata` either.
- The CLI's `migration:generate` and `migration:revert` force `migrationsRun: false`.
- The seed only touches the `auth` schema, so the auth migrations are enough for it (decision 6).
- The redundant indexes in decision 8 exist locally as described (checked in `pg_indexes`).
- Nest's TypeORM module retries `initialize()` 9 times, 3 s apart. A guard failure (half-built schema) therefore crashes the service after about 30 s, which counts as "fails loudly". This retry also matters for S1.

### Blockers
- **B1. `db:check` must explicitly not run migrations, or the "read-only" production check applies the migrations to production** at Design decision 7 / Rollout step 1
  Scenario: decision 3 hard-codes `migrationsRun: true` in the shared `buildTypeOrmOptions`, and decision 7 only says `db-check` sets `installExtensions: false`. If `db-check` builds its DataSource from the shared options (the natural reuse), then `initialize()` runs every pending migration. Rollout step 1 (pre-merge, from the feature branch, with the production `DATABASE_URL`) would then create the 7 `migrations` tables, record the baselines and run the P2-14 concurrent index swap on production. That happens before the Neon snapshot in step 2, and while production still runs the old `synchronize` code. Passing `migrations: []` doesn't help, because the executor creates the `migrations` table first either way. Two things then go wrong:
  1. The check reports 0 because it just applied its own changes. Real drift is masked, which defeats step 1.
  2. The next time an old free instance boots (they sleep and wake constantly), `synchronize` drops the new indexes it doesn't know and recreates the redundant ones. The `migrations` table still says the index migration ran, so after the merge production silently ends up without the P2-14 indexes.

  Suggested fix: `db-check` overrides `migrationsRun: false`, `synchronize: false` and `installExtensions: false`. Add one test to step 7: run `db:check` against an empty database and assert that no `migrations` table appears.
  Response: fixed. Agreed; the natural reuse would have done exactly that. Decision 7 now builds from `buildTypeOrmOptions` and overrides `migrationsRun: false`, `synchronize: false`, `installExtensions: false`, with the reason spelled out. Step 7 adds case (d): `db:check` on a fresh empty database creates no `migrations` table. There's a unit test for the db-check options too.

### Should-fix
- **S1. A failed `CREATE INDEX CONCURRENTLY` leaves an INVALID index, and the re-run then records it as done** at Decision 8 / Risks ("safe to re-run … `IF NOT EXISTS`"): a concurrent build that fails partway leaves an INVALID index with that name. A connection drop through the Neon pooler, a statement timeout, or a Render restart during boot can all cause that. Nest's retry re-runs the migration within seconds, `IF NOT EXISTS` skips the existing name, and the migration is recorded. The index stays invalid for good: it's maintained on every write and never used for reads. `db:check` can't see this, because it matches indexes by name. Suggested: in `up()`, run `DROP INDEX CONCURRENTLY IF EXISTS <name>` before each `CREATE INDEX CONCURRENTLY <name>` for the new indexes. Nothing depends on them yet, so that's safe. Issue one statement per `queryRunner.query()` call, because a multi-statement string runs as one implicit transaction and CONCURRENTLY fails inside it. In rollout step 4, also check that `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid` returns no rows.
  Response: fixed. Decision 8: `DROP INDEX CONCURRENTLY IF EXISTS` before each new `CREATE INDEX CONCURRENTLY`, one statement per `query()`. Risks updated, and rollout step 4 checks `pg_index WHERE NOT indisvalid`.
- **S2. `migration:revert` ignores `transaction = false`, so reverting the index migration fails** at Step 8 ("revert then run round-trips") and the README workflow: `undoLastMigration` wraps `down()` in a transaction whenever the mode isn't `'none'` (`MigrationExecutor.js:318`). The revert CLI takes the mode from `migrationsTransactionMode`, which is `'each'`. So `DROP/CREATE INDEX CONCURRENTLY` in `down()` fails with "cannot run inside a transaction block". Suggested: make the `migration:revert` script, or the documented revert for concurrent migrations, use `-t none`, and note this in the README's "Changing the schema" section.
  Response: fixed. The `migration:revert` script passes `-t none`; decision 9 (README workflow) explains why.
- **S3. The seed's own DataSource will fail on the auth index migration** at Decision 6: P2-14 gives `auth` a `transaction = false` migration (the `educator_profiles` index drop). The hand-built DataSource in `seed.ts:15-22` gets the default mode `'all'`, so `pnpm -C api seed` throws `ForbiddenTransactionModeOverrideError` on every empty database, which breaks CI e2e and the README quick start. Suggested: the seed takes its options from `buildTypeOrmOptions('auth', entities, migrations)`, so SSL, schema and transaction mode come from one place. `db-check` should do the same, with the B1 overrides.
  Response: fixed. Decision 6: the seed builds from `buildTypeOrmOptions('auth', entities, migrations)`; db-check uses the same builder with the B1 overrides.
- **S4. The success log that rollout step 3 watches for won't be printed** at Rollout step 3 / "Logging": "Migration X has been executed successfully" goes through `logSchemaBuild`. That message only prints when `logging` is `'all'` or includes `'schema'` (`AbstractLogger.js:158-162`), and `logging` is `envBool('DB_LOGGING', false)`. Only failures (`logMigration`) always print. The operator can't tell "ran" from "skipped" in Render logs. Suggested: when `DB_LOGGING` is off, use `logging: ['error', 'schema']` (with `synchronize` off, `'schema'` only emits the few migration-runner lines). Alternatively, log the executed migration names after `initialize()`.
  Response: fixed. Decision 3: `logging: ['error', 'schema']` when `DB_LOGGING` is off, keeping slow-query warnings working (the implementer verifies they still print). Rollout step 3 notes why the line appears. There's a unit test that `logging` includes `'schema'`.
- **S5. On production, the baseline's `down()` drops tables and data it never created** at Data model and migrations ("`down()` … local use only"): on production the baseline records itself over existing tables. One `migration:revert` too many with the production URL reverts the index migration and then the baseline, which drops every table in that schema. "Documented as local only" doesn't stop that. Suggested: make the baseline's `down()` throw unless an explicit flag is set (e.g. `ALLOW_BASELINE_REVERT=1`). It's a two-line guard against total data loss.
  Response: fixed. Decision 4: baseline `down()` throws unless `ALLOW_BASELINE_REVERT=1`. Step 7 case (e) tests it.

### Nits (optional)
- **N1.** (Taken in decision 8.) For `auth.educator_profiles`, drop `IDX_2080c94891f76ce625e19874b6`, which comes from the `@Index({ unique: true })` on `user_id` (`api/services/auth/src/entities.ts:97`). The other one, `REL_2080…`, backs the `@OneToOne` unique constraint: `DROP INDEX` can't remove it, and TypeORM would recreate it.
- **N2.** (Taken: plain `(created_at)` partial index; step 8 checks predicates in `pg_indexes`.) `@Index` can't express `DESC`, and a btree scans backwards for `ORDER BY created_at DESC` at no extra cost. A plain `(created_at)` partial index keeps the entity and the migration identical. Also, TypeORM's drift check compares only index names, uniqueness and columns, not partial-index `WHERE` predicates. So in step 8, verify the predicates in `pg_indexes`; `db:check` won't catch a typo there.

## Round 2 (2026-10-02) · Verdict: APPROVED
Reviewed: `plan.md` (status "in review (round 2)") and the responses above. I checked only the changed parts.

Round-1 findings, all resolved:
- **B1** resolved. Decision 7 overrides `migrationsRun`, `synchronize` and `installExtensions` to false and explains why. Step 7(d) proves `db:check` creates nothing, and there's a unit test for the options.
- **S1** resolved. Drop-if-exists comes before each concurrent build, with one statement per `query()`. Rollout step 4 checks for INVALID indexes.
- **S2** resolved. `migration:revert` runs with `-t none`, explained in decision 9.
- **S3** resolved. The seed and `db-check` both build from `buildTypeOrmOptions`.
- **S4** resolved. `'schema'` logging, with a unit test. See S6 for a correction to my own suggestion.
- **S5** resolved. The baseline's `down()` is guarded by `ALLOW_BASELINE_REVERT=1`, and step 7(e) tests it.
- **N1, N2** taken.

### Should-fix (new, in a changed part)
- **S6. Drop `'error'` from the logging list I suggested in S4; use `logging: ['schema']`** at Decision 3. With `'error'` enabled, TypeORM's default logger prints every failing query together with its parameter values (`AbstractLogger.prepareLogMessages` with `appendParameterAsComment: true`). A unique violation on a `users` insert would then write the email and bcrypt hash into the Render logs. Today, with `logging: false`, those errors reach the logs only as Nest's exception message. `['schema']` gives the migration success lines, and failures still print: TypeORM's `'migration'` log type is always on, and Nest logs the boot error. Slow-query warnings (`'query-slow'`) are always on as well, so nothing else is lost.
  Response: fixed. Decision 3 now uses `logging: ['schema']`, with the reason; the unit test asserts it, and the handoff matches. The phase 7 FYI is noted under Risks.

### Nits (optional)
- **N3.** (Taken.) "Data model and migrations" still says the baseline's "`down()` drops everything it created; it is for local use only and documented as such". Update it to mention the `ALLOW_BASELINE_REVERT=1` guard from decision 4, so the two sections agree.

FYI, not for this phase: the always-on slow-query warning also prints query parameters, so a slow query on `users` or `password_resets` leaks the same kind of data. That belongs with the phase 7 logging work.
