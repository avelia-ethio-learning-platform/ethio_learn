# Handoff: Phase 9a, event bus resilience and safe consumers

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 2, see [plan-review.md](plan-review.md))
Code review goes to: ethio-reviewer (size L)

## What to build
- The RabbitMQ wrapper reconnects forever instead of wedging after 60 tries, with heartbeats, error listeners, and channel re-setup when a channel closes on its own.
- `publish()` fails fast during an outage.
- Failed handlers retry through a per-service TTL queue and then park, without touching the existing main queue's arguments.
- Consumers that weren't idempotent become idempotent in the database: `runOnce`, atomic stat upserts, notification dedupe.
- `/ready` tells the truth, while `/health` stays cheap.

## Read first, in order
1. `plan.md` decisions 1–6, then `plan-review.md`:
   - round 1 B1: `runOnce` returns the stored `{ item_id }`, and the enqueue handlers resume the AI screen on a skip;
   - S1: the fraud dedupe moved to 9b;
   - S2: channel re-setup and acking on the delivering channel;
   - S3: the `/ready` cache;
   - N1: declare `NULLS NOT DISTINCT` indexes on the entity by name.
2. `api/packages/common/src/events/event-bus.service.ts` in full, plus its spec and fake.
3. `api/services/quality/src/quality.service.ts`: the subscriptions (`:135-170`), `enqueueSubmission`/`enqueueRevision` with the screen (`:199-310`) and `bumpStats` (`:811-819`).
4. `api/services/notification/src/notification.service.ts`: `inbox()`/`deliver()` (`:631-668`), and the handlers that don't await them.
5. `api/services/course/src/course.service.ts:172-175`, `api/services/outcomes/src/certificate.service.ts:67`, and `api/packages/common/src/health.controller.ts` and `bootstrap.ts`.

## Decisions already made (don't relitigate)
- **Retry topology:** the main queue keeps `{ durable: true }` and no arguments. Retry goes to `<service>.events.retry.<seconds>s` (TTL, dead-letter back to `<service>.events` through the default exchange). Park goes to `<service>.events.parked` (`x-max-length: 10000`). The consumer republishes on the confirm channel, then acks; if that fails, it `nack`s with requeue.
- **`runOnce`:** marker plus effect plus stored result in one transaction. Every `runOnce` handler has an explicit `name`. It prunes itself, with no scheduler.
- **`raiseFraudSignal`** is unchanged here (9b owns the dedupe).
- **Health:** `/health` stays Render's health check and the wake target. `/ready` is cached for 5 s with one check in flight. CI waits on `/ready`.
- **No libraries:** no `amqp-connection-manager`, no delayed-message plugin.

## Gotchas learned while planning
- **`PRECONDITION_FAILED`** closes only the channel. Any queue declared with arguments must never change them without a new name. That's why the delay is in the retry queue's name and the parked queue's arguments are frozen.
- **TypeORM 0.3.30 can't express `NULLS NOT DISTINCT`.** Declare the index on the entity by name with the same columns, `unique` and `where`, add `NULLS NOT DISTINCT` in the migration, and check `db:check` stays clean.
- **Indexes** use `CONCURRENTLY` in their own `transaction = false` migration (Phase 2 convention, drop-before-build).
- **The existing amqplib fake** lacks consume, queues, ack, nack, prefetch and `error` events. Extend it first (step 2).
- **The outage drill** (`scripts/e2e-broker-outage.mjs`) stops the shared docker RabbitMQ. Run it only locally, and restart the backend afterwards if anything looks off (`scripts/stop-backend.sh && scripts/start-backend.sh`).
- **9a and 9b should ship together** (Rollout). Don't push 9a alone without telling the planner.
- **This plan folder isn't security-sensitive.** Commit it on your branch, staging paths explicitly.
- **Environment:**
  - the node PATH export;
  - Postgres on 55432;
  - the pnpm `--store-dir` flag;
  - production is off-limits.

## How to run
- **Build and tests:** `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`.
- **Migrations:** apply on a fresh DB and on the dev DB, and `migration:revert` round-trips.
- **E2E:** the CI scripts locally: `demo-seed`, `e2e-revisions`, `e2e-institution`, `e2e-payments`, `e2e-smoke`.
- **Drills:** `node scripts/e2e-broker-outage.mjs` with the stack up, plus the retry/park drill (step 10).

## Branch
Create `fix/event-delivery` from the tip of the stack when it starts (expected `feat/role-dashboards-b`). Don't push until everything below has merged; then `git merge origin/main`.

## Definition of done
- The acceptance criteria are met.
- Both drills are recorded in Progress.
- Build, tests, typecheck and `db:check` pass, and migrations apply and revert.
- The checklist is ticked, with deviations logged.
- Then request code review from ethio-reviewer.
