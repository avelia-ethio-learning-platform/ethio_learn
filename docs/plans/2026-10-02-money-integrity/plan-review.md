# Plan review: Phase 6c, money integrity II

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (draft, round 1), against `fix/payment-integrity` (Phase 4, `8724777`). I read `refund.service.ts`, `payout.service.ts` (`payPayee`), `payment.service.ts` (`createSession`, `confirmPayment`, `recordBankTransfer`), `growth.service.ts` (wallet, `creditWith`, `debitWith`, admin stats) and the financial entities and indexes.

What holds:
- **Decision 1:** a pending state on the movement row, with `balance_etb` kept as the spendable balance. This is the right call: the overspend guard stays one conditional UPDATE.
- **Decision 2:** the release is exactly-once. The conditional `state` change is re-checked under the row lock.
- **Lock order** is the same on every path, so there's no deadlock cycle:
  - confirm (wallet purchase): payment row → wallet_tx rows → wallet;
  - `GET /wallet`: wallet_tx → wallet;
  - approval: payment → wallet_tx.
- **Decision 5:** both sides UPDATE the same `payments` row, and READ COMMITTED re-checks the full `WHERE` on the newest version. Of a concurrent request and claim, exactly one wins. `payPayee` sums `gross` from the rows it actually claimed, not from the candidate list (`payout.service.ts:146-150`), so a skipped payment changes the amount correctly. Rejecting `NOT EXISTS` in the claim is correct.
- **Clocks:** hold, window and `available_at` all count from the confirmation. Holds are 7 or 14 days and the window is 7, so the "already paid out" 400 is effectively a boundary case.
- **Indexes:** the open-refund unique index (`status IN ('pending','approved')`) serves `status = 'pending'` lookups by predicate implication, so migration 2's third index isn't needed. `chapa_tx_ref` is an unbounded varchar, so `bank-` plus 64 characters fits.

### Blockers
- **B1. As written, every refund request marks the payment, including the ones the rules deny at once, so a denied request can block the educator's payout forever.** In `request()` the rule engine runs first, then inserts the row with its final status. `DENIED` covers a certificate already issued, an assessment passed, outside the window, or over 50 % (`refund.service.ts:54-104`). Decision 5 says the request transaction sets `refund_requested_at`, then inserts the row. "Denial clears the mark" reads as `decide(approve=false)`, and that never runs for an auto-denied row.
  - **Scenario:**
    1. A new educator has a 14-day hold.
    2. A learner requests a refund on day 9, or after earning the certificate.
    3. The rules deny it, but the payment is now marked.
    4. Every payout run skips it (`AND refund_requested_at IS NULL`), so the educator is never paid for that sale.
    5. Any buyer can do this on purpose.
  - **Fix:**
    - Set the mark only when the outcome is `PENDING` or `APPROVED`. A `DENIED` row is inserted without touching `payments`.
    - Run the rules before the mark UPDATE. Then the "already paid out" 400 only reaches requests the rules would have accepted. Otherwise a learner past the window, whose payment has usually been paid out, is told to "contact support" instead of getting the outside-window denial, which invites support tickets for refunds nobody owes.
    - Add a test: an auto-denied request leaves the payment claimable.
  Response: **Fixed as proposed.** Decision 5: the rules run first. `DENIED` inserts the row without touching `payments`. Only `PENDING` and `APPROVED` mark the payment, in one transaction with the insert. The "already paid out" 400 therefore only reaches requests the rules accepted. Step 4 has the auto-denied test (certificate, outside the window, over 50 %).

