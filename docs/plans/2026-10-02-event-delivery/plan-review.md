# Plan review: Phase 9a, event bus resilience and safe consumers

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)"), against the code at `2cdccf9`. I also read 9b's site list (`docs/plans/2026-10-02-outbox/plan.md`), because S1 depends on it.

Verified as the plan states:
- **Bus:** `connecting` is cached after the 60th failure (`event-bus.service.ts:137-141,200`), the close handler reconnects only once (`:183-191`), and `ack` sits outside the try (`:227,244`).
- **Handlers:** every subscriber outside the plan's change list is idempotent, or is listed as already idempotent. The one unlisted handler, quality's `CourseReviewWithdrawn`, is a conditional `UPDATE … WHERE status IN (open)`.
- **Financial:** the `FraudFlagRaised` hold is keyed by `flag_id` (`payout.service.ts:47-57`).
- **Inbox dedupe key:** no notification handler writes two inbox rows with the same user or role and the same `type` for one event. `RefundApproved` writes the learner plus the admin role; `SponsorshipGranted` writes `gift` plus `gift_delivered`.

### Answers to the planner's questions
1. **Retry and park queues next to an untouched main queue (decision 3): agree.**
   - The main queue keeps `{ durable: true }` with no arguments (`:212`).
   - Dead-lettering through the default exchange with routing key `<service>.events` reaches only this service.
   - Putting the delay in the retry queue's name avoids a redeclare conflict.
   - Two cautions:
     - say the parked queue's arguments are never changed without renaming it;
     - a `PRECONDITION_FAILED`, like any channel error, closes only the channel, which the supervisor doesn't handle yet (S2).
2. **Idempotency (decision 5):**
   - **`runOnce`:** right. The marker and the effect commit together, and a concurrent duplicate waits on the primary key until the first commits, then skips.
   - **The atomic `payee_stats` upsert:** right.
   - **The fraud dedupe:** has a gap until 9b ships (S1).
   - **The migration:** Phase 2's convention already drops before it builds (`auth/…/1790956067652-IndexTuning.ts:7-11`), so an INVALID index from a failed `CONCURRENTLY` build gets rebuilt. Keep the duplicate resolution in the same migration, just before the build, so a re-run repeats both.
   - **The enqueue handlers:** see B1.
3. **Render's `healthCheckPath` stays `/health` (decision 6): agree.** A readiness check as the health check would bounce instances during a Neon wake-up or a CloudAMQP blip. `/ready` needs S3.
4. **An appeal retried after a withdraw (Risks): checked, and harmless.**
   - An appeal moves the course from `flagged` to `submitted`, and a withdraw moves it from `submitted` to `draft` (`course.service.ts:948-958,1011-1018`).
   - A late appeal item becomes decidable. But `onCourseReviewed` applies an approval only to a course in review or flagged (`:195-206`), and logs anything else as stale.
   - The course's next submission closes the stale item (`closeOpenItems`, `quality.service.ts:209`).
   - What's left is a stale entry in the QO queue until then. Worth one line in Risks.

### Blockers
- **B1. A retried `CourseSubmitted` or `CourseRevisionSubmitted` loses its AI screen** at decision 5 ("quality enqueue handlers … run their inserts in `runOnce`")
  Scenario:
  - `enqueueSubmission` commits the item, runs the Groq screen (up to about 25 s), then `recordScreen` and `raisePlagiarismSignal` (`quality.service.ts:202-232`; the revision path is the same, `:263-310`).
  - Suppose `recordScreen` hits a Neon connection reset, or the broker drops so the ack fails and the message is redelivered.
  - The retry's `runOnce` finds the event already processed and skips the insert. There's no `item` to screen, and nothing links the event to the item it created.
  - The item keeps `plagiarism: { pending: true }` for good. A revision's priority stays 0, and a plagiarism hit never raises its signal, so that educator's payouts are never held.
  - Today a redelivery (the ack-failure case) closes the old item and screens a new one. With the plan as written, the retry the phase exists to add does nothing here.

  Suggested fix: on a skip, the handler finds the item this event created. If the item is still open and `plagiarism.pending` is true, it finishes the screen, then the signal. Two ways to find the item:
  - `runOnce` stores `fn`'s small result (`processed_events.result jsonb`, e.g. `{ item_id }`) and returns it on a skip; or
  - add `source_event_id` to `qa_review_items`.

  Add a spec: the screen step throws once, the retry records the screen and raises the signal, and still only one item exists.

  Response: fixed. `runOnce` stores `fn`'s small result in `processed_events.result` and returns `{ ran, result }`. The enqueue handlers return `{ item_id }`. On a skip they load the item and, if it's still open with `plagiarism.pending`, finish the screen and the plagiarism signal (decision 5). Step 6 adds your spec: the screen throws once, the retry completes it, and there's one item.

### Should-fix
- **S1. Until 9b ships, the fraud dedupe can drop a payout hold** at decision 5 (`raiseFraudSignal`)
  - **The trigger:** the broker connection drops between the signal insert and its publish (`quality.service.ts:696-713`). The publish fails and the ack fails, so the event is redelivered.
  - **Today:** the redelivery inserts a second open signal and publishes, so financial holds the payee.
  - **With 9a:** the insert conflicts and nothing is published. `FraudFlagRaised` never reaches financial (`payout.service.ts:47`), and payouts go out despite an open plagiarism flag.
  - **9b already fixes this:** its site list commits the fraud insert and its outbox row in one transaction (9b plan, lines 70 and 117).

  Suggested: move the fraud-signal dedupe (the partial unique index, `ON CONFLICT`, publish only on insert) into 9b, so it lands with the outbox. Or keep it here and state in Rollout that 9a and 9b deploy together.

  Response: fixed by moving it. The fraud-signal dedupe (partial unique index, duplicate resolution, `ON CONFLICT`, emit only on insert) is now in 9b, in the same transaction as the outbox row. 9a leaves `raiseFraudSignal` as is and says so in decision 5 and Rollout: duplicates until 9b err toward holding payouts. The pre-merge duplicate count moved to 9b's Rollout.
