# Handoff: Phase 2, schema migrations and `synchronize` off

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 2, see [plan-review.md](plan-review.md); S6 folded into decision 3)
Code review goes to: ethio-reviewer (size L)

## What to build
Replace TypeORM `synchronize` with versioned migrations in all 7 services. Each service runs its migrations at boot. A self-guarding baseline records itself on databases that already have the tables (production, local DBs) and builds the schema on empty ones. A read-only `db:check` drift gate runs in CI. The P2-14 index swap is the first real migration.

## Read first, in order
1. `plan.md`: decisions 1–9 and the Rollout section. The review rounds in `plan-review.md` explain the non-obvious parts (B1 db:check read-only, S1 INVALID indexes, S2 revert `-t none`, S3 seed options, S5 guarded `down()`).
2. `api/packages/common/src/typeorm/typeorm.ts`: the shared options builder you'll extend.
3. One service's `src/app.module.ts` and `src/entities.ts` (financial is the biggest: 11 entities, and it has the duplicate-enum case).
4. `api/services/auth/src/seed.ts`: currently hand-builds a DataSource with `synchronize: true`.
5. `.github/workflows/ci.yml` e2e job: the order is seed, then `scripts/start-backend.sh`, then the e2e scripts.

## Decisions already made (don't relitigate)
- Explicit migration class arrays per service, not globs: dev runs ts-node and prod runs `dist/`.
- `synchronize: false` hard-coded; `DB_SYNC=true` only logs a warning.
- `migrationsRun: true`, `migrationsTransactionMode: 'each'`, `logging: ['schema']` when `DB_LOGGING` is off (not `'error'`: it prints failing queries with parameters, i.e. personal data).
- Self-guarding baseline (`baselineState`: empty → run, present → skip, partial → throw); `down()` throws without `ALLOW_BASELINE_REVERT=1`.
- `db:check` overrides `migrationsRun`, `synchronize` and `installExtensions` to false. It must never write.
- No migration lock (one instance per service on the free plan).
- `docker/postgres-init.sql` keeps creating the schemas.

## Gotchas learned while planning
- **Node isn't on PATH** in tool shells: `export PATH="/home/kal/.local/opt/node22/bin:$PATH"` before any pnpm/node command. pnpm installs need `--store-dir /home/kal/snap/code/current/.local/share/pnpm/store/v3`, and pipe `yes |` if pnpm asks to reinstall.
- **Local Postgres is on host port 55432** (`api/.env` points there), user/pass/db `ethiopialearn`. Create throwaway databases with `docker exec ethiopialearn-postgres-1 createdb -U ethiopialearn <name>` and apply `docker/postgres-init.sql` to them with `psql -f`. Never generate against a renamed schema: the generated SQL embeds the schema name.
- **TypeORM CLI** lives per service: `api/services/<svc>/node_modules/.bin/typeorm-ts-node-commonjs`. There is no CLI in `api/node_modules`.
- **Duplicate `CREATE TYPE`** in generated baselines: `financial.owner_type` (payments, payouts), `quality.owner_type` (qa_review_items, course_cache) and `outcomes.trust_tier` (certificates, educator_tier_cache). Delete the second CREATE and the matching DROP in `down()`.
- **Shared enum types** (`owner_type`, `trust_tier`, `pricing_type`) break TypeORM's generated enum-change migrations. Document hand-written `ALTER TYPE … ADD VALUE` in the README section.
- **CONCURRENTLY:** `transaction = false` on the migration, one statement per `queryRunner.query()`, `DROP INDEX CONCURRENTLY IF EXISTS` before each new index. `db:check` doesn't compare partial-index `WHERE` predicates, so check them in `pg_indexes`.
- **The running local stack** (web on :3000 from `next start`, gateway on :4000, services from `dist/` via `scripts/start-backend.sh`, logs in `.devlogs/`) runs from this working tree. After rebuilding the API, restart it with `scripts/stop-backend.sh && scripts/start-backend.sh`. Don't `pkill -f` a pattern that also matches your own shell command line.
- **The repo is public.** `docs/plans/2026-10-02-refinement-audit/audit.md` is git-ignored on purpose (it describes unfixed vulnerabilities); never commit it or copy its exploit details into committed files.
- **Production is off-limits** to this session: the pre-merge `db:check` against Neon and the Neon snapshot are done by the user (or on their explicit request). Never use the production `DATABASE_URL` from `.env.production.local` on your own.
- Commits: conventional style (`feat(db): …`), author is the repo's git user, **no Claude attribution** of any kind.

## How to run
- Build: `pnpm -C api build`
- Tests: `pnpm -C api test`
- Drift gate: `pnpm -C api db:check` (new)
- Local stack: `bash scripts/stop-backend.sh && bash scripts/start-backend.sh`, then wait for `curl -sf localhost:4000/health`
- E2E: `node scripts/demo-seed.mjs && node scripts/e2e-revisions.mjs && node scripts/e2e-smoke.mjs`
- Seed: `pnpm -C api seed`
- Fresh infra for test (a): `docker compose up -d --wait postgres redis rabbitmq minio && docker compose run --rm minio-init`

## Branch
Create `feat/schema-migrations` from `origin/main` if Phase 1 (`fix/ci-green`) has merged by then, otherwise from `fix/ci-green`, rebasing onto `origin/main` once it merges. Tell ethio-reviewer which base to diff against.

## Definition of done
- Acceptance criteria in `plan.md` met.
- Build, tests and `db:check` pass.
- The plan's step 7 cases (a)–(e) and the step 8 round-trip pass, with the commands recorded in the plan's progress section so the reviewer can rerun them.
- Docker image check (a service boots and migrates from `dist/`) passes.
- Plan checklist ticked.
- Then request code review from ethio-reviewer.