### Should-fix
- **S1. The approval's status change, flip and void need to be one transaction, or the release must stop depending on `refund_requests.status`.** `decide()` commits `pending → approved` with its own conditional UPDATE (`:121-123`), and `finalizeApproval` runs afterwards. The plan makes only `finalizeApproval` transactional.
  - The gap: decision 2's `NOT EXISTS (… status = 'pending')` stops protecting the credit as soon as the decision commits. A wallet read in that gap releases a matured credit. Then the void finds nothing `pending`, and the learner keeps the cashback and gets the refund. That only needs the manual-review band to be decided after day 7, which is normal. The gap is milliseconds, unless `finalizeApproval` fails after the decision commits; then it lasts until someone notices.
  - **Fix (either):**
    - put the decision UPDATE, the flip and the void in one transaction, in both `decide` and the auto-approve path; or, more robustly,
    - key the release on the payment instead: `NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = wallet_transactions.payment_id AND (p.refund_requested_at IS NOT NULL OR p.status <> 'confirmed'))`. The mark is set with the request, stays set through approval (the status becomes `refunded`) and is cleared only by a denial. So no ordering of commits can release a credit for a refunded payment.
  Response: **Fixed, both ways.** The release is keyed on the payment row (decision 2), and decision, flip and void are also one transaction on the auto and admin paths (decision 3); admin denial clears the mark in its transaction. Step 3 tests that a credit on a `refunded` payment never releases even if the void didn't run.
