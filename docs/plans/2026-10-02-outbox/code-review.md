# Phase 9b: code review (ethio-reviewer)

## Reviewer state (2026-10-03)
- **Queue:** 9b round 1, then 9c, then 9d. Each starts when its implementer asks.
- **Early reads:** done for 9b (this file) and 9c (`../2026-10-02-calls-and-jobs/code-review.md`). ethio-planner relayed S1 and S2.
- **Peers:**
  - 9b: ethio-impl (4) [5e6b60], which replaced [572e5c];
  - 9c: ethio-impl [9be294];
  - 9d: ethio-impl [796289], in `../ethi0-9d`;
  - planner: ethio-planner [31d0d2].
  - Send each APPROVED to the implementer and to the planner.
- **Review worktree:** `../ethi0-review-6a`, detached; it was last at `5c62f68`. Run `pnpm -C packages/contracts build && pnpm -C packages/common build` before service specs, and run jest from `api/`.

## Early read (before round 1, 2026-10-03)
ethio-planner asked for this while step 4 is still under way. It isn't a review round and has no verdict, and round 1 still covers the whole diff.

**What I read:**
- `957d59e`, step 2: `outbox.ts`, the `run-once.ts` scope, `publishConfirmed({ eventId })`, the module option and `outbox.spec.ts`;
- `3f50dd3`, step 3: the six outbox migrations and their wiring;
- `82d7e64`, the migration-order spec fix.

I didn't read the 9a merge (`e46b4b2`); that's 9a's approved code.

**My gate, run in the review worktree `../ethi0-review-6a` detached at `957d59e` (lockfile unchanged):**
- `jest packages/common/src/events`: 3 suites, 39 passed;
- common `tsc --noEmit`: clean.
- The "worker failed to exit" warning comes from 9a's event-bus and run-once specs, not from `outbox.spec.ts`.

### The logged deviation: the nesting guard is an AsyncLocalStorage scope
It's sound, and better than the plan's check.
- **Why the plan's check couldn't work:** `outbox.transaction` takes no manager, and `dataSource.transaction` always opens a fresh query runner. So `m.queryRunner?.isTransactionActive` would never be true at the point of the check.
- **What the scope catches:** `runOnce` and `outbox.transaction` both enter it, and Node restores the caller's own context after `await runOnce(...)`. So quality's `recomputeTier` and `raiseFraudSignal`, which run after their `runOnce` returns, aren't refused.
- **What it can't see:** a plain `dataSource.transaction` or `manager.transaction`. An `outbox.transaction` called inside one would commit on its own second connection, before the outer transaction does, and would hold 2 of the 3 pool connections. **In round 1 I'll check** that no step 4 site does this, including the `withRetry` sites in `revision.service.ts`.

### Should-fix
**S1. The fast path and the relay often both send the same row, and notification's dedupe can't stop the second email when both copies arrive together** (`outbox.ts:133`, `:147-161`, `:177-205`).
- **How it happens:** after commit, the detached fast path publishes a row and waits for the broker's confirm. It sets `published_at` only after that. A relay tick that starts inside that window selects the same row (still unpublished) and publishes it too.
- **Result:** two copies with the same `event_id` reach the queue milliseconds apart.
  - `runOnce` consumers are fine: the second copy waits on the `processed_events` key and then does nothing.
  - Notification isn't. With `EVENT_PREFETCH=4` both copies are handled at once. Its dedupe (`notification.service.ts:716-733`) checks for an earlier `sent` row, then sends, then logs. Both copies pass the check, so the user gets two emails.
- **Scenario:** a user registers. Their verification email goes out twice whenever a relay tick lands inside the fast path's window.
  - The odds per event are roughly the window divided by 5 s. Assuming a 20–100 ms window (my estimate, not measured: one Neon query, a broker confirm and one update), that's one event in 50 to 250.
  - The same goes for every outbox event with an email consumer: `CourseCompleted`, `RefundApproved`, `EnrollmentCreated` and the others.
- **Fix (a few lines):**
  - keep an in-process `inFlight` set of row ids;
  - `fastPath` adds its rows' ids before sending and removes them in a `finally`;
  - the relay's loop `break`s at the first row in the set. Stopping there instead of skipping the row keeps the order.
- **Spec:** start a fast path whose publish is held, run `relay()` while it's held, then release it → each row is published once.

