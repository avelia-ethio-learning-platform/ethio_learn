# Code review: Phase 2, schema migrations and `synchronize` off

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: branch `feat/schema-migrations` (7 commits, 2646cae), base `fix/ci-green` (d74a479), against the approved plan (round 2) and the logged deviations.
Checks run (read-only; working tree and the running stack untouched):
- `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck` → 12/12 built, 35 suites / 658 tests pass, typecheck clean.
- `bash docs/plans/2026-10-02-schema-migrations/verify.sh` → ALL PASSED (31 checks: step 7 (a)–(e), step 8 predicates, revert/run round trip, `db:check` exit codes).
- Production-like database, built by hand: `el_review_prodlike`, made from `docker/postgres-init.sql`, then `migration:run`, then `migration:revert` (undoes IndexTuning) in each service, then the `migrations` tables dropped. That is the state verify.sh (b) treats as production. `db:check` against it → exit 1, 13 pending statements (B1). The database was dropped afterwards.
- `git grep` for `synchronize` / `DB_SYNC` / `new DataSource` → no other code path can sync. There are no generated columns or view entities, so `createSchemaBuilder().log()` never creates `typeorm_metadata`. `load-env.ts` doesn't override, so an explicit `DATABASE_URL=… pnpm -C api db:check` really checks that URL.
- Commits: author Kalkidan-Amare, no Claude attribution. `audit.md` is ignored and in no commit; the committed plan docs hold no exploit details.
- Not rerun: the fresh-stack e2e (it needs the dev stack's ports 4000/41xx) and the Docker image check. I rely on the implementer's results and CI for those.

Against the plan: decisions 1–9 are implemented as written. The four round-1/round-2 plan-review items are in the code:
- `db:check` overrides `migrationsRun`, `synchronize` and `installExtensions`, with a unit test, and verify (d) proves it writes nothing.
- Drop-if-exists comes before each concurrent build, one statement per `query()`.
- `migration:revert` runs with `-t none`.
- The seed and `db:check` build from the shared options, the baseline `down()` is guarded, and logging is `['schema']`.

The deviations are sound and stay in scope:
- `db-check.mjs` over `dist/`.
- Per-service `database.ts` as the single entity/migration list.
- The `PostgresConnectionOptions` return type.
- Every IndexTuning statement made idempotent, which is a real improvement for a `transaction = false` retry.
- The CI step waits for each service's `/health`.

Each baseline's `TABLES` list matches its service's `@Entity` names (47 in all). The three duplicate `CREATE TYPE`s are fixed, and the generated DDL matches what `synchronize` built, per verify (b).

### Blockers
- **B1. The documented pre-merge drift check against production can never pass: it reports 13 statements and tells the operator to stop** at `DEPLOYMENT.md:112-117` and `plan.md:80` (Rollout step 1)
  Scenario: the user follows step 1 from the feature branch with the production `DATABASE_URL`. The branch's entities already include the P2-14 `@Index` changes, but production hasn't run IndexTuning yet. So `db:check` compares production with the post-IndexTuning entities. It prints 13 pending statements across all 7 services: 7 `DROP INDEX` for the redundant indexes and 6 `CREATE INDEX` for the new ones. Then it exits 1 with "Schema drift". I reproduced this exactly on `el_review_prodlike` (verify.sh (b) builds the same state but doesn't run `db:check` before booting). DEPLOYMENT.md says to expect "No drift" and that "anything else means production differs from the entities. Stop and add a corrective migration first." So the rollout either halts on a false positive, or the operator writes a "corrective" migration that duplicates or fights IndexTuning (a plain `CREATE INDEX` takes a write lock). The check also hides real drift: a genuinely missing column is buried among 13 expected lines. This was in the approved plan too; both plan-review rounds missed it.
  Suggested fix (pick one; the doc and plan.md step 1 must agree):
  1. Document the exact expected pre-merge output: those 13 statements, listed per service (or shipped as a small expected-output file to `diff` against). Anything beyond them is drift. This survives the rebase onto `origin/main`.
  2. Or run the pre-merge check at the last commit before the P2-14 entity edits (today `fffb297`, which already has `db-check.mjs`), in a separate checkout, where "No drift" is the exact expected answer. A commit hash goes stale on rebase, so name it by its subject or tag it.

  Either way, step 4 (after the deploy, expect "No drift") stays as it is.
  Response: fixed, with a third option. Production is migrated on a rehearsal copy and checked there, so "No drift" is the exact expected answer, with no list of 13 lines to compare and no commit hash to keep current. DEPLOYMENT.md step 1 now says to create a Neon branch of production, run every service's `migration:run` against it from the feature branch, then `db:check` against it, and delete the branch afterwards. It also says why `db:check` can't run against production directly before the merge (the 13 `IndexTuning` statements). The same rehearsal exercises the real baseline and `CONCURRENTLY` path over Neon's pooler on production data before anything touches production. plan.md rollout step 1 matches. verify.sh gains two checks. (b) asserts that `db:check` before the deploy lists exactly 13 statements, all index changes, which pins the behavior you found. New case (f) runs the documented rehearsal on a copy of the production-like database and expects no drift.

### Should-fix
- **S1. Rolling forward after a rollback silently skips IndexTuning** at `DEPLOYMENT.md:125` and `plan.md:56`: after "revert the merge and redeploy", `synchronize` puts back the 7 redundant indexes and drops the 6 new ones. But every `"<schema>"."migrations"` table still records `IndexTuning…` as done. When the phase is merged again, the baselines and IndexTuning are all already recorded, so nothing runs. Production keeps the old indexes and lacks the P2-14 ones. Step 4's `db:check` would flag it, but the doc doesn't say what to do then. Suggested: add one line to "Rolling back". Before deploying the migrations again, drop the 7 `"<schema>"."migrations"` tables, or delete their `IndexTuning%` rows. The baselines then re-record themselves (all tables present) and IndexTuning runs again.
  Response: fixed. DEPLOYMENT.md "Rolling back" and plan.md "Rollback of the whole phase" both say: before deploying the migrations again, `DELETE FROM "<schema>"."migrations" WHERE name LIKE 'IndexTuning%'` in each schema. The baselines stay recorded, since every table is still there. I chose deleting the rows over dropping the tables because it's narrower and keeps the history. New verify.sh case (g) recreates the post-rollback state (old indexes, `IndexTuning` still recorded). It shows that running the migrations again rebuilds nothing, then that the documented `DELETE` plus a run gives 6 new, 0 redundant and no invalid indexes, and no drift.

### Nits (optional)
- **N1.** `DEPLOYMENT.md:123`: `DB_SYNC` didn't come from a hand-set variable. It lived in the shared `envVarGroups` block of `render.yaml`, and a Blueprint sync may leave a key behind after it's removed from the file. Suggest: "If `DB_SYNC` still shows in the shared env group or any service's environment, delete it."
- **N2.** `.github/workflows/ci.yml` drift step: each `/health` wait loop falls through silently after 60 s. If a service never comes up, `db:check` then fails as "Schema drift" on a schema that never migrated, which is misleading. A final `curl -sf "http://localhost:$port/health" > /dev/null || { echo "service on :$port not healthy"; exit 1; }` after each loop would name the real cause. (The loop's own exit status is always 0, so `|| exit 1` straight after `done` wouldn't work.) (The existing gateway wait has the same pattern.)
  Response (N1, N2): both taken. N1: DEPLOYMENT.md step 5 and plan.md rollout step 5 now name the `ethiopialearn-shared` env group and the Blueprint sync. N2: the CI drift step checks each service's `/health` once more after its wait loop and exits with "service on :<port> is not healthy". The gateway wait is left as it is; it belongs with P2-19.

Round 1 addressed. Commands rerun: `pnpm -C api build && pnpm -C api test` → 658 tests pass; `bash docs/plans/2026-10-02-schema-migrations/verify.sh` → ALL PASSED, now 38 checks (about 2.5 min).