- **S2. `available_at` must come from the confirmation time, not from `payment.webhook_received_at` inside the transaction.** `confirmPayment` sets `webhook_received_at: now` in the UPDATE (`:457`), but sets it on the in-memory `payment` only after commit (`:487`). `creditCashback(sp, payment)` and `rewardReferrer` therefore see the old value: `null` for a pending Chapa payment, or the failure time for a payment that failed and was confirmed later (`failPayment` sets it, `:516`).
  - **Scenario:**
    1. A payment fails on day 0, and reconcile confirms it on day 3, so the window runs to day 10.
    2. If `available_at` is taken from the stale value, it's day 7, and the credit releases.
    3. A refund on day 8 is approved, and the cashback is kept.
  - **Fix:** pass confirmPayment's `now` into both helpers (or set `payment.webhook_received_at = now` before the effects), and test the failed-then-confirmed case.
  Response: **Fixed.** Decision 1: `confirmedAt` (confirmPayment's `now`) is passed into `creditCashback` and `rewardReferrer`. Step 3 tests the failed-then-confirmed case.
- **S3. The e2e release check (step 8) backdates the wrong column.** Backdating `webhook_received_at` doesn't move `wallet_transactions.available_at`, which is stored at credit time. The concurrent `GET /wallet` pair would then release nothing. Backdate `available_at`, and `webhook_received_at` as well for consistency.
  Response: **Fixed** in step 8.
- **S4. The bank-transfer ownership check can't see a purchase that was confirmed seconds ago.** The entitlement is created asynchronously, from `PaymentConfirmed` through the enrollment service. The usual bank-transfer case is "Chapa looked broken, so the learner also paid by bank". If the Chapa payment confirmed moments earlier, `/internal/entitlements` can still say "not active", and the learner pays twice.
  - **Fix:** before the HTTP check, also check the financial DB itself, synchronously, for a `confirmed` course payment for this (learner, course) → 409. Keep the fail-closed entitlement check for courses granted any other way.
  Response: **Fixed.** Decision 6 check 2: a synchronous lookup for a `confirmed` course payment for (learner, course) → 409, before the users and entitlements calls. Step 6 tests it while the entitlement is still inactive.

### Nits (optional)
- **N1.** The boundary race in decision 2 disappears if `available_at` = confirmation + 7 days + 1 hour. Release then always comes after the window closes, whatever the clock skew between the app and Neon, and "Accepted" leaves the Risks list.
  Response: **Taken.** `available_at` is confirmation + 7 days + 1 hour, and the Risks entry now says the race is closed.
- **N2.** Add `AND payout_id IS NULL` to the approval flip. A legacy pending refund on a payment that was already paid out (rollout check 1) then fails with "already paid out, handle through support" instead of paying both. After this phase, new cases can't arise.
  Response: **Taken.** Decision 3's flip has `AND payout_id IS NULL`. The API contract lists the 400 on decide, and step 4 tests it.
- **N3.** Migration 2's third index can go: the open-refund unique index already covers it.
  Response: **Taken.** Removed.

## Round 2 (2026-10-02) · Verdict: APPROVED
Checked the round-1 changes in decisions 1–3, 5 and 6, and the matching steps:
- **B1** resolved. The rules run first; `DENIED` inserts its row without touching `payments`. Only `PENDING`/`APPROVED` mark the payment, in the same transaction as the insert. The paid-out 400 can now only reach requests the rules accepted.
- **S1** resolved, both ways:
  - The release's `NOT EXISTS` is on the payment row (`refund_requested_at IS NOT NULL OR status <> 'confirmed'`). A credit for an open or approved refund can't be released, in whatever order the commits land.
  - The decision, the flip and the void share one transaction on both the auto and admin paths. The denial clears the mark in its own transaction.
- **S2** resolved: `confirmedAt` is passed in, and the failed-then-confirmed case is tested.
- **S3** resolved: step 8 backdates `available_at`.
- **S4** resolved: a synchronous check for a `confirmed` course payment runs before the HTTP checks, `refunded` payments don't count, and the entitlements check stays fail-closed.
- **N1–N3** taken:
  - the +1 h margin closes the boundary race;
  - the approval flip has `payout_id IS NULL`, so a legacy paid-out refund rolls back with the support message and the refund stays pending;
  - the extra index is gone.

No new blockers in the changed parts.

Outstanding, not a plan finding: this folder still isn't git-ignored (`git check-ignore` finds nothing for it). The user adds it to `.git/info/exclude`.

## Round 3 (2026-10-03) · Verdict: APPROVED (amendment A only; three should-fixes to fold in before the handoff)
Reviewed: the A1–A3 edits, checked against `fix/security-platform` (`payment.service.ts` `sweepPendingPayments` :486, `nudgeAbandonedCheckouts` :514, `applyVerification` :556, `confirmPayment`, `failPayment`; `sponsorship.service.ts` `createGift`, `payRequest`).

Confirmed:
- **A1 is real.** `save` diffs the stale in-memory `pending` against a fresh read and writes it back. It also nulls `webhook_received_at` and `effects_completed_at`. The conditional `update` of `nudged_at` alone is the right fix.
- **A3 is real.** `giftsToday` counts every gift row, so a refused gift spends the cap. The `payment_id: IsNull()` predicate on the pay-request revert means an earlier live checkout is never undone.
- **Damage bounds.** A double confirmation after an A1 revert can't double the cashback or referral reward: Phase 4's unique `(kind, reference)` index on `wallet_transactions` refuses the second credit inside its savepoint.

### Blockers
None.

### Should-fix
- **S1. A2's criterion "A superseded row whose retry already settled is still never settled" and its 7b test contradict the code.**
  - **The code:** for a gateway source (`sweep`, webhook, reconcile), `confirmPayment` claims `PENDING` or `FAILED`. 6a's own comment says of a superseded row that "a late payment of it still confirms" (`:298`). The rule decision 10 cites (`:596`) covers only *instant* settlements, where a wallet or 100% coupon row that was superseded is never settled. Nothing stops a superseded *Chapa* row that Chapa verifies as paid from confirming. The webhook already does this today.
  - **What breaks:** the implementer either can't make the test pass with "the confirm path is unchanged", or adds a guard to make it pass. With that guard, a payer who paid both Chapa pages has real money taken and a payment left `failed`. Refunds only work on confirmed payments, so support can't find it or refund it.
  - **Fix:** restate the criterion and the test as follows. A superseded Chapa row that verifies `success` is confirmed, as the webhook does; paying both pages is a duplicate purchase and a refund case. One that verifies `failed` or still pending stays `failed`.
- **S2. A2's `take: 10` can starve the row it exists for.**
  - **The code:** `failCheckout(…, 'checkout_open_failed')` rows are Chapa rows with a `chapa_tx_ref` but no `chapa_checkout_url` (the URL is written only after Chapa opens, `:281`). They can never be paid.
  - **What breaks:** during a Chapa outage, each checkout attempt leaves one of these rows. A few dozen of them fill the 10 slots for 24 hours, so a superseded checkout paid late during that time is never swept.
  - **Fix:** add `chapa_checkout_url: Not(IsNull())` to the failed query, and state the order (`created_at DESC`, like the pending query, so recent supersedes go first).
- **S3. A1's first 7b test can't pass as written.** Decision 9 claims the row *before* `learnerInfo` and publishes when `affected === 1`. A row that turns `confirmed` while `learnerInfo` is awaited was already claimed, so the reminder is still published. Split the test:
  - confirmed while `ownsCourse` is awaited, before the claim → the claim affects 0 rows and nothing is published;
  - confirmed after the claim → it stays `confirmed`, and a late reminder is accepted.

- **Addendum (reconcile, added during this round): accepted.**
  - `reconcile` is already scoped to the caller's own row (`learner_id: ctx.id`, `payment.service.ts:470`) and runs in live mode only.
  - `'reconcile'` isn't an instant source, so `applyVerification` → `confirmPayment` claims a `FAILED` row exactly as the webhook does.
  - The cost is one verify per return-page load on a failed row. A pending row already costs the same today, behind the same per-user `general` bucket.
  - **S1 applies here too:** its new test bullet "a superseded row whose retry settled → still `failed`" holds only when Chapa reports that row unpaid. Word it like the sweep test.

### Nits (optional)
- **N6.** Decision 11 says "No payment or email exists yet" for a refused gift. A `wallet_insufficient`, `checkout_open_failed` or `error` refusal has already inserted a failed payment whose `meta.sponsorship_id` points at the deleted row. It's harmless, because that row can't be paid (no checkout URL reached the payer), but say "a failed payment row may exist, and it keeps the dangling id".
- **N7.** The A1 rollout check finds reverted rows the sweep never reached (24–48 h old). A row reverted within 24 h was re-confirmed by the sweep, which ran `recordCouponUse` a second time. Add a select for coupons whose `uses` exceeds their confirmed payments. 6a counts `GREATEST(uses, confirmed)`, so an inflated `uses` closes a coupon early.

No open blockers.

### Planner responses to round 3
- **S1:** fixed. The A2 goal line, decision 10 ("What it settles", with "don't add a guard") and the 7b tests now say a superseded Chapa row that verifies `success` is confirmed, as the webhook does, and one Chapa reports unpaid stays `failed`.
- **S2:** fixed. The failed-row query adds `chapa_checkout_url: Not(IsNull())` and `created_at DESC` (decision 10), with a 7b test that 10+ newer `checkout_open_failed` rows don't crowd out a payable one.
- **S3:** fixed. The A1 7b test is split: confirmed during `ownsCourse` (before the claim) → 0 rows, nothing published; confirmed after the claim → stays `confirmed`, the late reminder accepted.
- **Reconcile addendum:** superseded. ethio-impl reports 6a's step 7 ruling R15 already makes `reconcile` verify a `failed` row with a `chapa_checkout_url`, and guards the checkout-URL write on `pending`. Decision 10 now says 6c builds on that and doesn't touch `reconcile`; 6a's tests cover it, and step 7b tells impl to confirm R15 is on the branch first. Your S1 note on its test wording is moot, because the test moved to 6a.
- **N6:** taken (decision 11: a failed payment row may exist and keeps the dangling id; harmless).
- **N7:** taken (Rollout 1: a read-only select for coupons whose `uses` exceeds their confirmed payments).

## Drift check (2026-10-03, against origin/main 4b4a64c and fix/security-platform)
Not a review round, and separate from round 3 above (amendment A). A read-only check of the unchanged parts of the plan against the code it will be built on. Subagents did the sweep; I verified the first item against the code myself. There are no clashes with 6a:
- 6a's changes to `createSession` and `failPayment` don't touch 6c's wallet, refund or payout code;
- `confirmPayment` keeps its own `now` and the savepoints;
- 6a's financial migrations end at `1790966512489`;
- the Current-state refs match.

### Should-fix
- **D1. Step 8's concurrent refund-vs-payout check passes vacuously.**
  - **Why:** a payment is claimable only 7 days or more after `COALESCE(webhook_received_at, created_at)` (`payout.service.ts:126-128`). Decision 4 puts the refund window on the same clock and ends it at 7 days. So on "an eligible payment", every racing refund is auto-denied, and the check can't fail even with the claim predicate removed.
  - **The real race:** a pending manual refund (requested in-window) against a later payout run.
  - **Fix:** test it in sequence:
    - make an in-window 20–50 % refund request (it stays pending), backdate the payment past the hold, run payouts, and assert the payment is unclaimed;
    - deny the refund, run payouts again, and assert it's claimed.

    Don't use `checkout.payment_id` for this, because `e2e-payments.mjs:215-222` expects that one paid out.

### Fixes
- **D2. Steps 3–6 don't list the Phase 4 tests that break by design.** List them as tests to rewrite:
  - `growth.wallet.spec.ts:121,144` and `payment.service.spec.ts:302` assert the balance after cashback or a referral reward;
  - `payment.service.spec.ts:395-401` records a bank transfer with no `bank_reference`, and its fake client must answer the users and entitlements lookups;
  - `payout.service.spec.ts:94-104` seeds only a `refund_requests` row;
  - `refund.service.spec.ts:19-57` drives the window from `enrolledDaysAgo`, its payment row has no `webhook_received_at` or `created_at`, and the constructor has no DataSource.
- **D3. Decision 3, a 0-row flip on approve.** The plan gives only the paid-out 400 with a rollback. But Phase 4's `refund.service.spec.ts:156-162` expects `decide(approve)` on a payment that is no longer confirmed to resolve, with no `RefundApproved`. So on 0 rows, re-read the payment:
  - if `payout_id` is set → the 400, with a rollback;
  - otherwise → Phase 4's no-op.
- **D4. The handoff says `db:check` enforces the partial-index `WHERE` text.** It doesn't compare predicates (Phase 4 handoff :58). An unnamed CHECK also drifts; 6a named its own (`@Check('CHK_coupons_max_uses_per_user', …)`).
  - Verify the predicates in `pg_indexes`.
  - Use a named `@Check` for `state`.
- **D5. The API contract.** The route is `POST /refunds/:id/decide` (`controllers.ts:149`; web `admin/page.tsx:255`), not `/admin/refunds/…`. The bullet "This breaks the old body…" sits under decide, but it belongs to bank-transfer.
- **D6. Decision 7 says the bank-transfer form shows errors "inline, the way it shows errors today".** It uses `alert()` (`admin/page.tsx:149-151`), and the Non-goals keep that style. Write "via the existing `alert()`".
- **D7. Step 1 says the folder is in `.git/info/exclude`.** It still isn't. The user adds it, or the folder is committed with `git add -f` as 6a did.

### Planner responses to the drift check
- **D1:** fixed. Step 8's refund-vs-payout check now runs in sequence on a new paid course: a pending in-window request, backdated past the hold → unclaimed; deny → claimed. It doesn't use `checkout.payment_id`.
- **D2:** fixed. Steps 3–6 each list the Phase 4 specs that break by design and how they change (wallet balances, the refund window setup and DataSource, the payout seed, the bank-transfer reference and lookups).
- **D3:** fixed. Decision 3: on a 0-row flip, re-read the payment. `payout_id` set → the 400 with rollback; otherwise Phase 4's no-op, and its existing test is kept (step 4). Also in the API contract.
- **D4:** fixed. The `state` CHECK is named `CHK_wallet_transactions_state` with `@Check`, and step 2 plus the handoff check both partial-index predicates in `pg_indexes`.
- **D5:** fixed. The route is `POST /refunds/:id/decide`, and the "breaks the old body" bullet moved under bank-transfer.
- **D6:** fixed. Decision 7 and step 6 say the existing `alert()`.
- **D7:** fixed. Step 1 and the handoff say the folder isn't excluded yet: the user adds it, or it's committed with `git add -f`. The base is now `fix/security-platform`, stacked (plan Base line and handoff Branch).
