# Plan review: Phase 4, payment integrity

## Round 1 (2026-10-02) · Verdict: APPROVED (with should-fixes to fold in before handoff)
Reviewed: `plan.md` (status "in review (round 1)"), against `origin/main` `api/services/financial` (payment, growth, sponsorship, refund and payout services, entities), the enrollment and notification consumers, and @nestjs/schedule 4.1.2.

Checked and OK:
- The confirm, fail, decide, finalize and release guards (`UPDATE … WHERE status …`, act on `affected === 1`) are correct under READ COMMITTED. A concurrent second UPDATE waits on the row lock, re-checks its WHERE clause against the committed row and affects 0 rows. Doing HTTP work before the transaction keeps the locks short.
- `INSERT … ON CONFLICT DO NOTHING` with no conflict target also respects the partial unique index, and it keeps the transaction usable. The atomic `balance_etb ± $2` (with `>= $2` on debit) removes today's read-modify-write. Every current `credit`/`debit` caller passes a per-event reference (`growth.service.ts:330,341`, `payment.service.ts:194,434`); only `admin_adjust` doesn't, and it's excluded.
- `payments.payout_id` is a plain uuid with no FK (`entities.ts:57-58`), so claiming before inserting the payout row works. The claim UPDATE's `payout_id IS NULL AND status='confirmed'` is the real guarantee, as decision 8 says.
- Refund statuses are `pending/approved/denied`, and the manual band stays `pending` until `decide`, so `WHERE status='pending'` fits. The partial unique also closes the concurrent double-`APPROVED` insert in `request`.
- Decision 7's reasoning holds. Today's `chapa-signature ?? x-chapa-signature` puts the constant header first, so a genuine request (which carries both) can never match the body HMAC.

Decision "failed → confirmed is allowed": I agree. `verify()` is the source of truth, the tamper checks still run first, and refunded rows stay excluded.

### Blockers
None.

### Should-fix
- **S1. Secondary effects can now block the primary one** at Decision 1. Today each post-confirm step is isolated by `safe()` (`payment.service.ts:423-452`): a failing cashback or referral step is logged, and the learner still gets access. Decision 1 moves coupon use, cashback and the referral reward into the confirm transaction, so any error there rolls back the status change itself. That includes a future bug or an unexpected constraint. The payment then stays `pending`: the webhook 500s through Chapa's ten retries and every sweep fails the same way. A paid learner gets no access until someone notices. Suggested: keep the status change, the wallet debit and the top-up credit in the transaction (they *are* the purchase), and run coupon use, cashback and referral reward in a nested `manager.transaction` (a SAVEPOINT in TypeORM 0.3/Postgres). On failure, roll back to the savepoint, log, and still commit. Also, a failed HTTP lookup before the transaction (learner name, decision 1) must not abort confirmation; the cron covers the emit.
  Response: fixed. Decision 1: only the status change, the wallet debit and the top-up credit are in the transaction; coupon use, cashback and the referral reward run in a nested savepoint that rolls back on its own, logs and lets the confirmation commit. A failed pre-transaction HTTP lookup skips only the effect that needed it. Test added.
- **S2. Gifts, pay requests and bulk orders keep P0-05's lost-effect bug, and decision 2 makes it permanent** at Decisions 2 and 6 / Non-goals. These purposes grant through after-commit handlers. `onSponsoredPaymentConfirmed` → `grant()` saves `granted` and then plain-publishes `SponsorshipGranted` (`sponsorship.service.ts:404-419`), which is what enrollment acts on (`enrollment.service.ts:60`). A lost publish or a handler exception leaves the sponsor charged and the recipient without access. With decision 2's "act only when it changed a row", nothing will ever re-publish it, and the cron only scans `purpose = course`. Suggested: either generalize the marker to "post-confirm effects done" (set after every after-commit effect succeeds, with `publishConfirmed` for `SponsorshipGranted` and `BulkPurchaseActivated`) and let the cron re-run the idempotent effects for every purpose, or list it in Non-goals with an explicit accepted risk until Phase 9.
  Response: fixed, taking the generalized option. The column is now `effects_completed_at`, set when every access-granting publish for the payment is acknowledged (`PaymentConfirmed`, `SponsorshipGranted`, `BulkPurchaseActivated`; top-ups are marked at confirmation). The handlers keep a conditional state change but re-publish while the marker is unset, and the cron (`completePendingEffects`) covers every purpose.
