# Phase 9a: code review (ethio-reviewer)

## Round 1 (2026-10-03) · Verdict: CHANGES REQUESTED (one blocker, a small loop change)
Reviewed `git diff 03fd049...fa06f83`. ethio-planner asked for the review before the stack gate finished. The worktree has since moved to `f9e0e8e` (`297d8b2` plan.md, `f9e0e8e` adds `scripts/e2e-retry-drill.mjs`, test-only), which I didn't review line by line.

I read the event bus (`event-bus.service.ts`) and its spec myself. Two agents covered notification and the migrations, and runOnce, quality, course, outcomes, `/ready`, auth and CI. I checked each finding below against the code.

**Gate (my run, review worktree `../ethi0-review-6a` detached at `fa06f83`, lockfile unchanged):** api build and typecheck clean; jest 1324 passed, 1 skipped. The stack gate (db:check, e2e, Playwright, the drills) is impl's and still running.

### Blocker
**B1. A notification fan-out stops at the first failed recipient, and the rest lose their in-app rows too.** This is a regression from base.
- **Where:** `notification.service.ts` `notifyNewCourseFollowers` (:430-446) and `notifyCourseUpdated` (:620-628).
- **Before 9a:** `inbox()` and `deliver()` swallowed errors for each recipient.
- **Now:** the first throw leaves the loop.
- **Scenario:** a CourseUpdated to 800 learners when the email provider's daily quota (Brevo free: 300 a day) runs out at learner 300, or when one recipient's address is rejected outright.
  1. The handler throws at learner 300. Learners 301–800 get neither the inbox row nor the email.
  2. Every retry fails at the same point. After 5 attempts the event is parked, and those 500 in-app notifications are lost for good.
- **Fix:** inside each fan-out loop, catch per recipient, remember the first error, and rethrow it after the loop. The retry then skips the recipients already done (the inbox and deliver dedupe) and tries only the failed ones again. Add a spec: send fails for recipient 2 of 3 → recipient 3 still gets its inbox row and email, and the handler throws.

### Should-fix
**S1. Opening a channel again can race the supervisor into a second connection** (`event-bus.service.ts:157-162`, `:221-234`, `:281-283`).
- **Scenario:** the broker closes only the main channel and the connection stays up. That happens on a channel-level error, including RabbitMQ's `consumer_timeout`: a message left unacked for 30 minutes, for example a handler stuck on an outbound call with no timeout before 9c.
  1. The `close` handler sets `channel = null` and reopens on the same connection in `setImmediate`. `supervising` is null at this point.
  2. A `publish()` during the reopen's awaits calls `waitForChannel` → `kick()`. `isConnected()` is false, so `supervise()` runs `open()`, which creates a **second** connection and overwrites `this.connection`.
  3. Both setups finish. Both channels consume the queue, and one connection is leaked.
  4. When the leaked connection later drops, its channel's `close` nulls `this.channel` (if that was the leaked one), so `/ready` reports the broker down until the next publish opens a third connection.
- **Fix (one line):** in `kick()`, also return when `this.connection` is set. A failed reopen already closes the connection, and its `close` handler kicks the supervisor.
- **Spec:** `first.die()`, then `bus.publish()` before the reopen finishes → `broker.connections` has length 1.

**S2. `userInfo` still swallows its errors** (`notification.service.ts:640-646`). An email skipped because the auth lookup failed is acked instead of retried.
- **Scenario:** LearnerInactive, NewCourseAlert or CourseUpdated is consumed while auth is cold-starting on Render (30–50 s), exactly what the 5×60 s retry is for. The lookup returns `{ email: '' }`, the handler `continue`s or returns, and the email is never sent.
- **Fix:** keep returning empty for a 404 (a deleted user), and throw otherwise. Do this together with B1's catch per recipient, so one failed lookup doesn't stop the fan-out.

### Nits (optional)
- **N1.** `course.service.ts:179-181`: the runOnce callback returns `increment`'s `UpdateResult`. runOnce stores it as jsonb, which costs an extra `UPDATE` per enrollment. Use `async (m) => { await …; }`.
- **N2.** `bootstrap.ts` `/ready` route: the async handler has no try/catch. A `readyChecks` closure that throws synchronously leaves the request hanging and becomes an unhandled rejection. Wrap it and answer 503.
- **N3.** `retryQueue()` rounds the delay to seconds, while the TTL is the exact ms. Two values that round the same (60000 and 60400) declare one queue name with two TTLs → `PRECONDITION_FAILED` on every connect, and the service never consumes. Name it by ms, or document "whole seconds only" in `.env.example`.

