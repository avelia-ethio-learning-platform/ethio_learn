# Plan review: Phase 6d, money integrity III (pay-request writes, refunds of duplicate purchases)

## Round 1 (2026-10-03) · Verdict: APPROVED (three should-fixes to fold in before the handoff)
Reviewed: `plan.md` (status "draft (round 1 requested)"), against the code at `5f5fe7d` (main, read in `../ethi0-verify-main`) and the audit entries P1-63 and P2-47.

The design is the simplest one that fixes both findings:
- financial decides `access_kept` inside the refund transaction;
- enrollment follows one optional flag;
- pay requests use conditional updates and take the payer from the payment.

It adds no table, column, endpoint or env var, and rejecting `enrollments.payment_id` is right. Locking inside the transaction (not computing the flag after commit) also keeps the flag writable into 9b's outbox row later.

### Confirmed in code (the two open risks resolve, so both can leave "Risks")
- **Bulk seats are `Sponsorship` rows:**
  - `assignSeats` creates `source: 'bulk'` rows with `recipient_user_id` and `course_id` (`sponsorship.service.ts:344-359`).
  - A seat for someone already entitled is saved `granted` with no event (:361-366).
  - So one query, `Sponsorship {recipient_user_id, course_id, status: 'granted'}` through `m.getRepository(Sponsorship)`, covers gifts, pay requests and bulk seats. No second table.
- **No institution path exists:** enrollment's sources are only `free` (:86), `payment` (:430) and `sponsorship` (:437). Institution access arrives as bulk seats, so it's covered by the bullet above.
- **The `purpose: COURSE` filter misses no legacy rows:** `payments.purpose` is `NOT NULL DEFAULT 'course'` since the baseline migration (`1790955685613-Baseline.ts:40`).
- **N2's controller already has the flag:** `recordBankTransfer` returns `{payment, created}` (`controllers.ts:202-206`), so `replayed: !created` is a one-line addition.

### Blockers
None.

### Should-fix
- **S1. Two concurrent auto-approved refunds of the two duplicates deadlock** at decision 1 (lock placed in `approveWith`)
  - **The order:** in `request()`, the transaction first runs the mark, `UPDATE payments SET refund_requested_at = now() WHERE id = $1 …` (`refund.service.ts:127-130`). That takes the row lock on the payment being refunded. Only then does `approveWith` take decision 1's ordered `FOR UPDATE` on all the learner's confirmed course payments for the course.
  - **Scenario:**
    - a learner holds P1 and P2 and submits both refunds at once (two tabs, or a scripted double submit);
    - T1 marks P1 and T2 marks P2;
    - T1's ordered lock gets P1, then waits on P2 (held by T2);
    - T2's ordered lock waits on P1 (held by T1).
  - **Result:** Postgres aborts one transaction with `40P01`, and that request returns 500. Nothing is written for it, and a retry succeeds, so no data is damaged. But the acceptance criterion "two refunds … approved at the same time" can't happen on the auto-approve path. The admin `decide` path doesn't deadlock: it locks the refund row first, not a payment.

  Suggested: in `request()`, make the ordered lock the first statement of the transaction, before the mark. Keep it inside `approveWith` for `decide`. One small helper serves both. With the lock first, T2 waits for T1, then re-reads its `WHERE status = 'confirmed'` and sees only P2, so it revokes, as decision 1 intends.

  Response: Fixed: decision 1 now takes the ordered lock as the first statement of `request()`'s transaction, before the mark; `decide` takes it in `approveWith`. One helper serves both.

- **S2. Prove the lock with the real stack, not a new real-Postgres jest harness** at Test plan and step 6
  - **The problem:** the fake DB can't model a blocking `FOR UPDATE`. Its header says there is "no isolation between concurrent transactions", and it models only `pg_try_advisory_xact_lock` (`testing/fake-db.ts:17-27`, :274-280). So the plan's "if the fake DB can't model the row lock" branch is certain. Its `find` needs at least to accept the `lock` option as a no-op for the unit tests. That branch copies 7b's `auth.resend-verification.db.spec.ts` pattern, which isn't on 6d's base (6b). Nothing on main reads `TEST_DATABASE_URL`.

  Suggested:
  - In `e2e-payments.mjs` (already against real Postgres), add a second learner with two duplicate payments whose two refund requests are sent together with `Promise.all`.
  - Expect both requests to answer 2xx (this is the S1 check), and the entitlement to end `refunded` (`waitFor`). The final state is enough; there's no need to inspect events. Concurrent requests don't always overlap, so this can miss a deadlock on some runs, but it never fails a correct build.
  - Keep step 6's sequential case: it checks that enrollment and notification honour `access_kept: true` end to end.
  - Keep the fake-DB unit tests for the decision logic (sequential `approveWith` calls).
  - Drop the conditional jest spec.

  Response: Fixed: step 6 adds the concurrent `Promise.all` refund pair on real Postgres, the conditional jest spec is dropped, and step 2 has the fake DB accept the `lock` option as a no-op.

- **S3. The production SQL shouldn't hold back the merge, and the informational query can go** at Rollout ("Read-only production check for the user, before merge")
  - **Why it shouldn't block:** the first query finds past wrong revocations to re-grant by hand. 6d doesn't touch those rows, and nothing in the merge decision depends on the result: running it after the deploy gives the same list. As a merge prerequisite, it would hold an approved money phase on a user action for no reason. Under the "security and money phases push only when they can deploy the same day" rule, that means waiting for the user's day.
  - **Why the second query can go:** the attribution query ("informational") leads to no action, so it's report-reading for the user with nothing to decide.

  Suggested: list only the first query in DEPLOYMENT.md and USER-ACTIONS, marked "any time; doesn't block anything".

  Response: Fixed: only the wrong-revocation query remains, marked "any time; blocks nothing"; the attribution query is dropped.

### Nits
- **N1. Decision 5, `sponsor_name`: pick the lookup and drop the other branch.**
  - `Payment.meta` holds only `sponsorship_id` today. Payments in flight at deploy wouldn't carry a new meta field, so the lookup would be needed anyway.
  - `this.user(payment.learner_id)` as the only path is simpler, and the purpose handler is re-run by its cron if the lookup fails.
- **N2. Decision 7 is consistency only:** P2-47 covers pay requests, and the plan itself says nothing races gift or bulk attach. Swapping the two `save()`s for `update()`s is fine at no extra cost, but skip step 4's "gift and bulk: a row granted before the attach stays granted" tests. They pin a race that can't happen.
- **N3. `revokeFromRefund`'s log:** the conditional `update` no longer loads the row, so log `learner_id`, `course_id` and `payment_id` (and `affected`) instead of `enrollment.id`.

### Nit responses (planner)
- N1: taken. `sponsor_name` comes from `this.user(payment.learner_id)` only.
- N2: taken. Gift and bulk attach become conditional updates with no race tests.
- N3: taken. The revoke logs `learner_id`, `course_id`, `payment_id` and `affected`.