- **S3. The backfill hides learners who were already hit by P0-05** at Migration 1. `confirmation_emitted_at = COALESCE(…)` for every confirmed row also marks the payments whose `PaymentConfirmed` was already lost. Those learners paid, have no enrollment, and will never be re-published. Suggested: add a read-only query to rollout step 1 that lists confirmed course payments with no matching `enrollment.enrollments (learner_id, course_id)` (same database, different schema), and leave those rows `NULL` so the cron heals them. `activate` is a no-op for already-active enrollments, so a re-publish is safe.
  Response: fixed. The backfill leaves confirmed course payments with no matching enrollment NULL, so the cron heals them; that's a deliberate one-off cross-schema read. Rollout step 1 lists those victims plus granted sponsorships without an enrollment.
- **S4. Overlapping cron runs can double-publish** at Decision 6. With the broker down, a run takes 50 rows × the 5 s confirm timeout, about 250 s, which is longer than the 2-minute interval. The next tick starts on the same rows, and when the broker comes back both runs publish them, sending extra receipts. Suggested: an in-process "running" guard (one instance per service), or `waitForCompletion` if @nestjs/schedule 4.1.2 supports it. Also stop the batch at the first publish failure, since a dead broker won't recover mid-batch.
  Response: fixed. Decision 6 adds an in-process running flag and stops a run at the first publish failure. Tests added.
- **S5. The payout race in `e2e-payments.mjs` would pass without testing anything** at Step 10. Hold windows are hard-coded to 7 and 14 days (`payout.service.ts:20-21`, measured from `webhook_received_at`), so every payment the script creates is ineligible. Both concurrent `/payouts/run` calls claim nothing, and the assertions pass trivially. Suggested: make some payments eligible (backdate `webhook_received_at` by 15 days via `psql` against the compose Postgres, or add a hold-days override that the production config rejects), and assert that at least one payout was created and that its payments carry exactly that `payout_id`.
  Response: fixed. Step 10 backdates `webhook_received_at` by 15 days through the compose Postgres and asserts at least one payout with exactly-once `payout_id`s.