### Checked, not findings
- **Bus:**
  - the supervisor never caches a failure (`supervising` is cleared in `finally`);
  - backoff 1→30 s with jitter;
  - `heartbeat` appended only when it's missing from the URL;
  - `error` listeners on the connection and every channel;
  - the main queue declared exactly as before;
  - the retry TTL queue dead-letters through `''` to this service's queue only;
  - `x-attempts` 1..4 retry, the 5th failure parks;
  - an unparseable message parks at once;
  - the republish is confirmed before the ack, and a failed republish nacks with requeue;
  - ack and nack go on the delivering channel and are wrapped;
  - `publishConfirmed`'s late rejection is caught;
  - `publish` waits at most `EVENT_PUBLISH_WAIT_MS` and then drains within the same budget.
- **Retries never re-run another handler's effect:** within each service, an event type has one handler (the duplicates are in different services, each with its own queue).
- **runOnce:** the marker and the effect commit together, a concurrent duplicate blocks on the PK and then skips, the stored result is resumable, pruning runs inside the effect's transaction, and an empty name or id is refused.
- **quality and course:**
  - `bumpStats` is one atomic upsert;
  - every write inside `fn` uses the manager;
  - tier and fraud checks run after the commit;
  - the B1 resume (re-screen an open item that is still `pending`) matches the plan.
- **outcomes:** a duplicate certificate returns before the publish.
- **notification:**
  - dedupe keys aren't wrongly shared within one event (refund learner and admin rows differ; gifts use two types);
  - every call is awaited;
  - `NotificationSent` is best-effort;
  - `.orIgnore()` has no conflict target, so the partial `NULLS NOT DISTINCT` index needs no inference.
- **Migrations:**
  - additive;
  - `CONCURRENTLY` with `transaction = false`;
  - repeatable (drop-if-exists before each create);
  - `down()` reverses `up()`;
  - registered in each service's `index.ts` and its entities.
- **`/ready`:** a 5 s cache with one shared in-flight check; a rejection is never cached; flags only in the body; outside the prefix and the token check. CI fails on timeout.
- **Accepted as 9b scope:**
  - a duplicate Groq screen and plagiarism signal when a channel drops mid-screen (`raiseFraudSignal` dedupe);
  - a `CertificateIssued` lost when its publish fails after the save.
- **Spec strength (not filed):** quality's and course's fake managers return the injected repositories, so a future `this.repo` write inside `fn` would go unnoticed. Today's code has none; worth tightening only if one of these handlers is touched again.

**Complexity check:** nothing extra. runOnce, `/ready` and the retry and park queues are what the plan asked for. There is no new dependency.

Round 2 will check B1 and S1–S2, if fixed, review only `fa06f83..<new head>` plus the drill script, and rerun api jest.

### Round 1 response (impl, a6f2dd2)
- **B1: fixed.** `notifyNewCourseFollowers` and `notifyCourseUpdated` run each recipient through `forEachRecipient`. It catches per recipient, notifies the rest, logs `<event> fan-out: N of M recipient(s) failed`, then rethrows the first error. On the retry, the inbox and deliver dedupe skip everyone already done. New specs, for each of CourseUpdated and CoursePublished: the send fails for recipient 2 of 3, recipient 3 still gets the inbox row and the email, and the handler throws; the retry sends only to recipient 2 and writes no second inbox rows. Both fail without the fix.
- **S1: fixed.** `kick()` returns while `this.connection` is set, so an open connection whose channel is reopening is left alone. A failed reopen closes the connection, and its close handler kicks the supervisor. New spec: `channel.die()`, then `publish()` → one connection, a second main channel, and the publish lands. It fails without the fix (two connections).
- **S2: fixed.** `userInfo` returns empty only on a 404 (the `endsWith('-> 404')` check `payment.service.ts:882` already uses) and throws otherwise. It's inside the per-recipient catch, so one failed lookup doesn't stop a fan-out. New specs:
  - a failed lookup for recipient 2 still notifies recipient 3, then throws (both fan-outs);
  - a 404 is skipped quietly;
  - LearnerInactive throws on a 503 lookup.

  Every `userInfo` caller now retries on a failed lookup, including SponsorshipGranted and CourseProgressMilestone, which could fall back to the payload's address. A failed lookup there now waits for the retry instead of sending without the name. I kept one rule for all callers.
- **N1: taken.** The enrolled-count `runOnce` body awaits the increment and returns nothing, so no result is stored.
- **N2: taken, in `probe()` rather than the route.** `Promise.resolve().then(fn)` turns a synchronous throw into a rejection, so the check counts as `down` and `/ready` answers 503. The new spec fails without it.
- **N3: taken.** `EVENT_RETRY_DELAY_MS` is rounded to whole seconds when it's read, so the queue name and the TTL always agree (60400 → `retry.60s` with TTL 60000). `.env.example` says so, and a new spec covers it.
- **Tests:** `a6f2dd2`: api build ok; jest 1333 passed, 1 skipped; typecheck ok.
- **Stack gate:** the full stack gate passed on the code as at `fa06f83` (plan.md, steps 9–11), including both drills. The drills weren't rerun on `a6f2dd2`; 9b's stack gate reruns them on top of these fixes.
