# Phase 9a: Event bus resilience and safe consumers

Status: approved (round 2)
Size: L (sessions: 4 — ethio-impl implements, ethio-plan-review reviews the plan, ethio-reviewer reviews the code)
Base branch: the tip of the stack when it starts: `feat/role-dashboards-b`, or `origin/main` if everything below has merged. · Feature branch: `fix/event-delivery`
Roadmap: phase 9, split into 9a (this plan), 9b (transactional outbox), 9c (outbound calls, jobs and status codes), 9d (observability) and 9e (read paths). See "Roadmap change" at the end.
Findings: P1-15, P1-16, P1-20.

## Goal
A RabbitMQ outage, a CloudAMQP maintenance window or a slow handler must not crash a service, wedge its event bus until a manual restart, or silently drop an event that a consumer failed to handle. Failed handlers retry, then park where someone can see them. A retry never double-counts or double-sends. Health checks say whether a service can actually do its work.

Acceptance criteria:
- **Survives a broker outage (P1-15):**
  - stopping RabbitMQ for 5 minutes and starting it again needs no restart;
  - every service reconnects, resumes consuming, and publishes again;
  - no process exits along the way.
  - **While the broker is down:** `publish()` fails within `EVENT_PUBLISH_WAIT_MS` (default 5 s) with `BrokerPublishError`, instead of holding the request for about 3 minutes.
  - A service that boots while the broker is down serves HTTP at once and starts consuming when the broker comes back.
- **No unhandled rejections from the bus:** a closed channel during `ack`, a late confirm and a connection `error` event are each handled and logged.
- **Failed handlers retry, then park (P1-16):**
  - a handler that throws is retried after `EVENT_RETRY_DELAY_MS` (default 60 s), up to `EVENT_MAX_ATTEMPTS` (default 5);
  - then the message moves to `<service>.events.parked`, with an error log naming the event type, event id and handler;
  - an unparseable message parks at once.
- **Bounded concurrency:** each consumer has `prefetch` `EVENT_PREFETCH` (default 4).
- **Retries are safe:** redelivering any event to these consumers leaves the same state and sends no second email or inbox row:
  - quality's stat counters and review-queue enqueues, including the AI screen of a retried submission;
  - course's `enrolled_count`;
  - outcomes' certificate issue;
  - every notification handler.
  - Counters no longer lose concurrent updates.
- **Notification failures surface:** a failed email send or inbox write makes the handler throw, so it retries.
- **Health (P1-20):**
  - `/health` stays a fast liveness check and reports the real service name;
  - `GET /ready` returns 200 only when the database answers and the broker is connected (and Redis, for auth); otherwise 503 with which check failed;
  - CI waits on `/ready`.

## Non-goals
- **A transactional outbox for state changes** that publish after commit (P1-17). That is Phase 9b, which builds on this phase's retry and dedupe.
- **Changing what any handler does,** beyond making it idempotent and letting its errors reach the bus.
- **Topic exchanges or per-event routing,** priority queues, a broker-side retry plugin, or tooling to replay parked messages. Parked messages can be shoveled back by hand from the RabbitMQ console; a replay tool can come later if parking proves common.
- **Switching Render's `healthCheckPath` to `/ready`** (decision 6).
- **Request IDs, JSON logs and correlation through HTTP** (P1-21, Phase 9d). This phase adds the per-event context that 9d builds on.
- **Commands beyond the safe-ack wrapper.** The only command is `run_payouts`, and `runPayouts` is already guarded by an advisory lock and conditional updates.

## Current state
All references are at `2cdccf9`. Phases 5 through 8 don't touch these files.