**S2. A broker reconnect started inside a `runOnce` or `outbox.transaction` body leaves every later delivery inside the transaction scope. From then on, every consumer that calls `outbox.transaction` throws** (`event-bus.service.ts:169-174`, `:206-217`, `:292-295` at `82d7e64`).
- **How it happens:**
  1. `kick()` calls `supervise()` synchronously, in the caller's async context. `waitForChannel` kicks from any `publish`, `publishConfirmed` or `publishCommand` made while the channel is down.
  2. The amqp socket that `open()` creates inherits that context, and Node runs every callback on that socket, including each delivery, inside it.
  3. The connection's `close` handler later kicks from the same context, so the leak survives reconnects.
- **Proven in Node 22:** a 15-line script creates a socket inside `scope.run(true, …)`. Its data callbacks see `scope.getStore() === true`, while the caller's own store after the `await` is `undefined`. With the fix below, the callbacks see `undefined`.
- **Scenario:**
  1. A step 4 site, or a later handler, calls `bus.publish()` inside a `runOnce` or `outbox.transaction` body while the broker is down. An example is a converted site that keeps a notification-only publish inside its transaction.
  2. The reconnect runs inside the scope.
  3. From then on, every delivery runs inside the scope. Enrollment's `PaymentConfirmed` and `SponsorshipGranted` handlers emit `EnrollmentCreated` through `outbox.transaction` (decision 4), so they throw "cannot run inside another transaction". 9a retries them and then parks them, and the learner who paid gets no access until someone replays the parked messages.
- **Today:** no `runOnce` body publishes (I checked quality's and course's), so this can't happen yet. It becomes possible with step 4. That's why it's should-fix and not a blocker; fixing it before step 4 is cheapest.
- **Fix (two lines in `EventBusService`):**
  - add `private readonly detached = AsyncLocalStorage.snapshot();`. It's taken at construction, outside any request or transaction.
  - in `kick()`, use `this.supervising = this.detached(() => this.supervise()).finally(…)`.
  - This also covers 9d's `requestContext`, so 9d's planned `requestContext.exit` around the supervisor (9d review N3) becomes unnecessary. I'll tell ethio-planner.
- **Spec:** kick a reconnect from inside `inTransactionScope(…)`, deliver an event whose handler calls `outbox.transaction` → it runs instead of throwing.

### Migrations (`3f50dd3`): no findings
- The six tables match decision 1 and the entity: column types, the `clock_timestamp()` default and the partial index `(created_at) WHERE published_at IS NULL`. `down()` drops the index and then the table.
- Every schema uses the same name for the primary key and the index. That's fine: Postgres scopes index names to the schema, and TypeORM names primary keys from the bare table name, so `db:check` expects exactly that.
- The tables are new and empty, so building the index in the same transaction locks nothing in use.
- Migrations run on boot before the service listens (`DEPLOYMENT.md`), so the relay's first tick finds its table. Nothing emits yet, so deploying `3f50dd3` alone changes nothing.
- **For round 1:** quality's fraud-signal migration (Data model steps 1, 1a and 2) must come after `Outbox1791054805346` in quality's `migrations/index.ts`, because step 1a inserts outbox rows.

### Early read response (impl, 3555c6f)
- **S1: fixed as suggested, in both directions.**
  - `OutboxService.inFlight` holds the ids being published.
  - The fast path marks all of its rows at its start, before the order check, and clears them in a `finally`. If the relay is already sending one of them, the fast path returns and leaves them to the relay.
  - The relay marks each row while it sends it, and `break`s at a row the fast path holds, so the order is kept; the next tick goes on from there.
  - Spec `outbox.spec.ts` "a relay tick during the fast path confirm wait leaves the row to it, so the row is sent once": the fast path's first publish is held, a relay tick sends nothing, and after release each of the two rows goes out once, in order. It fails with the relay's check removed.
  - Left open, as negligible: a relay batch read just before a commit could still resend a row if the fast path finished publishing and marking it before the relay's loop reached it. The fast path's order check makes that need three round trips to finish inside one, so I didn't add a published re-check per row.
- **S2: fixed as suggested.** `EventBusService.detached = AsyncLocalStorage.snapshot()` is taken at construction, and `kick()` runs `supervise()` inside it.
  - The spec's fake connection now delivers inside the context it was opened in, as a real socket's callbacks do.
  - Spec `event-bus.service.spec.ts` "a reconnect kicked inside a transaction body leaves later deliveries outside it": the connection drops inside `inTransactionScope`, and after the reconnect a delivered event's handler runs `outbox.transaction` (returns `'ran'`). It fails without the snapshot, with the "cannot run inside another transaction" error.
- **Your round 1 notes are taken:** the `withRetry` sites and plain `dataSource.transaction` nesting in step 4, and quality's fraud-signal migration after `Outbox1791054805346`.
- **Gate at 3555c6f:** api build and typecheck clean; `pnpm -C api test` 1346 passed, 1 skipped.
