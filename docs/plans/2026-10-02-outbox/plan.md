# Phase 9b: Transactional outbox for state changes

Status: approved (round 2); drift check vs 9a (2026-10-03) D1–D2 folded in
Size: L (sessions: 4 — ethio-impl implements, ethio-plan-review reviews the plan, ethio-reviewer reviews the code)
Base branch: `fix/event-delivery` (Phase 9a), or `origin/main` once 9a has merged. This phase needs 9a's consumer retry, per-event context and dedupe, because an outbox delivers at least once. · Feature branch: `fix/outbox`
Roadmap: phase 9b (see 9a's "Roadmap change"). Findings: P1-17. Also gives Phase 4's re-publishes stable event ids, so 9a's dedupe recognizes them.

## Goal
When a service commits a state change that another service must react to, the event must go out even if the broker or the process fails right after the commit. Examples:
- a refund is approved, so access must be revoked;
- a course is completed, so a certificate must be issued;
- a user registers, so a verification email and any gifted seat must follow;
- a fraud flag is raised, so payouts must be held.

Today these publish after commit and are lost for good if that publish fails. Afterwards each one is written in the same transaction as its state change and delivered at least once, in order per service.

Acceptance criteria:
- **Every publish site in decision 2's table** enqueues its event in the same database transaction as the state change it announces.
- **A broker outage loses nothing.** With RabbitMQ stopped, each of these actions commits and then produces its effect within one relay tick after the broker returns, with no manual step:
  - completing a course (a certificate is issued);
  - approving a refund (access revoked);
  - registering (verification email);
  - raising a fraud flag (payout hold);
  - publishing a course (enrollment's course cache updated).
- **A crash between commit and publish loses nothing.** The relay picks up any committed, unpublished row.
- **Order per service:** events from sequential transactions in one service reach the broker in the order they were emitted. A newer event never overtakes an older unpublished one. Overlapping transactions have no defined order, and no consumer relies on one.
- **Duplicates are harmless:**
  - a re-sent event has the same `event_id` as the original, and 9a's dedupe absorbs it;
  - Phase 4's re-publish cron sends `PaymentConfirmed`, `SponsorshipGranted`, `SponsorshipInvited` and `BulkPurchaseActivated` with a stable `event_id` per payment and event type.
- **No added latency:** with the broker up, an event is published right after its transaction commits. With it down, emitting requests respond as fast as normal (under 1 s in the drill), because the response never waits for a publish.
- **Quality decisions stop reverting:** a QO decision commits with its event in the outbox. The current revert-and-503 when a publish fails (`quality.service.ts:464-474`) goes away, because the event can no longer be lost.

## Non-goals
- **Moving Phase 4's `PaymentConfirmed` path onto the outbox.** Its `effects_completed_at` and re-publish cron are reviewed, tested and working. This phase only gives them stable event ids.
- **Notification-only events.** For these the user can retry, or nothing else depends on them:
  - password reset, staff and instructor invites, `InstructorLinked`;
  - course unlisted, archived and institution-reviewed notices;
  - milestones, inactivity nudges, `CertificateIssued`;
  - payment failed or abandoned, wallet credited, referral invites, pay requests, payout notices;
  - `NotificationSent`;
  - 7b's `VerificationEmailRequested`;
  - `revision.service.ts:440` (`publishReturned`, a coach `CourseRevisionReviewed`), whose only state-changing consumer, the course service, ignores it.

  They keep a plain `publish()`, which after 9a fails fast. Moving one later is a one-line change per site.
- **Ordering across services,** exactly-once delivery, Debezium-style change data capture, or a separate relay process.
- **A replay UI.** Unpublished rows are visible in each schema's `outbox` table.

## Current state
At `2cdccf9`, plus what 9a adds (bounded `publish`, retry and park, `currentEvent()`, `runOnce`, dedupe on the consumers that need it).

- **No outbox.** Every publish except Phase 4's payment effects is a plain `publish()` after a committed write.
- **The publish sites that matter** (from the Phase 9 research; line numbers at `2cdccf9`; 6a, 6b and 6c change some of these files first, so re-find each site by its code):

  | Service | Event | Site | Consumed by (state change) | Today |
  |---|---|---|---|---|
  | financial | RefundApproved | `refund.service.ts:151` via `emitDecision` | enrollment revokes access; quality refund stats | after the flip (6c puts the decision and the flip in one transaction, then publishes after commit) |
  | financial | RefundDenied | `refund.service.ts:107` | notification | after save. In the same transaction as the decision, so included at no cost |
  | financial | SponsorshipGranted, SponsorshipInvited | `sponsorship.service.ts:429,435` (`grant`/`invite`, the claim-at-signup path) | enrollment grants access | after save; the payment path is already covered by Phase 4 |
  | auth | UserRegistered | `auth.service.ts:76` | financial claims gifted seats; notification sends the verification link | after two saves, no transaction |
  | enrollment | EnrollmentCreated | `enrollment.service.ts:572` | course `enrolled_count`; notification | after save |
  | enrollment | CourseCompleted | `enrollment.service.ts:621` | outcomes issues the certificate; quality stats; notification | after a conditional write. The row is then marked complete, so a lost event is never re-detected |
  | course | CoursePublished | `course.service.ts:212` | enrollment course cache | after the status change |
  | course | CourseSubmitted | `course.service.ts:731,832` | quality review queue | after save |
  | course | CourseReviewWithdrawn | `course.service.ts:935,957,973`; `revision.service.ts:237` | quality closes items | after save |
  | course | CourseAppealSubmitted | `course.service.ts:1019` | quality queue | after save |
  | course | CourseRevisionSubmitted | `revision.service.ts:658` | quality queue | after save |
  | course | CourseRevisionClosed, CourseUpdated | `revision.service.ts:273,330,345,510` | enrollment and outcomes apply or discard; notification | after the apply transaction inside an in-process `withRetry` |
  | quality | CourseReviewed, CourseRevisionReviewed | `quality.service.ts:480,496` (`publishDecision`) | course publishes or applies | after a conditional update; reverts and returns 503 if the publish throws |
  | quality | CourseRated | `quality.service.ts:610` | course rating | after save |
  | quality | TrustTierChanged | `quality.service.ts:677` | outcomes tier cache | after save |
  | quality | FraudFlagRaised, FraudFlagResolved | `quality.service.ts:706,732` | financial holds or releases payouts | after save. A redelivery opens a duplicate open signal; the dedupe moved here from 9a (plan-review 9a S1) |
  | outcomes | AssessmentPassed, AssessmentFailed | `assessment.service.ts:843` | outcomes issues the certificate; notification | after the attempt save |

- **Phase 4** (`payment.service.ts:537-590`): `completeEffects` publishes with `publishConfirmed` and then sets `effects_completed_at`, and a 2-minute cron re-publishes rows still missing it. Each publish builds a new random `event_id` (`event-bus.service.ts:168`), so 9a's dedupe can't recognize a re-publish. Quality's `PaymentConfirmed` stat bump would double-count it.
- **The pool** is 3 connections per service on Render. A free instance sleeps after 15 idle minutes and runs no timers while asleep.

## Design and key decisions
1. **One outbox table per schema, and a transaction helper that emits:**
   - **Table:** `outbox (id uuid PRIMARY KEY, event_type varchar(64) NOT NULL, payload jsonb NOT NULL, correlation_id uuid NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), published_at timestamptz NULL, attempts int NOT NULL DEFAULT 0, last_error varchar(500) NULL)`, with a partial index `(created_at) WHERE published_at IS NULL`.
   - **`id` is the event's `event_id`,** so every re-send carries the same id and 9a's consumers dedupe it.
   - **Where it lives:** `OutboxEvent` entity and `OutboxService` in `packages/common`, wired by `EventBusModule.forRoot({ serviceName, outbox: true })` in the six services that emit through it (auth, course, enrollment, financial, quality, outcomes).
   - **API:**
     ```ts
     await this.outbox.transaction(async (m, emit) => {
       // state change through m
       emit('RefundApproved', payload, { correlationId });
     });
     ```
     `emit` inserts the row through `m`, inside the caller's transaction, with `created_at = clock_timestamp()` at emit time (not the transaction's start time).
     - **No nesting:** `outbox.transaction` refuses to run inside an already active transaction (`m.queryRunner?.isTransactionActive`). Nested, TypeORM would use a savepoint, and the fast path would publish on the savepoint's release, before the real commit. After the transaction commits, the helper tries to publish the rows it emitted right away (the fast path, decision 3). Sites that already use `dataSource.transaction` switch to `outbox.transaction`. Sites that don't have a transaction get one.
   - **`publishConfirmed` gains an `eventId` option,** used by the relay and by Phase 4 (decision 5).
   - **Rejected:**
     - publishing inside the transaction (a rollback after a publish announces something that never happened);
     - a TypeORM subscriber `afterTransactionCommit` (it fires per entity manager, not per business transaction, and is easy to miss in tests);
     - one shared outbox schema (services own their schemas, Phase 2).
2. **What moves to the outbox:** exactly the table in Current state. The rule: another service changes state on the event, or (`UserRegistered`) the user's first email depends on it. Everything else stays on `publish()` (Non-goals).
3. **Delivery: a fast path plus a relay, both in order:**
   - **Fast path:**
     - after commit, the helper starts publishing its rows with `publishConfirmed({ eventId: row.id })` and sets `published_at`;
     - the caller's response never waits for it: it runs detached, and its errors are caught and logged, leaving the rows to the relay;
     - it's skipped entirely when `!bus.isConnected()` (9a), so an outage costs requests nothing;
     - it's also skipped when an older unpublished row exists in this schema, one indexed `EXISTS` check, which keeps sequential events in order.
   - **Relay:** inside the service, a `setInterval` of `OUTBOX_POLL_MS` (default 5000), unref'd, with an in-process re-entrancy flag, started on bootstrap and stopped on shutdown. Each tick:
     1. `SELECT … FROM outbox WHERE published_at IS NULL ORDER BY created_at, id LIMIT 50`, with no lock and no open transaction;
     2. publish each row in order;
     3. set `published_at` with `UPDATE … WHERE id = $1 AND published_at IS NULL`;
     4. stop the batch at the first failure, incrementing `attempts` and recording `last_error`, so order holds.
   - **No lock held while publishing,** so no transaction stays open across broker round-trips on a 3-connection pool.
   - Two instances could send the same row. The in-process flag guards one instance, and Render's free plan runs one; 9a's dedupe absorbs any duplicate. `SKIP LOCKED` would prevent nothing without a held lock, so it isn't used.
   - **Cleanup:** the same loop deletes published rows older than 7 days (`OUTBOX_RETENTION_DAYS`) once an hour, 500 at a time.
   - **Asleep on the free tier:** rows left by an outage go out on the first tick after the service wakes, either on its next request or on 9c's scheduler ping. Log `outbox relay: N events older than 10 min still unpublished` at warn, once per tick when it applies, so a stuck relay is visible.
   - **Rejected:**
     - LISTEN/NOTIFY (Neon's pooled connections don't hold LISTEN);
     - a separate relay worker (a ninth free service that also sleeps).
4. **Converting the sites:**
   - **financial refunds:** `decide`/`finalizeApproval` (one transaction after 6c) emit `RefundApproved`/`RefundDenied` inside it. Payloads stay as they are today.
   - **financial sponsorship `grant`/`invite`** (the claim path): the save and the emit go in one transaction.
   - **auth signup:** user, verification token and `UserRegistered` in one transaction. The two saves at `auth.service.ts:54-82` don't share one today.
   - **enrollment:**
     - `publishEnrollmentCreated` callers emit inside the transaction that activates the entitlement;
     - `detectCompletion` keeps its lookups in their try/catch, as today (`enrollment.service.ts:604-631`). The conditional `completed_at` write and the `CourseCompleted` row commit in one transaction, carrying whatever the lookups returned. A completion never depends on auth or course being awake (plan-review B1).
     - **Consumers fill in missing names:**
       - outcomes' `issue()` fetches the learner's name (and the educator's) when the payload has none, and throws if that fails, so 9a's retry outlasts a waking service;
       - notification's `CourseCompleted` handler does the same for the learner's email.
       - This also ends today's blank-name certificates.
   - **course:** each status transition and its event go in one transaction. The `withRetry` sites in `revision.service.ts` keep their retry for the apply itself and emit inside the applied transaction.
   - **quality `publishDecision`:** the conditional status update and the emit go in one transaction. The revert-and-503 path is deleted.
   - **quality `CourseRated`, `TrustTierChanged` and fraud resolve:** each save and its emit go in one transaction.
   - **quality fraud raise, with the dedupe moved here from 9a:**
     - `raiseFraudSignal` inserts with `ON CONFLICT DO NOTHING`, against a new partial unique index on `fraud_signals (subject_type, subject_id, signal_type) WHERE status = 'open'`;
     - it emits `FraudFlagRaised` in the same transaction, only when a row was inserted;
     - because the insert and the outbox row commit together, a redelivery that hits the conflict loses nothing: the original event is already in the outbox.
     - This also stops 9a's retries from opening duplicate open signals.
   - **outcomes:** the attempt save and `AssessmentPassed`/`AssessmentFailed` go in one transaction.
   - Payload shapes don't change. Consumers see the same events, now with stable ids.
5. **Phase 4's events get stable ids:**
   - `completeEffects` and its cron pass `eventId = uuidv5(\`${payment.id}:${eventType}\`, NAMESPACE)` to `publishConfirmed`. The namespace is a constant in `packages/common`, and `uuid`'s v5 is already a transitive dependency; the implementer adds it explicitly if it isn't direct.
   - The same for the sponsorship events it emits.
   - A re-publish of the same payment's event then has the same id, so quality's stat bump (9a `runOnce`) counts it once.
6. **Payload size:** the largest outbox payloads (`CourseCompleted`, `UserRegistered`) are small JSON. No size cap beyond Postgres `jsonb`. The relay logs and skips nothing, because a row that can't be published blocks the queue by design (order). A row that has failed 20 times logs at error with its id. Fixing it is an operator action: a `published_at` update, with a runbook line in `docs/DEPLOYMENT.md`.

## Data model and migrations
- **quality, fraud signals** (moved from 9a). In one migration, before the index build, so a re-run repeats both:
  1. resolve duplicate open signals, keeping the oldest open one per `(subject_type, subject_id, signal_type)`. The others get `status = 'resolved'` with the note "duplicate", and the count is logged;
  1a. **for each duplicate it resolves,** insert a `FraudFlagResolved` outbox row with that signal's `flag_id` and `payee_id`, in the payload shape the resolve path already uses. The quality outbox table comes from an earlier migration in the same deploy. The relay delivers the rows, and financial drops those per-flag holds (`payout.service.ts:59-64`), so resolving the kept signal later releases the payee. Without them the orphaned holds would keep the payee held with no visible flag left (plan-review B2). Admins may get a "flag resolved" notice per duplicate, which is acceptable for a one-off cleanup.
  2. `CREATE UNIQUE INDEX CONCURRENTLY … ON fraud_signals (subject_type, subject_id, signal_type) WHERE status = 'open'`, in its own `transaction = false` migration, following Phase 2's drop-before-build convention.
  - The resolution isn't reversed in `down()`, which only drops the index. It touches only exact duplicates of an open signal.
  - Financial's holds are keyed by `flag_id`. Step 1a's events remove the duplicates' holds; the kept signal's hold stays until an admin resolves it.
- **Tables:** one migration per service (auth, course, enrollment, financial, quality, outcomes): `CREATE TABLE outbox (…)` plus `CREATE INDEX … ON outbox (created_at) WHERE published_at IS NULL`. New empty tables, so no lock concern. `down()` drops them.
- **Entities:** each service's TypeORM entity list adds `OutboxEvent`. `db:check` must show no drift.
- **Data:** no backfill. Events from before deploy are already delivered or lost; nothing to migrate.

## Configuration
Optional env, documented in `api/.env.example`:
- `OUTBOX_POLL_MS=5000`;
- `OUTBOX_RETENTION_DAYS=7`.

## Steps
- [ ] 1. Branch `fix/outbox` from `fix/event-delivery`.
- [ ] 2. Common:
  - `OutboxEvent`;
  - `OutboxService` (`transaction`/`emit`, fast path with the order check, relay, cleanup, stuck warning);
  - `publishConfirmed({ eventId })`;
  - the `EventBusModule` option.

  Specs, with a fake manager and bus:
  - emit inside a transaction that rolls back → no row and no publish;
  - commit → published and `published_at` set;
  - publish fails → row left, then the relay sends it with the same id;
  - an older unpublished row exists → the fast path defers, and the relay sends both in order;
  - a relay batch stops at the first failure;
  - cleanup deletes only old published rows.
- [ ] 3. Migrations for the six services. Apply on a fresh DB and on the dev DB; `migration:revert` round-trips; `db:check` clean.
- [ ] 4. Convert the sites (decision 4), one commit per service: financial, auth, enrollment, course, quality, outcomes.
  - Each service's existing specs stay green.
  - `outbox.transaction` inside an active transaction throws (spec).
  - Add one spec per converted site: the state change and the outbox row commit together, and an error before commit leaves neither.
  - Add a quality spec: a decision commits when the broker is down, and nothing reverts. It replaces 9a's `qa-review.spec.ts` "reopens the item when the decision event cannot be published", which goes with the revert-and-503 path (drift D1; the path is now `quality.service.ts` `decide` → `publishDecision`).
  - **No emit inside a `runOnce` body** (drift D2): `runOnce` owns a transaction and `outbox.transaction` refuses to nest, so a nested emit would throw on every delivery and park the event. Convert the fraud raise, `recomputeTier` (`TrustTierChanged`) and the plagiarism screen where they are, after `runOnce` commits.
  - Add fraud specs:
    - two refund approvals that trigger the same check → one open signal and one outbox row;
    - a redelivery after the insert committed → no new row, and the original outbox row still publishes;
    - a migration spec in the Phase 4 style for the duplicate resolution, asserting one `FraudFlagResolved` outbox row per resolved duplicate.
  - Add completion specs: auth down during `detectCompletion` → `completed_at` set and a `CourseCompleted` row with blank names; outcomes `issue()` with a blank name and auth down → throws (retried), and with auth up → fetches the name and issues.
- [ ] 5. Phase 4 stable ids (decision 5), plus a spec: two re-publishes of one payment carry the same `event_id`.
- [ ] 6. Outage drill. Extend 9a's `scripts/e2e-broker-outage.mjs`:
  1. with RabbitMQ stopped, run the five actions from the acceptance criteria through the API, and check each returns success, not a 503, in under 1 s;
  2. check each schema's `outbox` holds the unpublished rows;
  3. start RabbitMQ;
  4. within two relay ticks after 9a reconnects, check the effects: certificate row, enrollment revoked, verification email in the console provider's log, a payout hold row, enrollment's course cache updated.
  5. Check `outbox` rows have `published_at` set.
  6. Flip 9a's QO-decision checks (drift D1): during the outage the decision returns 2xx in under 1 s and the item leaves the queue (was: 503 within 6 s and the item reopens, `:157-160`); after reconnect the course reaches `published` within two relay ticks. Drop the "decide again" step (`:192`).

  Record the output in Progress.
- [ ] 7. Crash drill: in a spec or a scripted run, kill a service between commit and fast-path publish (inject a throw after commit in a test build), restart, and confirm the relay sends the row once.
- [ ] 8. Docs: `docs/DEPLOYMENT.md` gets an "Outbox" runbook section: what the table is, how to see stuck rows, and how to skip a poison row. Correct the README sweep claim only if it touches the outbox (the general scheduler docs are 9c's).
- [ ] 9. Full gate:
  - `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`;
  - the CI e2e scripts locally (`demo-seed`, `e2e-revisions`, `e2e-institution`, `e2e-payments`, `e2e-smoke`);
  - the Playwright suite is unaffected.
- [ ] 10. Code review by ethio-reviewer; the user approves push and PR.

## Test plan
- **Unit:** `OutboxService` (step 2), each converted site's commit-together behaviour (step 4), Phase 4 stable ids (step 5).
- **Local drills:** broker outage with the five effects (step 6), crash between commit and publish (step 7).
- **Regression:** all existing api specs and e2e scripts. `e2e-payments.mjs` covers Phase 4's exactly-once confirmation with the new ids.

## Rollout and ops
- **Before merge (the user, read-only):** count duplicate open fraud signals, so the migration's resolution count is expected: `SELECT subject_type, subject_id, signal_type, count(*) FROM quality.fraud_signals WHERE status = 'open' GROUP BY 1, 2, 3 HAVING count(*) > 1`.
- **Deploy order:**
  - Consumers already dedupe (9a), so producers can roll in any order.
  - The outbox tables are created at boot by migration.
  - Events emitted before a service's deploy follow today's path.
- **Watching:**
  - the warn line `outbox relay: N events older than 10 min still unpublished`, and `outbox row <id> failed 20 times` at error;
  - read-only SQL for the user: `SELECT event_type, count(*), min(created_at) FROM <schema>.outbox WHERE published_at IS NULL GROUP BY 1`.
- **Storage:** published rows are kept 7 days, a few thousand rows at today's volume.
- **No env required.**

## Risks and open questions
- **Order can't hold if a row can never be published** (decision 6): it blocks its service's queue by design. The error log and the runbook cover it. In practice publishing only fails while the broker is down, so the realistic failure is a malformed payload, which tests catch.
- **Wider transactions:** a few sites gain a transaction where they had two separate saves (auth signup, sponsorship claim). Each is a couple of inserts, so lock time is negligible.
- **`detectCompletion`:** completion commits even when lookups fail, and consumers fetch missing names and retry (decision 4). 6b rewrites the heartbeat path first, so the implementer applies this to 6b's version.
- **Events that stay on `publish()`** are still lost if the broker is down at that moment. The Non-goals list says which ones, and why each is acceptable.

## Progress and deviations (implementer)