- **Bus** `api/packages/common/src/events/event-bus.service.ts`:
  - **Topology:**
    - fanout `ethiopialearn.events` and direct `ethiopialearn.commands` (`:193-194`);
    - one durable queue `<service>.events` per service, bound with `''`, with no queue arguments (`:211-213`);
    - handlers are picked by `event_type` and run in order (`:218-221`);
    - the only setting is `RABBITMQ_URL` (`:177`).
  - **Connect** (`:176-204`):
    - no heartbeat (amqplib default 0);
    - only a connection `close` listener (`:183`), with no `error` listener on the connection or the main channel;
    - 60 tries 3 s apart, then it throws (`:200`);
    - a failure after `connect` succeeded leaks that connection.
  - **Close handler** (`:183-191`): schedules `startConsuming()` once with `.catch(() => undefined)`, so a failed reconnect is never retried.
  - **Wedges after an outage:**
    - `getChannel()` caches `connecting` (`:137-141`). After the 60th failure the rejected promise stays cached, so every later `publish` rejects until a restart.
    - During an outage, `publish()` waits inside the retry loop for up to about 3 minutes, holding the HTTP request open.
    - `onApplicationBootstrap` (`:121-124`) logs a failed first connect and never retries.
  - **Consumers** (`:214-228`, `:236-245`):
    - async callbacks with `channel.ack(msg)` after the awaits and outside the try. On a closed channel that is an unhandled rejection, and no `unhandledRejection` handler exists anywhere in `api/`.
    - A failed handler is logged and acked: "TODO add a dead-letter queue before production" (`:223-224`).
    - No `prefetch`. Render runs `DB_POOL_MAX=3` (`render.yaml:59-62`), so a backlog after a wake-up competes for three connections.
  - **`publishConfirmed`** (`:86-111`, Phase 4): `delivery.catch` is attached after the race (`:109`), so a late rejection after a timeout is unhandled.
  - **The envelope** (`packages/contracts/src/events.ts:67-76`) carries `event_id`. Handlers receive `(payload, envelope)`, but only `assessment.service.ts:106` uses the envelope.
  - **Tests:** only `event-bus.service.spec.ts`, covering `publishConfirmed`. Its amqplib fake has no consume, queues, ack, nack, prefetch or `error` event.
- **Consumers that aren't idempotent:**
  - **quality** `bumpStats` (`quality.service.ts:811-819`): read-modify-write of `payee_stats` for `CourseCompleted` (`:147-153`), `PaymentConfirmed` (`:154-157`) and `RefundApproved` (`:161-169`). The last one also inserts a `refund_log` row and can raise fraud signals.
  - **quality** `raiseFraudSignal` (`:689-714`): always inserts a new open signal and publishes `FraudFlagRaised`.
  - **quality** enqueue handlers: `CourseSubmitted` (`enqueueSubmission`, `:199`; closes open items, then inserts), `CourseAppealSubmitted` (`:137`, inserts each time) and `CourseRevisionSubmitted` (`:141`).
  - **course** `EnrollmentCreated`: `increment(enrolled_count, 1)` (`course.service.ts:172-175`).
  - **outcomes** `issue()` (`certificate.service.ts:67`): checks `findOne` by `enrollment_id`. A unique index on `certificates.enrollment_id` exists (`outcomes/src/entities.ts:91-93`), so a concurrent duplicate gets an unhandled 23505.
  - **notification:** 37 handlers (`notification.service.ts:119-373`).
    - `inbox()` (`:631-648`) and `deliver()` (`:650-668`) swallow their errors, so a retry could never help a failed email.
    - Several handlers don't await them (e.g. `:345`).
    - A redelivery writes a second inbox row and sends a second email.
- **Already idempotent (no change):**
  - enrollment's grant, revoke, course cache and revision-closed handlers;
  - course's `CourseRated` and revision-reviewed handlers;
  - outcomes' revision-closed and tier-cache handlers;
  - financial's `UserRegistered` claim and fraud raise/resolve holds.
- **Health:**
  - `packages/common/src/health.controller.ts:1-9` is static, and `SERVICE_NAME` is set nowhere, so every service reports "unknown". The gateway has its own static controller (`gateway/src/main.ts:33-39`).
  - `/health` is excluded from the `/api/v1` prefix and from the internal-token check (`bootstrap.ts:46,66`).
  - **What depends on `/health`:** Render's `healthCheckPath` (`render.yaml`, eight services), the CI wait (`ci.yml:92-99`) and Phase 5's browser wake pings (`web/src/lib/wake.ts`).
  - Redis is used only by auth (`auth.service.ts:7,39`). `DataSource` is injectable in every service.
- **Migrations:** each service keeps `src/migrations/<timestamp>-<Name>.ts` plus an `index.ts` registry. Phase 2's `pnpm -C api db:check` fails on drift. Local Postgres is 15 (`docker-compose.yml:39`); Neon runs 15 or newer.

