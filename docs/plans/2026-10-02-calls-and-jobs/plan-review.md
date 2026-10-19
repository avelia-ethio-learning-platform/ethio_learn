# Plan review: Phase 9c, outbound calls, scheduled jobs and status codes

## Round 1 (2026-10-03) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)"), against the code at `2cdccf9` and the hibernation finding (P0-09 update).

### Answers to the planner's questions
1. **The scheduler and the instance-hour budget (decision 7):** the mechanism is sound.
   - The jobs are woken from outside Render, run under leases, started through 202 endpoints, and use a separate token.
   - `permissions: {}` and `concurrency: jobs` are right.
   - The budget's framing has a gap (S1).
2. **The Chapa rewrite on the live path (decision 4): the approach is right.**
   - It copies the wire format from the installed SDK, pins it with fixtures, keeps mock e2e green, and watches the first real payment.
   - It also removes `axios@1.2.1`.
   - Keeping Chapa's validation body matters for the email fallback (S3); see also N2.
3. **The wallet double-purchase lock (decision 11): right lock, but the check misses the race** as the code stands (S2).

### Blockers
- **B1. A failed receipt lookup would hold back the event that grants access, not just the receipt** at decision 2 (`learnerInfoForReceipt` in `emitConfirmed`)
  - **The coupling:** `emitConfirmed` looks the learner up and then publishes `PaymentConfirmed`, "THE event that grants entitlement" (`payment.service.ts:793-811`). If the lookup throws, `PaymentConfirmed` isn't published at all.
  - **Scenario:**
    - a learner pays with Chapa, and financial confirms through the webhook or the learner's reconcile while auth is hibernating;
    - internal traffic doesn't wake auth, so the lookup gets the hibernation 429 (`PeerAsleepError`) and `PaymentConfirmed` isn't published;
    - `confirmPayment` swallows the effects error and returns success (`:500-508`), so the return page shows "confirmed" and the browser never sees a `service_waking` that would make Phase 5 wake auth;
    - financial's cron keeps calling a sleeping auth every 2 minutes.
  - **Result:** the learner has paid but has no access until a visitor or the 3-hourly schedule wakes auth. Today they get access at once, with a blank-email receipt.

  Suggested:
  - never gate `PaymentConfirmed` on the email; publish it with whatever the lookup returned, as today;
  - when `learner_email` is blank, notification looks it up itself (`userInfo`, `notification.service.ts:627`) and throws on a 503, so 9a's retry covers a short sleep (9b B1 used the same pattern);
  - then the schedule no longer needs auth for the receipt.

  Response: fixed as you suggested. `emitConfirmed` keeps `learnerInfo`'s blank default, so `PaymentConfirmed` (access) never waits on auth. Notification's email handlers look up a blank email through `userInfo` and throw on a 503, so 9a's retry delivers the receipt once auth wakes, and they skip with a warn on a 404. Decision 2, the acceptance criteria and step 3's specs are updated. The sweep no longer needs auth.

