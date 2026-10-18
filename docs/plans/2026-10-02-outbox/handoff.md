# Handoff: Phase 9b, transactional outbox for state changes

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 2, see [plan-review.md](plan-review.md))
Code review goes to: ethio-reviewer (size L)

## What to build
- Each of the six emitting services (auth, course, enrollment, financial, quality, outcomes) gets an `outbox` table. Every publish site in decision 2's table writes its event there in the same transaction as the state change it announces.
- After commit, a detached fast path publishes the rows right away. An in-service relay sends anything left over, in order, with the row id as the `event_id`, so 9a's dedupe absorbs re-sends.
- A broker outage or a crash between commit and publish loses nothing, and emitting requests never wait on the broker.
- Quality decisions stop reverting with a 503 when a publish fails.
- Fraud raises are deduped by a partial unique index (moved here from 9a). Phase 4's re-publishes get stable `event_id`s.

## Read first, in order
1. `plan.md` decisions 1–6, "Data model and migrations", then `plan-review.md`:
   - round 1 B1: `detectCompletion` keeps its lookups in the try/catch and commits `completed_at` with the `CourseCompleted` row, even with blank names; outcomes' `issue()` and notification fetch what's missing and throw so 9a retries;
   - B2: the fraud-duplicate migration also inserts one `FraudFlagResolved` outbox row per resolved duplicate, so financial drops the orphaned holds;
   - S1: the fast path is detached and skipped when `!bus.isConnected()`;
   - N1: `created_at = clock_timestamp()` at emit; order holds for sequential transactions only;
   - N2: the relay holds no lock and no open transaction while publishing;
   - N3: `outbox.transaction` refuses to run inside an active transaction.