## Design and key decisions
1. **A connection supervisor that never gives up:**
   - `ensureConnected()` loops with capped exponential backoff (1 s doubling to 30 s, ±20% jitter) until it connects or the app shuts down. `connecting` is cleared in `finally`, so a failure is never cached.
   - **Heartbeat:** 30 s (`EVENT_HEARTBEAT_S`), added as the `heartbeat` URL parameter when the URL doesn't already set one, so a silently dropped CloudAMQP link is noticed within about a minute.
   - **Listeners:** `error` on the connection and on every channel (warn log), and `close` on the connection (schedules the supervisor; no one-shot `setTimeout`). A partly opened connection is closed before the next try.
   - **On every (re)connect:** assert exchanges and queues, set `prefetch`, and start the consumers again with the handlers registered at init.
   - **A channel that closes on its own** (RabbitMQ closes only the channel on a channel-level error such as `PRECONDITION_FAILED` or an unknown delivery tag) is dropped and set up again: reopened, topology re-asserted, consumers restarted. The connection stays up. Closing the main channel during shutdown doesn't trigger this.
   - **Ack and nack go on the channel that delivered the message,** captured at consume time, so an ack never lands on a newer channel with an unknown delivery tag.
   - `isConnected()` is public, for `/ready`. It is true only when the connection and the main channel are both open.
   - **Boot** stays non-blocking, as today, but the first connect now goes through the same supervisor, so it retries forever.
   - Rejected: a library such as `amqp-connection-manager`. It's one more dependency for about 60 lines we can test with the existing amqplib fake.
2. **Publishing keeps today's contract but fails fast:**
   - `publish()` waits at most `EVENT_PUBLISH_WAIT_MS` (5 s) for a channel, then throws `BrokerPublishError`. Callers keep their current behaviour, including quality's revert-and-503 (`quality.service.ts:464-474`), but the request returns in seconds, not minutes.
   - When `channel.publish` returns `false` (backpressure), it waits for `drain` within the same budget.
   - `publishConfirmed` attaches `delivery.catch` before racing the timeout.
   - Rejected: a `publish()` that swallows failures. It would silently turn quality's revert into a lost decision until 9b's outbox exists.