### Should-fix
- **S1. Size the schedule against the account-wide cap, and wake only what each job needs to run** at decision 7 (budget table)
  - **The cap:** the 750 free instance-hours are shared by every free service in the workspace. Per Render's free-tier docs, using them up suspends every free web service until the next month. So the schedule's 360 hours aren't "half the budget"; they come off whatever real traffic already uses. A gateway kept awake most of the day by visitors alone approaches 720 hours. The schedule then decides how early in the month the whole site goes dark.
  - **Unneeded wakes:** events wait in durable queues, and consumers process them on their next wake (any visitor's Phase 5 wake pings). Enrollment and notification don't need waking for the sweep; notification doesn't for payouts or inactivity.

  Suggested:
  - wake gateway, financial and auth for the sweep, and drop auth too once B1 moves the email lookup to notification; that's 120–180 hours instead of 300;
  - drop notification from the payouts and inactivity rows;
  - have the user read the current month's usage on Render's billing page before choosing the cadence;
  - state the suspension consequence in the docs and Risks.

  Response: fixed. The budget paragraph now states the workspace-wide cap and the suspension consequence. The sweep runs every 4 hours and wakes only gateway and financial. Payouts wake gateway, financial and auth. Inactivity wakes gateway, enrollment and course. Notification is never woken. That totals about 136 h. Rollout has the user read current usage on Render's billing page before enabling, and Risks repeats the consequence.
- **S2. The wallet check can miss the race it guards** at decision 11 ("Wallet double purchase")
  - **The gap:** `createSession` inserts the payment with `method: CHAPA` (`payment.service.ts:170-187`). The row becomes `wallet` only when `confirmPayment` saves it after the debit (`:216-221,454-456`).
  - **Scenario:** with the advisory lock around "check, then insert":
    1. T1 inserts its pending row, as `chapa`, commits and releases the lock;
    2. T2's check for "a pending wallet payment" finds nothing, because T1's row still says `chapa` and isn't confirmed yet;
    3. both debit.

  Suggested: either insert the row as `wallet` inside the locked transaction (when `useWallet`), or hold the advisory lock until the wallet confirmation commits. Step 9's e2e case (two parallel wallet buys, one charge) would catch it; make sure it runs against the real database, not the fake.

  Response: fixed. With `useWallet`, `createSession` inserts the row as `method = wallet` inside the locked transaction, so a second request's check sees it. Step 9's spec runs against the real local database.
- **S3. Keep Chapa's validation body in the `initialize` error, or the email fallback stops working** at decision 4 (`initialize`)
  - **The dependency:** the `CHAPA_FALLBACK_EMAIL` retry triggers only when the error message matches `/validation\.email|valid email/i` (`payment.service.ts:258-261`). Today that text arrives through the SDK's `HttpException` body, which `LiveChapaProvider` puts in the message (`chapa.provider.ts`).
  - **What breaks:** if the `fetch` client turns a Chapa 4xx into a generic 400, learners whose email domain Chapa rejects (the `*.et` accounts this fallback exists for) can't check out.

  Suggested: put Chapa's 4xx body in the error as today, and add a fixture spec: a Chapa email-validation 4xx → the retry with the fallback email.

  Response: fixed. A Chapa 4xx on initialize keeps its body in the message, as today, so the `CHAPA_FALLBACK_EMAIL` retry still matches. Step 4 adds the fixture spec.

### Nits (optional, max 3)
- **N1.** `runJob`'s finish step should clear the lease only `WHERE holder = <this run>`. Otherwise a run that outlived its TTL clears the lease of the run that took over.
- **N2.** Map a Chapa 401 or 403 on `verify` to `ChapaUnavailableError` (a config problem: loud, and the sweep stops) rather than `pending`. A rotated or wrong secret would otherwise leave every payment pending in silence.
- **N3.** With one retry on timeout, a peer call can take 16.5 s (8 + 0.5 + 8). Two sequential calls in one request then pass the gateway's 30 s proxy timeout. Either note it, or let the retry happen only when the first attempt failed fast (a network error), not after a timeout.

### Planner responses to the nits
- **N1:** taken. The lease is cleared only `WHERE holder = <this run>`, with a spec.
- **N2:** taken. A verify 401 or 403 raises `ChapaUnavailableError`, logged as a configuration error, and the sweep stops. Spec in step 4.
- **N3:** taken. The single retry happens only after a fast network failure, never after a timeout, so one call stays within about 8 s.


## Round 2 (2026-10-03) · Verdict: APPROVED (checks the round-1 fixes only)
Reviewed: `plan.md` (status "in review (round 2)").

Resolved:
- **B1:** `emitConfirmed` keeps the blank-default lookup, so `PaymentConfirmed` (access) never waits on auth. Notification looks a blank email up through `userInfo`, throws on a 503 so 9a retries, and skips with a warn on a 404. Step 3 has the specs.
- **S1:** the workspace-wide cap and the suspension consequence are stated in decision 7, Risks and Rollout.
  - The sweep runs every 4 h and wakes only gateway and financial. Payouts wake gateway, financial and auth; inactivity wakes gateway, enrollment and course. Notification is never woken.
  - That's about 136 h, and the user reads current usage before enabling.
- **S2:** with `useWallet`, the row is inserted as `wallet` inside the locked transaction. The spec runs against the real local database.
- **S3:** a Chapa 4xx keeps its body, and step 4 has the fallback-email fixture.
- **N1–N3:**
  - the lease is released only by its holder;
  - a verify 401 or 403 is `ChapaUnavailableError`;
  - the internal client retries only after a fast network failure, never after a timeout.

No new blockers.

## Drift check vs 9a (2026-10-03)
Not a review round: the plan stays APPROVED. This is a read-only check against 9a as built (`fix/event-delivery` @ `fa06f83`, with its deviations). 9c touches 9a in three places: notification's lookups, the consumer retry, and bootstrap/readiness.

### Mismatches
- **D1. Notification's `userInfo` never throws at 9a, and it has many callers (decision 2, B1).** `notification.service.ts:640-646` (the plan says `:627`) catches every error and returns `{ email: '', name: '' }`. The plan's receipt fix says the handler "looks the learner up through `userInfo`… throws on a 503… skips with a warn on a peer 404". That needs new behaviour, and the scope matters, because 9a now retries the **whole message** on any throw and parks it after 5 attempts.
  `userInfo` has other callers whose fallback is intended:
  - `userName` (`'An instructor you follow'`, `:648`);
  - the follower fan-out (`:437`);
  - `CourseUpdated`'s per-learner loop (`:624`);
  - `PayRequest`, wallet and staff notices (`:313`, `:373`, `:387`, `:604`).

  Making `userInfo` itself throw would turn an asleep auth into retries and then a park for all of those. A fan-out parked part-way resumes only through the dedupe, and only if someone replays it.
  **Fold in:** add a separate throwing lookup, for example `requireUserEmail(id)`: it rethrows `PeerAsleepError`/`PeerUnavailableError` (9c's typed errors) and returns `null` on `PeerNotFoundError`. Use it only in the handlers whose payload email is blank (the receipt and the other `deliver(…, p.learner_email, …)` handlers). Leave `userInfo`'s degrade-to-blank as it is. The step 3 spec names that helper.
- **D2. The header says 9c edits "9a's `/ready`", but no decision or step does.** 9a built `/ready` as a plain adapter route in `bootstrapService` (`common/src/ready.ts`, deviation "`/ready` is a plain route"), not a controller. 9c's only readiness touchpoint is the `GET /api/v1/jobs/<service>` "companion", a separate gateway route. **Fold in:** drop "and 9a's `/ready`" from the header. Optionally, `jobs.yml` could wait on each service's `/ready` (DB and broker up) after the `/health` wake and before calling the job endpoints; `/ready` is outside the internal-token check, like `/health`. Not required.

### Confirmed as the plan assumes
- **The retry covers B1's receipt:** a durable queue holds `PaymentConfirmed` while notification sleeps, and no attempts are counted until it consumes. Once it does, `EVENT_MAX_ATTEMPTS=5` × `EVENT_RETRY_DELAY_MS=60000` gives auth about 4 minutes to wake. A visitor's Phase 5 wake pings every service, auth included, so that's enough. The fallback is the `<service>.events.parked` queue.
- **A retried receipt is sent once:** `deliver()` checks `notification_log` for (event id, recipient, type, `sent`) before sending (`:683-692`).
- **Bootstrap:** the global `ValidationPipe` is now at `bootstrap.ts:88` and `enableShutdownHooks()` at `:90`; the plan says `:67-69`, which is line drift. 9c's `Retry-After` filter sits next to `DbErrorFilter` as planned. 9a's internal-token middleware now exempts `/health` and `/ready`, and 9c's `JobsController` is under `/api/v1`, so it stays behind the token as the plan says.
- 9a doesn't touch financial (Chapa, sweep, re-publish cron, bulk seats), enrollment's `progressPercent` or growth's referral lookup, so decisions 3–5 and 8–10 build on main's code unchanged. 9a's `BrokerPublishError` is still what the re-publish cron stops its batch on.

### Planner response to the drift check (ethio-planner [aeff2b], 2026-10-03)
- **D1: fixed.** Step 3 adds `requireUserEmail(id)` for the blank-email handlers only; `userInfo` keeps degrading to blank.
- **D2: fixed.** The header no longer claims a `/ready` edit. The optional `jobs.yml` wait on `/ready` is not taken: the `/health` wake plus the job endpoints' own errors are enough (keep it simple).