2. `api/packages/common/src/events/event-bus.service.ts` as 9a left it (`publishConfirmed`, `isConnected()`, the random `event_id` at `:168` today), and `EventBusModule`.
3. The publish sites in Current state's table. Line numbers are at `2cdccf9`, and 6a, 6b and 6c change several of these files first, so re-find each site by its code:
   - financial: `refund.service.ts:107,151` (`emitDecision`, after 6c's one-transaction decision), `sponsorship.service.ts:429,435`;
   - auth: `auth.service.ts:54-82` (two saves, no transaction today);
   - enrollment: `enrollment.service.ts:572` and `detectCompletion` (`:604-631`), on 6b's heartbeat version;
   - course: `course.service.ts:212,731,832,935,957,973,1019`, `revision.service.ts:237,273,330,345,510,658`;
   - quality: `quality.service.ts:464-474` (the revert-and-503 to delete), `:480,496,610,677,706,732`;
   - outcomes: `assessment.service.ts:843`.
4. `api/services/financial/src/payment.service.ts:537-590` (`completeEffects` and the re-publish cron) and `payout.service.ts:49-52,59-64` (holds keyed by `flag_id`, `releaseFraudHolds`).
5. The consumers that must fetch missing names: outcomes' certificate `issue()` and notification's `CourseCompleted` handler.

## Decisions already made (don't relitigate)
- **One `outbox` table per schema,** with `id` as the `event_id`. `OutboxEvent` and `OutboxService` live in `packages/common`, wired by `EventBusModule.forRoot({ serviceName, outbox: true })` in the six services. There's no shared outbox schema.
- **API:** `outbox.transaction(async (m, emit) => …)`. `emit` inserts through `m` with `created_at = clock_timestamp()`. Sites already on `dataSource.transaction` switch to it, and sites without a transaction get one.
- **Fast path:** detached after commit, errors caught and logged. It's skipped when the bus is disconnected or an older unpublished row exists (one indexed `EXISTS`).
- **Relay:** `setInterval(OUTBOX_POLL_MS)` inside the service, unref'd, with an in-process re-entrancy flag.
  - Each tick selects 50 unpublished rows by `(created_at, id)` with no lock, publishes them in order, and marks each with `WHERE published_at IS NULL`. It stops at the first failure (`attempts`, `last_error`).
  - Cleanup deletes published rows older than `OUTBOX_RETENTION_DAYS` hourly, 500 at a time.
  - It warns about rows older than 10 minutes, and logs at error when a row has failed 20 times.
  - No LISTEN/NOTIFY, no separate relay worker, no `SKIP LOCKED`.
- **Which events move:** exactly decision 2's table. Notification-only events stay on `publish()` (the Non-goals list, including `revision.service.ts:440`). Payload shapes don't change.
- **Completion commits with blank names; consumers fetch.**
  - `detectCompletion` keeps its lookups in the try/catch. The conditional `completed_at` write and the `CourseCompleted` row commit together, carrying whatever the lookups returned.
  - Outcomes' `issue()` fetches the learner's (and educator's) name when it's missing, and notification fetches the email. Both throw on failure so 9a retries.
- **Fraud raise dedupe:**
  - `raiseFraudSignal` inserts with `ON CONFLICT DO NOTHING` against a partial unique index on `fraud_signals (subject_type, subject_id, signal_type) WHERE status = 'open'`;
  - it emits `FraudFlagRaised` in the same transaction, only when a row was inserted.
- **Fraud migration:** resolve duplicate open signals (keep the oldest, note "duplicate", log the count). For each one resolved, insert a `FraudFlagResolved` outbox row with that signal's `flag_id` and `payee_id`, in the resolve path's payload shape. Then build the unique index `CONCURRENTLY` in its own migration. `down()` only drops the index.
- **Phase 4 stays as it is** (`effects_completed_at` plus the cron). It only gains `eventId = uuidv5(\`${payment.id}:${eventType}\`, NAMESPACE)` through `publishConfirmed({ eventId })`, the same for the sponsorship events it emits.
- **Poison row:** it blocks its service's queue by design (order). Fixing it is an operator `published_at` update, written up in the DEPLOYMENT.md runbook.

## Gotchas learned while planning
- **Migration order:** the fraud-duplicate migration inserts into quality's `outbox`, so its timestamp must come after quality's outbox table migration. The index build follows in its own `transaction = false` migration (Phase 2's drop-before-build convention).
- **Nesting:** TypeORM turns a nested transaction into a savepoint, and the fast path would then publish before the real commit. `outbox.transaction` throws when `m.queryRunner?.isTransactionActive`. Check every converted caller isn't already inside one.
- **`uuid` v5** is only a transitive dependency today. Add it explicitly where it's used.
- **Render free tier:** one instance per service, 3 pool connections, and no timers while asleep. Rows left by an outage go out on the first tick after the service wakes (its next request or 9c's scheduler ping).
- **The outage drill** extends 9a's `scripts/e2e-broker-outage.mjs` and stops the shared docker RabbitMQ. Run it only locally, and restart the backend afterwards if anything looks off (`scripts/stop-backend.sh && scripts/start-backend.sh`).
- **9a and 9b ship together.** Don't push either alone without telling the planner.
- **Before merge, the user runs a read-only duplicate count** (Rollout): `SELECT subject_type, subject_id, signal_type, count(*) FROM quality.fraud_signals WHERE status = 'open' GROUP BY 1, 2, 3 HAVING count(*) > 1`. Put it in the PR description, so the migration's logged count is expected.
- **Staging:** stage paths explicitly. Several plan folders are untracked. This folder isn't security-sensitive, so commit it on your branch.
- **Environment:**
  - the node PATH export;
  - Postgres on 55432;
  - the pnpm `--store-dir` flag;
  - production is off-limits;
  - e2e scripts and Playwright run on `.env.example` values only. Never export `api/.env.example` into the shell for `next start`, and run one Playwright suite at a time.

## How to run
- **Build and tests:** `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`.
- **Migrations:** apply on a fresh DB and on the dev DB; `migration:revert` round-trips; `db:check` clean.
- **E2E:** the CI scripts locally: `demo-seed`, `e2e-revisions`, `e2e-institution`, `e2e-payments`, `e2e-smoke`. The Playwright suite should be unaffected; run it once.
- **Drills:**
  - the broker outage (step 6): five actions under 1 s with RabbitMQ stopped, rows in each `outbox`, and the five effects within two relay ticks of reconnecting;
  - the crash between commit and fast path (step 7).

## Branch
Create `fix/outbox` from the tip of the stack when it starts (expected `fix/event-delivery`, 9a). Don't push until everything below has merged; then `git merge origin/main`. 9a and 9b ship together.

## Definition of done
- The acceptance criteria are met.
- Every spec in steps 2, 4 and 5 exists and passes: the site-by-site commit-together specs, the quality broker-down decision, the fraud dedupe and migration, the completion with auth down, and the stable ids.
- Both drills are recorded in Progress.
- Build, tests, typecheck and `db:check` pass, and migrations apply and revert.
- The DEPLOYMENT.md "Outbox" runbook section is written.
- The checklist is ticked, with deviations logged.
- Then request code review from ethio-reviewer.

## Amendment 2026-10-03 (ethio-planner [aeff2b]): parallel tracks
- Phase 10 (web) and 11a (CI gates) now run in parallel from `origin/main`. **If 11a has merged** when you merge `origin/main`: add your own short section to `docs/DEPLOYMENT.md` (and your env vars to the env examples, if 11a's versions lack them), and keep `pnpm -C api lint` at or under `.github/lint-baseline.json` (fix new warnings rather than raising the baseline).
- The local stack is shared by every track: builds and unit tests run any time; the stack gate only in your window. Ask the current holder and hand it on when done.