3. **Retry and park queues that don't touch the existing queue:**
   - **Queues per service:**
     - `<service>.events`: unchanged, no new arguments. Redeclaring an existing production queue with different arguments fails with `PRECONDITION_FAILED` and closes the channel, so the main queue keeps exactly its current declaration.
     - `<service>.events.retry.<seconds>s` (see Configuration for why the delay is in the name): `x-message-ttl` = `EVENT_RETRY_DELAY_MS`, `x-dead-letter-exchange: ''`, `x-dead-letter-routing-key: <service>.events`. When the TTL runs out, the message returns to this service's queue only; the fanout would send it to everyone.
     - `<service>.events.parked`: no consumer, `x-max-length: 10000`, so a flood can't fill the broker. Its arguments never change without a new name, for the same `PRECONDITION_FAILED` reason.
   - **On handler failure:**
     1. The consumer republishes the same bytes to the retry queue through the default exchange, on the confirm channel, with the header `x-attempts: n + 1`.
     2. Then it acks the original.
     3. If the republish fails (the broker went away), it `nack`s with `requeue: true` instead, so nothing is lost.
   - **After `EVENT_MAX_ATTEMPTS`,** or for a message that won't parse, the message goes to the parked queue with headers `x-last-error` (500 characters) and `x-failed-handler`, plus an error log.
   - **The callback never throws:** the whole body is in try/catch, and `ack`/`nack` are each wrapped. A closed channel just means the broker redelivers.
   - **`prefetch(EVENT_PREFETCH)`, default 4:** three handlers holding Render's three DB connections plus one in hand.
   - **Commands** get the same safe-ack wrapper, and a failure parks the command in `<service>.commands.parked`, with no retry.
   - **5 attempts × 60 s** covers a peer's cold start (30–50 s) with room to spare. Total delay before parking is about 5 minutes.
   - **Rejected:**
     - a dead-letter exchange on the main queue (needs new arguments on existing queues, so `PRECONDITION_FAILED`, a delete-and-recreate, and lost messages during the swap);
     - `nack(requeue)` loops (hot-loops a poison message);
     - the delayed-message plugin (CloudAMQP free doesn't offer it).
4. **The current event is available to the code it calls:**
   - The dispatcher runs each handler inside `eventContext.run({ event_id, event_type, correlation_id, handler }, …)`, using an `AsyncLocalStorage` in `packages/common`. `currentEvent()` returns it.
   - This lets shared helpers (notification's `inbox`/`deliver`, the dedupe helper) find the event id without changing 37 handler signatures. 9d reuses the same store for request ids.
   - **Handler names** for logs and dedupe keys: `subscribe(type, handler, { name })`. The default is `<service>:<event_type>:<index>`. **Every handler that uses `runOnce` must pass an explicit `name`.** The index-based default shifts when a handler is added ahead of it, and a redelivery after that deploy would re-run a deduped effect. A spec checks that `runOnce` refuses a handler without one.
5. **Idempotency where it's missing, in the database:**
   - **`processed_events`** (per schema, quality and course): `(consumer varchar(120), event_id uuid, processed_at timestamptz default now(), PRIMARY KEY (consumer, event_id))`.
     - Common helper `runOnce(dataSource, consumer, eventId, fn)`: one transaction that does `INSERT … ON CONFLICT DO NOTHING RETURNING 1`. If a row comes back, it runs `fn(manager)` in the same transaction and stores `fn`'s small return value in `processed_events.result jsonb` (e.g. `{ item_id }`). It returns `{ ran: true, result }`. On a conflict it returns `{ ran: false, result }` with the stored value, so a retry can resume work that happens after the commit.
     - **Pruning:** about one call in 1,000 also deletes up to 1,000 rows older than 30 days (`PROCESSED_EVENTS_RETENTION_DAYS`), so the table stays small without a scheduler (plan-review N3).
     - The entity and the helper live in `packages/common`; each service adds the entity and a migration.
   - **quality counters:**
     - `bumpStats(manager, payeeId, delta)` becomes one statement: `INSERT INTO payee_stats … ON CONFLICT (payee_id) DO UPDATE SET payments = payee_stats.payments + $2, …`, so concurrent events stop overwriting each other.
     - The three stat handlers wrap their writes (the stat bump and, for refunds, the `refund_log` insert) in `runOnce`.
     - `recomputeTier` and the refund-rate and refund-abuse checks run after the transaction on every delivery. They recompute from current rows, so running them twice is harmless.
   - **`raiseFraudSignal` is unchanged in this phase** (plan-review S1).
     - The dedupe (partial unique index on open signals, `ON CONFLICT`, publish only on insert) moves to 9b, where the insert and its outbox row commit together. Here, a redelivery after a broker drop between insert and publish would conflict and publish nothing, so financial would never hold the payee.
     - Until 9b, a retried refund handler can open a duplicate open signal, as a redelivery can today. Duplicates hold payouts (the safe direction), and the admin resolves each one.
   - **quality enqueue handlers** (`CourseSubmitted`, `CourseAppealSubmitted`, `CourseRevisionSubmitted`) run their inserts in `runOnce` and return `{ item_id }`.
     - The AI screen (Groq, up to about 25 s), `recordScreen` and `raisePlagiarismSignal` run after the commit, as today (`quality.service.ts:202-232,263-310`).
     - **On a skip** (`ran: false`), the handler loads the stored item. If the item is still open and its `plagiarism.pending` is true, it finishes the screen and the signal. So a retry after a failure past the commit (a Neon reset in `recordScreen`, or a lost ack) completes the screen instead of leaving it pending forever with no plagiarism signal.
   - **course `EnrollmentCreated`:** the increment runs in `runOnce`.
   - **outcomes certificates:** the insert in `issue()` treats a unique violation on `enrollment_id` as "already issued". A duplicate may leave an unused PDF in storage, which is harmless and noted.
   - **notification:**
     - `inbox()` takes the event id from `currentEvent()` and inserts with `ON CONFLICT DO NOTHING` against a new `source_event_id` column. The partial unique index `UNIQUE NULLS NOT DISTINCT (source_event_id, user_id, target_role, type) WHERE source_event_id IS NOT NULL` (Postgres 15+) leaves legacy rows alone.
     - `deliver()` takes the event id too. It skips when a `notification_log` row with `status = 'sent'` already exists for `(event_id, recipient, event_type)` (new `event_id` column, partial index on sent rows). After a successful send it writes the sent row.
     - **Errors now propagate:** a failed send writes the `failed` row and then throws, and an inbox write error throws.
     - A crash between send and log can still send twice. That is at-least-once, accepted and documented.
     - Every handler awaits its `inbox`/`deliver` calls, so failures reach the bus.
   - **Rejected:**
     - a generic dedupe wrapper around every handler outside the handler's own transaction. "Processed" and the effect wouldn't commit together, so a crash between them loses or repeats the effect.
     - changing every handler's signature to receive a manager (37 notification handlers for no gain over decision 4).
6. **Health: `/health` stays cheap, `/ready` tells the truth:**
   - **`/health`:**
     - It is what Render's health check, Phase 5's browser wake pings and the CI wait use, so it must answer instantly on a cold start.
     - It keeps returning 200 and now reports the service name passed to `bootstrapService` (the gateway: "gateway").
     - `SERVICE_NAME` isn't needed.
   - **`/ready`:**
     - Same exclusions as `/health` (no prefix, no internal token).
     - Checks: `SELECT 1` with a 2 s timeout; `eventBus.isConnected()`; for auth, a Redis `PING` with a 1 s timeout.
     - 200 `{ status: 'ready', service, checks: { db: 'ok', broker: 'ok' } }`, or 503 with the failing check marked `'down'`.
     - No hosts, URLs or error text in the body.
     - **Cached:** readiness is computed at most once every 5 s per instance, with one in-flight check whose promise concurrent callers share. `/ready` is public on each service's Render URL, outside the gateway's rate limits, so a request loop can't take the 3 pool connections (plan-review S3).
   - **Render's `healthCheckPath` stays `/health`.** A restart doesn't fix a database or broker outage, and decision 1 now recovers on its own. A failing readiness check during a Neon wake-up or a CloudAMQP blip would fail deploys or bounce free instances for nothing. `/ready` is for CI, 9c's scheduler and operators.
   - **CI's e2e wait moves to `/ready`,** so the scripts start only once every service consumes. This also fixes the health loop that exits 0 on failure (`ci.yml:92`, P2-19 part): it now fails the step.

## Data model and migrations
One migration per affected service. All are additive.

- **quality:** `CREATE TABLE processed_events (…)` (decision 5, including `result jsonb NULL`). The fraud-signal index moved to 9b.
- **course:** `CREATE TABLE processed_events (…)`, the same shape.
- **notification:**
  - `inbox_notifications ADD source_event_id uuid NULL`, then the partial unique index above. TypeORM can't express `NULLS NOT DISTINCT`, so the entity declares the index by name with the same columns, `unique` and `where`, and the migration adds `NULLS NOT DISTINCT`. Confirm `db:check` stays clean (plan-review N1);
  - `notification_log ADD event_id uuid NULL`, then `CREATE INDEX … ON notification_log (event_id, recipient, event_type) WHERE status = 'sent'`.
- **Locks:** Phase 2's convention applies: `ADD COLUMN … NULL` is metadata-only, and indexes use `CONCURRENTLY` outside a transaction (`transaction = false` on that migration, as Phase 2's index-tuning migration does). The table and column names are confirmed against each service's entities.
- **Rollback:** each `down()` drops what its `up()` added. No data is changed.

## Configuration
New optional env, with defaults that work locally and on Render. They go in `api/.env.example` with one-line comments:
- `EVENT_PREFETCH=4`;
- `EVENT_MAX_ATTEMPTS=5`;
- `EVENT_RETRY_DELAY_MS=60000`;
- `EVENT_PUBLISH_WAIT_MS=5000`;
- `EVENT_HEARTBEAT_S=30`.

Changing `EVENT_RETRY_DELAY_MS` after the retry queue exists would hit `PRECONDITION_FAILED`, so the queue name includes the delay: `<service>.events.retry.<seconds>s`. A changed value then declares a new queue, and the old one drains through its own TTL.

## Steps
- [x] 1. Branch `fix/event-delivery` from the base above.
- [x] 2. Extend the amqplib fake in `event-bus.service.spec.ts`:
  - consume and deliver;
  - `assertQueue` with arguments, `bindQueue`, `prefetch`, `ack`/`nack`;
  - default-exchange publish to a named queue;
  - connection and channel `error`/`close` events;
  - a connect that fails N times.
- [x] 3. Supervisor and publish (decisions 1, 2):
  - reconnect forever with backoff;
  - heartbeat;
  - listeners;
  - consumers restarted on reconnect;
  - the bounded `publish` wait and drain;
  - the `publishConfirmed` late-rejection fix;
  - `isConnected()`.

  Specs:
  - 70 failed connects, then success → connected and consuming;
  - a channel `close` with the connection still open → channel reopened, consumers re-registered, `publish` works, `isConnected()` false in between;
  - an ack after a reconnect uses the delivering channel;
  - a `close` → reconnect → consumers re-registered;
  - a connection `error` event → no throw;
  - `publish` while down → `BrokerPublishError` within the wait;
  - a late confirm rejection after a timeout → no unhandled rejection (a `process.on('unhandledRejection')` spy in the test).
- [x] 4. Consumer safety (decision 3): `prefetch`; retry and park queues and headers; the never-throwing callback; the safe ack and nack; commands parking.

  Specs:
  - a throwing handler → copy to the retry queue with `x-attempts: 1`, then ack;
  - attempt 5 fails → parked with the headers;
  - an unparseable message → parked;
  - the retry republish fails → `nack(requeue)`;
  - `ack` on a closed channel → swallowed and logged;
  - the main queue is asserted with no arguments.
- [x] 5. Event context and handler names (decision 4): the `AsyncLocalStorage` store, `currentEvent()`, and `subscribe(…, { name })`. · Spec: `currentEvent()` inside a handler returns its envelope's ids, and nothing outside one.
- [x] 6. `processed_events` entity and `runOnce` in common, plus quality and course migrations. Then:
  - the quality stat handlers (atomic upsert plus `runOnce`);
  - the quality enqueue handlers, with resume-on-skip for the AI screen;
  - the course `EnrollmentCreated` counter;
  - the outcomes certificate unique-violation handling.

  Specs:
  - each handler run twice with the same envelope → state as after one run;
  - two concurrent `bumpStats` → both counted;
  - the screen step throws once → the retry records the screen and raises the plagiarism signal, and only one item exists (plan-review B1);
  - `runOnce` returns the stored result on a skip, and refuses a handler without a `name`;
  - a duplicate `issue()` → one certificate, no throw.
- [x] 7. Notification (decision 5):
  - the migration;
  - `inbox()`/`deliver()` with the event id from context, dedupe, and throwing on failure;
  - every handler awaits.

  Specs:
  - the same envelope twice → one inbox row and one send;
  - a provider failure → a `failed` log row and the handler throws;
  - after a failed attempt, the retry sends once and logs `sent`.
- [x] 8. Health (decision 6):
  - `HealthController` reports the bootstrap name;
  - `ReadyController` (DB, bus, Redis for auth) registered by `bootstrapService`;
  - the gateway's `/health` is unchanged.
  - The CI e2e wait moves to `/ready` and fails the step on timeout.

  Specs: `/ready` gives 200 when everything is up, and 503 with `db: 'down'` when the query times out or `broker: 'down'` when disconnected; 50 concurrent calls run one `SELECT 1`.
- [x] 9. Outage drill on the local stack. Script it as `scripts/e2e-broker-outage.mjs`, local only and not in CI, because stopping a shared container in CI is fragile:
  1. with the stack up, `docker compose stop rabbitmq` for 90 s;
  2. confirm every service's `/health` stays 200, `/ready` reports `broker: 'down'`, no service process exits (PIDs unchanged), and an endpoint that publishes fails fast (≤ 6 s) with a 503 rather than hanging;
  3. `docker compose start rabbitmq`;
  4. within 60 s all `/ready` are 200, and a free enrollment produces its `EnrollmentCreated` effects (the course `enrolled_count` +1, an inbox row).

  Record the output in Progress.
- [x] 10. Retry drill: temporarily make one notification handler throw through an env flag that only exists in test builds (or a unit-level drill if the implementer prefers), and show:
  - retry after the delay;
  - parked after `EVENT_MAX_ATTEMPTS`;
  - no duplicate inbox row on the successful retry.

  Record the result.
- [x] 11. Full gate:
  - `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`;
  - migrations apply on a fresh DB and on the dev DB, and `migration:revert` round-trips each new one;
  - the CI e2e scripts (`demo-seed`, `e2e-revisions`, `e2e-institution`, `e2e-payments`, `e2e-smoke`) pass locally;
  - the Playwright suite is unaffected (web untouched).
- [ ] 12. Code review by ethio-reviewer; the user approves push and PR.

## Test plan
- **Unit (jest):**
  - the bus with the extended fake (steps 3 and 4);
  - the event context (step 5);
  - `runOnce`, and each changed consumer run twice (step 6);
  - notification dedupe and error propagation (step 7);
  - `/ready` (step 8).
- **Local drills:** broker outage (step 9) and retry/park (step 10).
- **Commands:**
  - `pnpm -C api test`;
  - `pnpm -C api db:check`;
  - `node scripts/e2e-broker-outage.mjs` with the local stack up.

## Rollout and ops
- **Order on deploy:**
  - The new queues are declared by each service on connect, and the existing queues are untouched, so services can roll in any order.
  - A not-yet-updated producer is fine: the envelope is unchanged.
- **Migrations** run at boot (Phase 2's `migrationsRun`). The `CONCURRENTLY` index builds on `fraud_signals`, `inbox_notifications` and `notification_log` are small tables today.
- **9a and 9b should ship together, or close together** (plan-review S1): the fraud-signal dedupe lives in 9b. 9a alone keeps today's duplicate-signal behaviour, which errs toward holding payouts.
- **Watching after deploy:**
  - **parked messages:** CloudAMQP console, queues `*.events.parked`. A non-zero count means a handler fails persistently; the error log names it.
  - **logs:** `event parked`, `broker reconnected after Ns`, `publish failed: broker unavailable`.
- **Env:** none required; the defaults are in decision 3 and Configuration.

## Risks and open questions
- **Reordering:**
  - a retried message arrives after later events for the same course;
  - quality's `inCourseOrder` serializes within one process only, and the fanout and multiple handlers never guaranteed order;
  - the enqueue handlers already close open items before inserting, which keeps the queue consistent when an older event lands late.
  - **An appeal retried after a withdraw** (checked in plan review): the late appeal item becomes decidable, but `onCourseReviewed` applies an approval only to a course in review or flagged (`course.service.ts:195-206`) and logs anything else as stale. The course's next submission closes the stale item (`closeOpenItems`). What's left is a stale entry in the QO queue until then.
- **At-least-once email:** a crash between the provider accepting a send and the `sent` row being written resends on redelivery. Rare, accepted, documented.
- **amqplib heartbeat on CloudAMQP:** the free plan accepts heartbeats, and 30 s is within its range. If CloudAMQP enforces a different value, the server's value wins in negotiation.

## Roadmap change (planner)
The roadmap's Phase 9 covers 12 findings across every service: P1-15 to P1-23, P2-03, P2-04, P2-15, plus Phase 4's deferred N1 and N2 and the slow-query note. As one PR that would be unreviewable, the same reason Phases 6 and 7 were split. It is split by layer:
- **9a (this plan):** event bus resilience and safe consumers (P1-15, P1-16, P1-20).
- **9b:** transactional outbox for the state changes that publish after commit (P1-17), built on 9a's retry and dedupe.
- **9c:** outbound calls, scheduled jobs and status codes:
  - P1-18, including the throwing learner lookup for Phase 4's re-publish cron;
  - P1-19, with job endpoints and the external scheduler the free tier needs;
  - P1-23, N1, N2, P2-15;
  - the races P2-03 still has after Phases 4 and 6c.
- **9d:** observability (P1-21, the slow-query parameters, the console email provider in production).
- **9e:** read paths (P1-22 batched internal reads, P2-04 unbounded reads). Split from 9d after planning showed about 25 more files of N+1 and pagination work.

## Progress and deviations (implementer)

Commits on `fix/event-delivery` (base `03fd049`): `3c6f164` plan docs · `ccef60d` bus (steps 2–5) · `8bd28dd` runOnce and consumers (step 6) · `ea99c7d` notification (step 7) · `7edbd06` /ready (step 8) · `c9f4d0e` outage drill (step 9) · `f9e0e8e` retry drill (step 10) · `a6f2dd2` code review round 1 fixes.

**Steps 1–8 done.** Unit gate on `7edbd06`: build ok; `pnpm -C api test` → 1324 passed, 1 skipped; typecheck ok. Migrations: every service migrates a fresh DB, `db:check` no drift, `migration:revert` then `migration:run` round-trips each of the three new ones; on a copy of the dev DB the pending migrations (main's and 9a's) apply and `db:check` has no drift. `runOnce` and the stats upsert were also checked on real Postgres (scratch DB): a redelivery skips with the stored result, two concurrent duplicates run the effect once, 20 concurrent upserts count 20.

**Deviations and choices:**
- **Handler names.** The handlers with effects pass explicit, stable names: `quality:CourseSubmitted:enqueue`, `quality:CourseAppealSubmitted:enqueue`, `quality:CourseRevisionSubmitted:enqueue`, `quality:CourseCompleted:stats`, `quality:PaymentConfirmed:stats`, `quality:RefundApproved:stats`, `course:EnrollmentCreated:enrolled-count`. Every other handler keeps the positional default `<service>:<type>:<index>`, used only in logs and park headers. `runOnce(dataSource, consumer, eventId, fn)` takes the name and event id explicitly and throws on an empty one, so a handler can't dedupe under a positional name.
- **Quality enqueue resume (B1).** On a skip, the enqueue handlers get `{ item_id }` back from the marker and rerun the screen only when that item is still open with `plagiarism.pending`. The screen, the stored result and the signal happen after the commit, as before.
- **Notification: `NotificationSent` is best-effort** (caught and logged as a warning). Before, a publish failure after a successful send fell into the `catch` and wrote a `failed` row for an email that went out; now that a failure throws and retries, it would also resend it. It is telemetry only.
- **Notification fan-out** (changed in code review round 1, B1 and S2). `notifyNewCourseFollowers` and `notifyCourseUpdated` notify every recipient first, then rethrow the first failure (`forEachRecipient`). The bus retries the event, and the dedupe skips the recipients already notified, so one rejected address or a spent quota costs nobody else their notification. `userInfo` throws unless the user is gone (404), so an email skipped during an auth cold start is retried instead of dropped. The follower and learner list queries are still logged and skipped on failure, as before.
- **Unique inbox index.** The entity declares `UQ_inbox_notifications_source_event` by name with its `WHERE`; the migration adds `NULLS NOT DISTINCT`, which TypeORM can't express (db:check accepts it). The indexes are built `CONCURRENTLY` in a `transaction = false` migration, and every statement is repeatable after a part-way failure.
- **`/ready` is a plain route, not a Nest controller.** `bootstrapService` registers it on the HTTP adapter with a `Readiness` instance (`common/src/ready.ts`), outside the prefix and the internal-token check like `/health`. Auth adds its Redis `PING` through a new `readyChecks` bootstrap option. This avoided wrapping every app module to inject the database, the bus and auth's Redis into one controller. `/health` gets the name through `setServiceName`, which `bootstrapService` calls before the app is built.
- **CI.** The gateway's wait now fails the step on timeout, and the per-service wait in the drift-check step polls `/ready` and prints the failing body.
- **Spec helper.** Quality's fake `DataSource` lives in `src/testing/` and is excluded from the build, as financial's helpers are.
- **Step 10 runs on the real broker** with no test-only code: the drill restarts notification with SMTP on a closed port, a 3 s retry delay and 3 attempts, and starts a small SMTP sink for the success path. It's committed as `scripts/e2e-retry-drill.mjs`, local only like the outage drill, so the reviewer can rerun it.
- **The retry delay is whole seconds** (review N3): `EVENT_RETRY_DELAY_MS` is rounded, so the retry queue's name and its TTL always agree.

**Steps 9–11 done.** Stack gate with the api built at `297d8b2` (the code as at `7edbd06`: the later commits before `a6f2dd2` change only scripts and docs) and the retry drill from `f9e0e8e`, on a fresh `el_9a_e2e`, exit 0:
- stack: seed, all 7 `/ready` 200 (auth with `redis: ok`), `db:check` no drift; the resend-verification cap on real Postgres;
- the six CI e2e scripts (demo-seed, e2e-revisions, e2e-institution, e2e-payments, e2e-learning, e2e-security): 205 checks, none failed;
- the web build (clean env); Playwright 106 passed; smoke 17/17.

The first gate run was killed from outside (exit 143) during Playwright when the session that started it ended. It was rerun from scratch; no check failed in either run.

Step 9, `node scripts/e2e-broker-outage.mjs` (outage 90 s), 17/17:
- before: every service process running and ready, `/health` names the service, a QO approval publishes the course;
- outage: every `/ready` 503 with `broker: down` and `db: ok`; a QO decision fails fast with 503 in 5.0 s, and the undelivered decision is reverted (the item is still queued); every `/health` stayed 200; no process exited;
- recovery: every service ready again in 35 s with the same PIDs; a free enrollment after the outage reaches course (`enrolled_count` 1) and notification (one inbox row); the reverted decision can be made again.

Step 10, `node scripts/e2e-retry-drill.mjs`, 11/11:
- A, the send keeps failing: parked after 3 attempts in 6.8 s (two 3 s delays), each attempt logged `failed`, one inbox row across the attempts, and the error log names it: `event parked: EnrollmentCreated (…) handler notification:EnrollmentCreated:0 failed 3 times: connect ECONNREFUSED 127.0.0.1:2626`;
- B, the first send fails and the retry succeeds: the log reads `failed, sent` (4.1 s), one inbox row, the SMTP sink got exactly one message, and nothing more was parked;
- notification restarted on its normal env and the drill queues were removed.

**Code review round 1 fixes** (`a6f2dd2`, see code-review.md): B1, S1, S2 and N1–N3. Unit gate on `a6f2dd2`: build ok; `pnpm -C api test` 1333 passed, 1 skipped (9 new specs); typecheck ok. No entity or migration changed. The drills weren't rerun on `a6f2dd2`, because the stack window went back to 8b. S1 changes the supervisor's `kick()`, which the outage drill exercises, so 9b's stack gate, which builds on this branch, reruns both drills.

**Code review:** round 1 CHANGES REQUESTED, fixed in `a6f2dd2`. Round 2 APPROVED, with S3 (a flaky certificate spec) fixed in `15a7834`; the full api suite was then green 5 of 5 times.

**In flight / next step:**
- 9a is APPROVED and held: no push. It ships with 9b (`fix/outbox`, branched from here, in `../ethi0-9b`) once 9b is APPROVED. ethio-planner [aeff2b] is told.
- Any later 9a fix lands here first and is then merged into `fix/outbox`.