- **S2. A channel that closes on its own stops consuming, and `/ready` still says the broker is up** at decision 1 (listeners)
  - **The gap:** the supervisor reacts only to the connection's `close`, but RabbitMQ closes just the channel on any channel-level error. For example:
    - a 406 `PRECONDITION_FAILED` on an unknown delivery tag, when an ack for a message delivered before a reconnect is sent on the new channel, or a message is acked twice in an error path;
    - a redeclare with different arguments;
    - a 404 on a missing exchange.
  - **What breaks:** `this.channel` is cleared only on connection close (`:184`), so the closed channel stays cached. Every later `publish` throws, consumers on it are gone, and `isConnected()` still reports the connection as up.

  Suggested:
  - when a channel closes while not shutting down, drop it and re-run setup (or close the connection to take the full reconnect path);
  - `isConnected()` also checks the channels;
  - ack and nack always on the channel that delivered the message, captured at consume time;
  - a spec: a channel `close` with the connection still open → consumers re-registered and `publish` works.

  Response: fixed. Decision 1: a channel that closes on its own is dropped and set up again (reopen, re-assert, re-consume); ack and nack use the delivering channel captured at consume time; `isConnected()` needs the connection and the main channel open. Step 3 adds your spec.
- **S3. `/ready` puts an unauthenticated DB query on seven public URLs that the gateway's rate limits don't cover** at decision 6
  - **Why it's reachable:** each service is a public Render `web` service (`render.yaml:180-279`). The internal-token check lets only `/health` through (`bootstrap.ts:46`), and decision 6 adds `/ready` to that exception.
  - **What breaks:** a loop on `https://ethiopialearn-<service>.onrender.com/ready` makes every request take one of `DB_POOL_MAX=3` connections, for up to 2 s while Neon is slow, plus a Redis `PING` on auth. Real gateway traffic then queues behind it.

  Suggested: compute readiness at most once every 5 s per instance, with a single in-flight check whose promise concurrent callers share, and serve the cached result in between. Add a spec: 50 concurrent `/ready` calls → one `SELECT 1`.

  Response: fixed. Decision 6: readiness is computed at most every 5 s per instance, and concurrent callers share one in-flight check. Step 8 adds the spec: 50 calls → one `SELECT 1`.

### Nits (optional, max 3)
- **N1.** TypeORM 0.3.30 can't express `NULLS NOT DISTINCT` in `@Index`, and its schema builder drops indexes that an entity doesn't declare, so `db:check` would show a pending `DROP INDEX`. Declare the index on the entity by name with the same columns, `unique` and `where`; add `NULLS NOT DISTINCT` in the migration; confirm `db:check` stays clean.
- **N2.** `runOnce` keys must be stable. The default handler name `<service>:<event_type>:<index>` shifts when someone adds a handler ahead of it, and a redelivery after that deploy re-runs a deduped effect. Require an explicit `name` for every handler that uses `runOnce`.
- **N3.** `processed_events` grows by one row per event per deduped consumer. That's fine now; put a prune (e.g. rows older than 30 days) on 9c's job list.

### Planner responses to the nits and cautions
- **N1:** taken. The entity declares the inbox index by name, and the migration adds `NULLS NOT DISTINCT`. Step 7 confirms `db:check` stays clean.
- **N2:** taken. Every `runOnce` handler must pass an explicit `name`, and `runOnce` refuses one without it (spec in step 6).
- **N3:** taken without a scheduler. `runOnce` prunes about one call in 1,000 (up to 1,000 rows older than 30 days).
- **Cautions from your answers:**
  - the parked queue's arguments never change without a new name (decision 3);
  - the duplicate resolution and the index build stay in one migration, now in 9b;
  - the appeal-after-withdraw case is in Risks as you described it.


## Round 2 (2026-10-03) · Verdict: APPROVED (checks the round-1 fixes only)
Reviewed: `plan.md` (status "in review (round 2)").

Resolved:
- **B1:** `runOnce` stores `fn`'s small result in `processed_events.result` and returns `{ ran, result }`. On a skip, the enqueue handlers load the stored item and finish the screen and the signal if it's still open with `plagiarism.pending`. Step 6 has the throw-once spec.
- **S1:** the fraud dedupe moved to 9b, and `raiseFraudSignal` is unchanged here (decision 5). The pre-merge count moved too. 9b's round-1 B2 covers the holds that the duplicate resolution would orphan.
- **S2:** a channel that closes on its own is reopened, re-asserted and re-consumed. Acks use the delivering channel, `isConnected()` needs the connection and the main channel, and step 3 has the specs.
- **S3:** readiness is cached for 5 s, with one check in flight; spec: 50 calls → one `SELECT 1`.
- **N1–N3 and the cautions:** all taken. The `runOnce` prune runs in-process, so no scheduler is needed.

No new blockers.