### Nits (optional)
- **N1.** (Taken: log line only, stated in decision 1.) Decision 1 says "SET status='confirmed', confirmed via <source>". If "via" is a new column, it belongs in Migration 1. If it's only the log line from "Rollout and ops", say so.
- **N2.** (Taken: rollout step 1.) Rollout step 1: also confirm `CHAPA_WEBHOOK_SECRET` is at least 16 characters (decision 10's rule). If the Chapa dashboard secret is shorter, rotate it in Chapa and Render first, or financial won't boot.
- **N3.** (Taken: decision 4 plus a test.) With the new `UNIQUE (referred_user_id)`, a concurrent double `claim` (`growth.service.ts:300-318`) turns into a 500 (DbErrorFilter maps only 22P02). Catch 23505 there and return the existing referral, to keep the documented "idempotent" behavior.

## Round 2 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: the round-1 rework in `plan.md` (decisions 1, 2, 5, 6, Migration 1, step 10, tests). S1, S3 (except S7 below), S4, S5 and N1–N3 are resolved as suggested. The S2 rework has one gap that is a blocker.

### Blockers
- **B1. A gift to someone without an account never completes, and every re-run sends them another email** at Decisions 2, 5 and 6
  Scenario: a sponsor pays for a gift to an email with no account. `onSponsoredPaymentConfirmed` takes the `invite()` path (`sponsorship.service.ts:357-367,422-435`): the sponsorship becomes `pending_claim` and `SponsorshipInvited` (an email to the recipient) is published. `SponsorshipGranted` only comes later, from `claimForEmail` when they sign up, which isn't tied to this payment. Decision 5 marks the payment done only once its "access-granting event" (`SponsorshipGranted` for gifts) is acknowledged. That never happens, so `effects_completed_at` stays NULL. Then every 2 minutes, decision 6 re-runs the handler, and decision 2 publishes "whenever the payment's effects are not yet marked done". That means either:
  - a fresh `SponsorshipInvited`, so the recipient, an outside address, gets an invitation email every 2 minutes indefinitely; or
  - a `SponsorshipGranted` with a null `recipient_user_id`, which enrollment's `activate` (`enrollment.service.ts:436-447`) can't handle.

  These rows also fill the oldest-first 50-row batch for good, so newer course payments, including the S3 victims, are reached late or never once there are 50 of them.

  Suggested fix: the required event follows the handler's actual outcome, read from the sponsorship row on every run (first or retry):
  - `granted`: publish `SponsorshipGranted`.
  - `pending_claim`: publish `SponsorshipInvited`, then mark done; the later grant at signup is its own flow.
  - Nothing to publish (missing `sponsorship_id`/`bulk_purchase_id` meta, or a row not found): mark done and log.

  Add a test: a gift to an unknown email → one invite publish, `effects_completed_at` set, and the next cron tick does nothing.
  Response: fixed. Decision 5 now says the required event follows the purpose row's current status: `pending_claim` publishes `SponsorshipInvited` once and is then done; with nothing to publish it's done immediately. Test added (a second cron run publishes nothing).

### Should-fix
- **S6. The cross-schema backfill fails on a fresh database when financial boots before enrollment** at Migration 1. Postgres resolves `enrollment.enrollments` when it parses the statement, even with zero payments. In CI e2e and on a fresh local setup, `start-backend.sh` boots every service at once, so financial's Migration 1 can run before enrollment's baseline has created that table. It then fails with "relation does not exist", and boot depends on Nest's 9×3 s retry winning the race. Suggested: run the backfill only when `to_regclass('enrollment.enrollments') IS NOT NULL` (a fresh database has no payments to backfill anyway), for example by checking first in `up()`.
  Response: fixed. The backfill is guarded with `to_regclass`; with no enrollment table there are no historical payments, so everything is marked. Test added.
- **S7. "Stop at the first publish failure" (my S4) needs to separate broker failures from row failures** at Decision 6. If a row-specific error stops the batch, one poisoned row blocks every run behind it forever: the oldest row is always first, so nothing newer is ever healed. Examples are a learner lookup that 404s for a deleted user, or a handler bug for one payment. Suggested: stop the batch only on channel or connection errors and confirm timeouts. On a row-level error, log it with the payment id and move on to the next row. Optionally stop retrying a row after 24 h, logged at error level, so it doesn't run forever.
  Response: fixed. Only broker errors stop the run; row-specific failures are logged and skipped. Test added.

## Round 3 (2026-10-02) · Verdict: APPROVED
Reviewed: the round-2 changes in `plan.md` (decisions 5 and 6, Migration 1, the test plan).
- **B1** resolved. The required event follows the purpose row's current status (granted → `SponsorshipGranted`, `pending_claim` → `SponsorshipInvited` once and then done, nothing to publish → done), and a test checks that a second cron run publishes nothing. One remaining edge, which is fine: if the recipient signs up before a cron retry, the retry publishes `SponsorshipGranted` a second time. Enrollment's `activate` ignores it, so the only effect is one extra notification, already in the accepted duplicate-notification risk.
- **S6** resolved. The backfill is guarded with `to_regclass`, with a test.
- **S7** resolved. Only broker errors stop a run; row errors are logged and skipped, with a test.
No open findings.
