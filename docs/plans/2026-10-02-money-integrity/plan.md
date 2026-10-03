# Phase 6c: Money integrity II

Status: approved (round 2); amendment A approved in round 3 with S1–S3 folded in; drift check (2026-10-03) folded in
Size: L (sessions: 4; ethio-impl implements, ethio-reviewer reviews the code)
Base branch: `fix/security-platform` (Phase 6a), stacked. 6a changes `createSession`, `failPayment`, `reconcile`, the financial migrations and every internal call (its `internalPath` helper), so this plan builds on its code. No push or PR until 6a has merged; then `git merge origin/main` once. · Feature branch: `fix/money-integrity`
Roadmap: phase 6c, added after the Phase 4 code review (ethio-reviewer's security pass found three money gaps outside Phase 4's scope). Runs after 6a and before 6b, by the user's decision on 2026-10-02.
Findings: P1-59, P1-60, P2-42, plus amendment A: P1-61, P1-62, P2-46 (in the local `audit.md`). Line references are from `fix/payment-integrity` (Phase 4, approved); 6a moves some of them, so find the function by name.

Local only until the branch exists: this folder describes unfixed money holes and the repo is public.

## Goal
Close three ways money leaves the platform without a matching sale:
- **P1-59:** an approved refund keeps the purchase's 5 % cashback and the referrer's 50 ETB reward. Refunds under 20 % progress within 7 days are auto-approved, so buy → refund → keep the credits is self-serve and repeatable, and the credits are spendable on courses.
- **P1-60:** recording a bank transfer creates and confirms a new payment on every call, with no idempotency key and no "already owns the course" check. A double-submit or a retry pays the educator twice and credits cashback twice.
- **P2-42:** a refund can be requested between the payout run's refund lookup and its claim, and a refund can be approved on a payment that is already in a payout. Either way the educator is paid and the learner refunded.

- **Amendment A (2026-10-03):** ethio-impl found these three pre-existing issues in 6a step 7. The code is verified on `fix/security-platform`. They're in the same service and files:
  - **P1-61:** the abandoned-checkout reminder saves the whole payment row after two HTTP calls, so it can write `pending` back over a confirmation that landed meanwhile. That also reopens Phase 4's pending→confirmed guard, so a later sweep or reconcile can confirm the same payment a second time.
  - **P1-62:** the sweep re-verifies only `pending` rows. A superseded checkout (6a) that the payer completes late is confirmed only if Chapa's webhook arrives, and webhooks to a sleeping free-tier service can be lost (P0-09).
  - **P2-46:** a refused gift or pay-request checkout leaves its sponsorship row behind:
    - a gift stays `pending_payment` forever, and counts toward the daily gift cap;
    - a pay request stays `pending_payment` with the refused payer as its sponsor.

**User decision (2026-10-02):** cashback and referral rewards stay *pending* until the refund window closes, and an approved refund voids them. No clawback and no negative balances.

Acceptance criteria:
- A purchase's cashback and referral reward are recorded at confirmation as **pending**, with `available_at` = the payment's confirmation time + 7 days + 1 hour. They don't count toward the spendable balance until then.
- Pending credits become spendable on the first wallet read or spend after `available_at`, exactly once, with no cron. A credit whose payment has an open refund request, or has been refunded, never releases.
- An approved refund (auto or admin) voids that payment's pending cashback and referral reward, once. A denied refund leaves them to release as normal.
- The 7-day refund window is measured from the payment's confirmation, the same clock as `available_at`.
- Recording the same bank transfer twice (same bank reference) creates one payment. The same reference for a different learner or course is a 409. A learner who already owns the course gets a 409. If ownership can't be checked, the request fails rather than guessing.
- A payment with an open (pending) or approved refund request is never claimed by a payout. An auto-denied request leaves the payment claimable. A refund can't be requested on a payment that is already in a payout; the learner is told to contact support. Postgres serializes the two on the payment row, so no interleaving pays both.
- Top-ups, wallet purchases and admin adjustments behave exactly as before.
- **(A1)** The abandoned-checkout reminder never writes a payment's status. A payment confirmed while the job is between its HTTP calls stays confirmed, and each payment gets at most one reminder.
- **(A2)** The sweep also re-verifies failed Chapa payments in its window whose checkout page was opened, so a late-paid superseded checkout is confirmed without the webhook, exactly as the webhook would confirm it. Paying both pages of a superseded purchase is a duplicate purchase, and a refund case. A row Chapa reports unpaid (or still pending) stays `failed`. The return page's reconcile already re-verifies the learner's own failed row with a checkout URL in 6a (step 7, ruling R15), so 6c doesn't change `reconcile`.
- **(A3)** A refused gift checkout leaves no sponsorship row. A refused pay-request checkout puts the request back to `requested` with no sponsor, without undoing another payer's checkout.

## Non-goals
- Clawback of a refund on a payment that's already paid out. Those go to support (the API now says so).
- Reconciling past refunds that kept their rewards. Rollout step 1 lists them read-only for the user to decide.
- Re-arming a referral after its reward is voided. The referral stays `rewarded`; only the wallet row is voided.
- Partial refunds (spec open question), refunds of wallet- or coupon-paid purchases (support), negative wallet balances.
- A release cron. Release is lazy because free-tier services sleep (Phase 11 owns schedulers).
- `ownsCourse` failing open at checkout (P1-18, Phase 9). Only the new bank-transfer check fails closed.
- Admin-page dialogs and toasts (P1-42, Phase 8); the bank-transfer form keeps its current feedback style.

## Current state
- **Wallet** (`api/services/financial/src/entities.ts:250-294`):
  - `wallets.balance_etb` is a stored balance.
  - `wallet_transactions` has `(user_id, amount_etb signed, kind, reference, note, created_at)` and the partial unique `(kind, reference) WHERE kind IN ('topup','cashback','referral_reward','purchase')` from Phase 4.
  - Kinds: `topup | purchase | referral_reward | cashback | gift_sent | admin_adjust`.
- **Writes** (`growth.service.ts`):
  - `creditWith` (`:216-239`): `INSERT … ON CONFLICT DO NOTHING RETURNING id`, then `balance_etb = balance_etb + amount`.
  - `debitWith` (`:247-264`): inserts the row, then `UPDATE wallets … WHERE balance_etb >= $2`. Zero rows → 400 and rollback. That conditional is the only overspend guard.
  - `creditCashback` (`:413-417`, reference = payment id) and `rewardReferrer` (`:424-437`, reference = referral id) run in savepoints inside `confirmPayment` (`payment.service.ts:443-502`).
  - `credit()` announces `WalletCredited` for `cashback`, `referral_reward`, `topup` and `admin_adjust`. The notification says "added … spend it on any course" (`notification.service.ts:331-334`).
- **Reads:**
  - `GET /wallet` (`growth.service.ts:174-184`) returns `balance_etb` plus the last 50 transactions.
  - Admin stats (`:298-311`) sum `wallets.balance_etb` as the liability and group transactions by kind.
  - Web: dashboard `WalletCard` (`web/src/app/(learn)/dashboard/page.tsx:203-254`), checkout "pay from wallet" (`(public)/courses/[id]/enroll-panel.tsx:42-44,77,173-179,240`), admin `growth-tabs.tsx:18,124-151`.
- **Refunds** (`refund.service.ts`):
  - `REFUND_WINDOW_DAYS = 7` (`:9`), measured from the *enrollment's* `enrolled_at` (`:49`). A re-purchase after a refund reuses the old enrollment row, so its window has already closed.
  - Auto-approve under 20 % (`:66-72`); 20–50 % pending for an admin.
  - `finalizeApproval` (`:141-153`) flips the payment to `refunded` and emits `RefundApproved`. Nothing touches wallet rows, `payout_id` or payouts.
- **Payouts** (`payout.service.ts:115-177`):
  - Candidates and the pending-refund lookup (`:131-133`) are read before the transaction.
  - The claim is `UPDATE payments SET payout_id … WHERE id IN (…) AND payout_id IS NULL AND status='confirmed'` (`:139-148`), with no refund check.
  - Hold is 7 days (14 for new educators) from `COALESCE(webhook_received_at, created_at)`. `webhook_received_at` is the confirmation time on every path (`payment.service.ts:457,487`).
- **Bank transfer** (`payment.service.ts:608-629`; `controllers.ts:40-46,192-197`; web `(admin)/admin/page.tsx:121-159`):
  - The DTO is `{ learner_id, course_id }` and `chapa_tx_ref = bank-<uuid>`.
  - `chapa_tx_ref` is already unique (`entities.ts:41-43`, Baseline migration).
  - `ownsCourse` (`:742-749`) calls `/internal/entitlements` and swallows errors to `false`.
- **Tests:**
  - `testing/fake-db.ts` matches raw SQL by exact regex (`:197-241`, wallet SQL at `:199-221`) and throws on anything else, so new SQL needs matching fake-db support.
  - Specs: `growth.wallet.spec.ts`, `refund.service.spec.ts`, `payout.service.spec.ts`, `payment.service.spec.ts`, `controllers.spec.ts`.
  - `scripts/e2e-payments.mjs` runs on real Postgres in CI.

## Design and key decisions
1. **Pending credits live in `wallet_transactions`; `wallets.balance_etb` stays the spendable balance.**
   - New columns: `state` (`'available' | 'pending' | 'void'`, default `'available'`), `available_at timestamptz NULL` and `payment_id uuid NULL` (the purchase that earned the credit).
   - `creditCashback` and `rewardReferrer` insert `state='pending'`, `available_at = confirmedAt + 7 days + 1 hour`, `payment_id = payment.id`, and **don't** touch `balance_etb`.
   - `confirmedAt` is `confirmPayment`'s own `now`, passed in as an argument (round-1 S2). The in-memory `payment.webhook_received_at` is set only after commit, so inside the transaction it is `null` or a stale failure time.
   - The extra hour (round-1 N1) puts every release after the window closes, whatever the clock skew between the app and Neon. Every other kind is unchanged: `available` and added at once.
   - Rejected: computing the balance as `SUM(available rows)`. That replaces the stored balance and its overspend guard everywhere, which is a much bigger change for the same result.
2. **Lazy release, exactly once.** `releaseMatured(m, userId)`:

   ```sql
   UPDATE wallet_transactions SET state = 'available'
   WHERE user_id = $1 AND state = 'pending' AND available_at <= now()
     AND NOT EXISTS (SELECT 1 FROM payments p
                     WHERE p.id = wallet_transactions.payment_id
                       AND (p.refund_requested_at IS NOT NULL
                            OR p.status <> 'confirmed'))
   RETURNING amount_etb
   ```

   Then it adds the sum to `balance_etb`, in the same transaction.
   - The conditional `state` change is the once-only guarantee: two concurrent reads release a row once, because the second sees `available` under the row lock.
   - Called at the start of `GET /wallet` (now inside a transaction) and inside `debitWith` before its conditional UPDATE, so a spend sees matured credits.
   - The `NOT EXISTS` is keyed on the **payment row** (round-1 S1), not on `refund_requests.status`:
     - the mark is set with an accepted request;
     - it stays set through approval, when the status becomes `refunded`;
     - only a denial clears it.
   - So no ordering of commits can release a credit for a payment that is refunded or has an open refund. The refund window closes an hour before `available_at` (decision 1), so a request can't arrive after release either.
3. **Void on approval, in one transaction with the decision and the flip** (round-1 S1). On both the auto-approve path and admin `decide(approve)`, one transaction does:
   - the refund row's status (insert as `approved`, or the conditional `pending → approved`);
   - the payment flip `status = 'refunded' WHERE id = $1 AND status = 'confirmed' AND payout_id IS NULL` (round-1 N2: a legacy pending refund on an already paid-out payment then fails with the support message and rolls back, instead of paying both);
     - **0 rows** (drift D3): re-read the payment. `payout_id` set → the 400 with the support message, and roll back. Otherwise (no longer `confirmed`, e.g. refunded through another path) → Phase 4's no-op: the decision resolves and no `RefundApproved` goes out, as `refund.service.spec.ts` ("approving does not refund a payment that is no longer confirmed") expects;
   - then the void:

   ```sql
   UPDATE wallet_transactions SET state = 'void'
   WHERE payment_id = $1 AND state = 'pending'
     AND kind IN ('cashback', 'referral_reward')
   ```

   - The void happens only when the flip succeeded, so a replay is a no-op. `RefundApproved` is emitted after commit.
   - A row already `available` can't exist for a payment with an open refund (decision 2), so there is nothing to claw back.
   - Admin denial, in one transaction: the conditional `pending → denied`, and the payment mark cleared. The credit then releases when it matures.
4. **The refund window is measured from the payment's confirmation** (`COALESCE(webhook_received_at, created_at)`), not from `enrolled_at`.
   - It's the same clock as `available_at`, which decision 2 relies on.
   - It's what a learner reads as "7 days from purchase".
   - It fixes the re-purchase case, where the old `enrolled_at` closes the window at once.
   - Progress still comes from the entitlement.
5. **A refund request marks the payment row; the payout claim respects the mark.** New column `payments.refund_requested_at timestamptz NULL`.
   - **Request** (round-1 B1). The rules run first, exactly as today (certificate, assessment, window, progress band), so an outside-window learner gets the outside-window denial and not a support message.
     - Outcome `DENIED`: insert the row as today. `payments` is **not** touched, so the payment stays claimable. Otherwise any buyer could block an educator's payout with a request the rules deny.
     - Outcome `PENDING` or `APPROVED`: one transaction marks the payment, then inserts the row (and, for `APPROVED`, runs decision 3 in the same transaction):

     ```sql
     UPDATE payments SET refund_requested_at = now()
     WHERE id = $1 AND status = 'confirmed'
       AND payout_id IS NULL AND refund_requested_at IS NULL
     ```

     - 0 rows with `payout_id` set → 400 "This payment has already been paid out to the educator. Contact support from Help to request a refund."
     - 0 rows with the mark set → the existing `ALREADY_OPEN`.
     - The unique open-refund index stays as the backstop.
   - **Admin denial** clears the mark (decision 3). **Approval** keeps it and sets `refunded`, which the claim's `status='confirmed'` also excludes.
   - **Claim** adds `AND refund_requested_at IS NULL`. Because both sides are UPDATEs of the same row, Postgres serializes them and re-checks the `WHERE` on the newest version. Whichever commits first wins, and the other matches 0 rows. The pre-transaction refund lookup in `payPayee` (`:131-133`) becomes redundant and is removed.
   - Rejected: a `NOT EXISTS (refund_requests …)` in the claim. A subquery on another table isn't re-checked under the row lock, so a concurrent request can slip through.
6. **Bank transfer: the bank's reference is the idempotency key.**
   - The DTO gains `bank_reference` (required; trimmed and upper-cased; 3–64 of `A-Z 0-9 - _ /`), stored as `chapa_tx_ref = 'bank-' + reference`.
   - Order of checks:
     1. An existing payment with that `chapa_tx_ref`:
        - same learner and course → return it (idempotent replay; if it's still `pending` or `failed`, run `confirmPayment` again, which is once-only);
        - otherwise → 409 "This bank reference is already recorded for another payment."
     2. A `confirmed` course payment for this (learner, course) in the financial DB → 409 "This learner already paid for the course" (round-1 S4). This check is synchronous, so it catches a Chapa payment confirmed seconds ago, before the enrollment service has created the entitlement. `refunded` payments don't count.
     3. The learner exists, via the internal users lookup. Not found → 404; lookup failed → 503.
     4. Ownership via `/internal/entitlements`, for courses granted any other way (gift, seat, sponsorship). Active → 409 "This learner already owns the course"; lookup failed → 503 "Couldn't check enrollment. Try again." This check fails closed, unlike checkout's `ownsCourse`.
     5. Insert. A 23505 on `chapa_tx_ref` (a concurrent double-submit) → re-read and apply step 1.
   - New internal calls use 6a's `internalPath` helper.
7. **Contract and copy for pending credits:**
   - `GET /wallet` adds `pending_etb` and, per transaction, `state` and `available_at`.
   - Admin stats add `pending_rewards_etb` and exclude `void` rows from the by-kind sums.
   - `WalletCredited` gains an optional `available_at`. The notification for a pending credit reads "{amount} ETB cashback, available on {date}" (and the same for referral rewards), and the body no longer claims it's spendable.
   - Web:
     - `WalletCard` shows "+{pending} ETB pending" under the balance, and each pending or voided row gets "Available {date}" or "Refunded".
     - Checkout keeps using `balance_etb`, which is the spendable balance.
     - The admin liability card adds the pending figure.
     - The admin bank-transfer form gets a required "Bank reference" field and shows a 409 or 503 message through the existing `alert()`, the way it shows errors today (drift D6; dialogs and toasts are Phase 8).
9. **(A1) The reminder claims the row; it never saves it.**
   - **The change:** in `nudgeAbandonedCheckouts`, both `payments.save(payment)` calls become `payments.update({ id, status: PENDING, nudged_at: IsNull() }, { nudged_at: new Date() })`.
     - The claim happens **before** `learnerInfo`.
     - `PaymentAbandoned` is published only when `affected === 1`.
     - The owns-course branch makes the same conditional update and publishes nothing.
   - **Why:** TypeORM's `save` diffs the in-memory row against a fresh read, so the stale `pending` overwrites a concurrent `confirmed`.
   - **No other call site:** the other `payments.save` calls in financial insert new rows (`payment.service.ts` ~:240, ~:355, ~:789).
   - **Trade-off:** claiming first means a failing `learnerInfo` loses that one reminder rather than sending two. That's acceptable for a nudge.
10. **(A2) The sweep widens its selection; the confirm path is unchanged.**
    - **The change:** after the pending query, `sweepPendingPayments` runs a second one: `status: FAILED`, `method: CHAPA`, `chapa_tx_ref` not null, **`chapa_checkout_url: Not(IsNull())`**, the same 24 h window, **`order: { created_at: 'DESC' }`** (like the pending query, so recent supersedes go first), `take: 10`. Each row goes through the same `applyVerification(…, 'sweep')`.
    - **Why the checkout-URL filter** (round-3 S2): a `checkout_open_failed` row has a `chapa_tx_ref` but no checkout URL (the URL is written only after Chapa opens the page), so it can never be paid. Without the filter, a Chapa outage leaves dozens of them, they fill the 10 slots for 24 hours, and a superseded checkout paid late in that time is never swept.
    - **What it settles** (round-3 S1): for a gateway source (`sweep`, webhook, reconcile), `confirmPayment` claims `PENDING` or `FAILED` rows, and 6a's comment says a superseded row's late payment "still confirms". 6a's rule that a superseded row is never settled covers only *instant* settlements (wallet, 100 % coupon). So a superseded Chapa row that verifies `success` is confirmed, as the webhook already does. If the payer paid both pages, that's a duplicate purchase and a refund case; leaving real money on a `failed` row would hide it from refunds and support. A row Chapa reports `failed` or still pending stays `failed`. **Don't add a guard against settling superseded Chapa rows.**
    - **The cost:** re-verifying a failed row Chapa reports unpaid is one verify call and nothing else.
    - **Rejected:** a `fail_reason` column to target only superseded rows. That's a migration to save at most 10 verify calls per run.
    - **Reconcile is 6a's, not 6c's.** Before 6a's step 7 fix, `reconcile` verified only `PENDING`, so the return page (`payment/return/page.tsx`) showed the terminal "Payment not completed" for a superseded checkout the payer completed late, and could push them to pay again. 6a's ruling R15 (reported by ethio-impl, 2026-10-03) makes `reconcile` also verify a `failed` row that has a `chapa_checkout_url`, and guards the checkout-URL write on `status = pending` (0 rows → the same 409 as `settleInstantly`). 6c builds on that branch and doesn't touch `reconcile`; 6a's tests cover it. **Before step 7b, confirm R15 is on `fix/security-platform`** (`git log`, `reconcile` in `payment.service.ts`); if it isn't, tell ethio-planner rather than adding it here.
11. **(A3) Undo the sponsorship side of a refused checkout.**
    - **Gift:** if `payments.createSession` throws, delete the gift row that was just created, then rethrow. No email exists yet. A failed payment row may exist (`wallet_insufficient`, `checkout_open_failed` or `error`), and its `meta.sponsorship_id` keeps the dangling id. That's harmless: no checkout URL reached the payer, so it can't be paid (round-3 N6).
    - **Pay request:** if `createSession` throws, run `sponsorships.update({ id, status: 'pending_payment', sponsor_id: ctx.id, payment_id: IsNull() }, { status: 'requested', sponsor_id: null, sponsor_name: null })`, then rethrow. The predicate means a concurrent payer's checkout is never undone.
    - **Bulk purchases:** if they have the same create-then-checkout shape, apply the same rule and log it under Deviations.
12. **Fake DB:** extend `testing/fake-db.ts` for the new wallet INSERT columns, `releaseMatured`, the void UPDATE, and the payment mark and claim predicates. Keep its exact-match style, so unexpected SQL still throws.

## Data model and migrations
Financial migrations, timestamps after 6a's, registered in `migrations/index.ts`; the entity decorators must match the DDL so `db:check` stays at 0:
- **Migration 1 (transactional):**
  - `wallet_transactions ADD state varchar(16) NOT NULL DEFAULT 'available'`, a **named** CHECK on the three values (`CHK_wallet_transactions_state`, declared with `@Check('CHK_wallet_transactions_state', …)` on the entity, like 6a's `CHK_coupons_max_uses_per_user`; an unnamed CHECK drifts), `ADD available_at timestamptz NULL` and `ADD payment_id uuid NULL`. A constant default is metadata-only on PG 11+, so there's no table rewrite.
  - `payments ADD refund_requested_at timestamptz NULL`.
  - Backfill: `UPDATE payments p SET refund_requested_at = r.created_at FROM refund_requests r WHERE r.payment_id = p.id AND r.status = 'pending'`.
  - Existing rows stay `available`: credits already in balances are not reclassified (non-goal).
- **Migration 2 (`transaction = false`, drop-if-exists first, one statement per query):**
  - `(user_id, available_at) ON wallet_transactions WHERE state = 'pending'` (release);
  - `(payment_id) ON wallet_transactions WHERE payment_id IS NOT NULL` (the void).
  - No new `refund_requests` index: the open-refund unique index already serves the lookups (round-1 N3). The release joins `payments` by primary key.
- `db:check` doesn't compare partial-index predicates (drift D4), so step 2 checks both `WHERE` clauses in `pg_indexes` by hand.
- `down()` drops the indexes and columns. Local only; see Rollout for a production rollback.

## API contract
- `GET /wallet`: adds `pending_etb` (number) and, per transaction, `state` (`available | pending | void`) and `available_at` (ISO or null). `balance_etb` is the spendable balance, as today.
- `POST /refunds`:
  - new 400 when the rules accept the request but the payment is already in a payout (support message above);
  - the window is now 7 days from the payment's confirmation (the `outside_7_day_window` rule keeps its name);
  - otherwise unchanged.
- `POST /admin/payments/bank-transfer`:
  - body `{ learner_id, course_id, bank_reference }`, all required;
  - 201 with the payment for a new transfer, 200 with the existing payment on an exact replay;
  - 409 for a reference used for another payment, a course the learner already paid for, or one they otherwise own;
  - 404 for an unknown learner, 503 when a lookup fails;
  - this breaks the old body; the same PR updates the admin form.
- `POST /refunds/:id/decide` (approve; the admin route in `controllers.ts`, called from `admin/page.tsx`): new 400 with the support message when the payment is already in a payout (a legacy case; round-1 N2). A payment that is no longer `confirmed` for another reason stays Phase 4's no-op (drift D3).
- Admin growth stats: adds `pending_rewards_etb`.
- `WalletCredited` event: optional `available_at` (contracts package).

## Steps
- [x] 1. Branch `fix/money-integrity` from the `fix/security-platform` tip (stacked on 6a). This folder is meant to be in `.git/info/exclude`, but it isn't yet (drift D7): the user adds it. Either way, commit the folder with `git add -f`, as 6a did, or leave that to the user. Stage paths explicitly; several plan folders are untracked.
- [x] 2. Migrations 1 and 2 plus entity changes (`state` with the named CHECK, `available_at`, `payment_id`, `refund_requested_at`); `db:check` 0 on a fresh and an existing local DB; both partial-index `WHERE` clauses checked in `pg_indexes` (D4); revert round-trip; the backfill tested on a seeded pending refund.
- [x] 3. Pending credits and lazy release (decisions 1–2): `creditWith` takes an optional `{ state, available_at, payment_id }`; `creditCashback` and `rewardReferrer` pass pending; `releaseMatured` in `GET /wallet` and `debitWith`; fake-db support.
  - Tests:
    - a cashback is pending and the balance is unchanged;
    - after `available_at`, one read releases it, and a second read doesn't add it again;
    - a spend that needs a matured credit succeeds; one that needs a still-pending credit fails with today's 400;
    - a credit with an open refund stays pending past `available_at`, and so does one whose payment is `refunded` (even if the void didn't run);
    - a payment that failed and was confirmed later gets `available_at` from the confirmation, not the failure (round-1 S2);
    - top-up and admin adjust are unchanged.
  - Phase 4 specs that break by design (drift D2), rewritten to the new rule: `growth.wallet.spec.ts` (the two balance-after-cashback/referral-reward assertions) and `payment.service.spec.ts` (the balance after cashback). They now expect the balance unchanged and a pending row.
- [x] 4. Refunds (decisions 3–5):
  - the window from the payment's confirmation;
  - the request transaction with the payment mark and the paid-out 400;
  - the rules before the mark; the mark only for `PENDING` and `APPROVED`;
  - one transaction for decision, flip and void, on the auto and admin paths; admin denial clears the mark in its transaction.
  - Tests:
    - approve voids cashback and referral, and a replayed approval is a no-op;
    - deny leaves them, and they release later;
    - an auto-denied request (certificate, outside the window, over 50 %) leaves the payment unmarked and claimable (round-1 B1);
    - an accepted request on a paid-out payment → 400; an approval of a legacy pending refund on a paid-out payment → 400 and nothing changes (N2);
    - a re-purchase after a refund is refundable within 7 days of the new payment;
    - an approval on a payment refunded through another path → resolves, no `RefundApproved` (Phase 4's existing test, kept; D3).
  - Phase 4 spec that breaks by design (D2): `refund.service.spec.ts` drives the window from `enrolledDaysAgo`, its payment row has no `webhook_received_at` or `created_at`, and its constructor has no DataSource. Rewrite its setup so the window comes from the payment's confirmation time and the service gets a (fake) DataSource for its transactions.
- [x] 5. Payout claim (decision 5): `AND refund_requested_at IS NULL`; remove the pre-transaction refund lookup.
  - Tests:
    - a payment with an open request isn't claimed, and it is claimed after denial;
    - a request after the claim → 400.
  - Phase 4 spec that breaks by design (D2): `payout.service.spec.ts`'s pending-refund case seeds only a `refund_requests` row. It now seeds the payment's `refund_requested_at` as well, since the claim reads the mark.
- [x] 6. Bank transfer (decision 6): DTO, the four checks, 23505 re-read, admin form field, errors through the existing `alert()` (D6).
  - Tests:
    - a replay returns the same payment with one cashback;
    - a learner with a confirmed Chapa payment for the course → 409, even while the entitlements endpoint still says not active (S4);
    - a mismatched replay → 409;
    - an owned course → 409;
    - an entitlements failure → 503;
    - an unknown learner → 404;
    - a concurrent double insert → one payment.
  - Phase 4 spec that breaks by design (D2): `payment.service.spec.ts`'s bank-transfer case records a transfer with no `bank_reference`, and its fake client must now answer the users and entitlements lookups. Give it a reference and those answers.
- [x] 7. Contract and copy (decision 7):
  - `GET /wallet` fields; admin stats; `WalletCredited.available_at` and the notification text;
  - web `WalletCard` pending line and row labels; admin liability card.
  - vitest for `WalletCard` pending and void rendering.
- [x] 7b. (A1–A3) Decisions 9–11, with fake-db unit tests:
  - **A1** (round-3 S3: the claim comes before `learnerInfo`, so the race splits in two):
    - the row turns `confirmed` while `ownsCourse` is awaited, before the claim → the claim affects 0 rows, nothing is published, and the row stays `confirmed`;
    - the row turns `confirmed` after the claim (while `learnerInfo` is awaited) → it stays `confirmed`; the late reminder is accepted;
    - a second run publishes nothing;
    - the owns-course path publishes nothing.
  - **A2** (round-3 S1, S2):
    - a failed Chapa row with a checkout URL, in the window, that verifies `success` → confirmed, including a superseded row whose retry already settled (a duplicate purchase, refundable);
    - one that verifies `failed` or still pending → stays `failed`, no event;
    - a failed row with no checkout URL (`checkout_open_failed`) is never selected, even when 10 or more of them are newer than a payable one;
    - pending rows are still swept first.
    - Reconcile on a failed row: 6a's R15 tests cover it; nothing to add here.
  - **A3:**
    - a refused gift leaves no sponsorship row;
    - a refused pay request is back to `requested` with no sponsor;
    - it doesn't undo another payer's `pending_payment`.
- [x] 8. `scripts/e2e-payments.mjs` (real Postgres, mock mode):
  - buy a paid course → cashback pending, `balance_etb` unchanged;
  - request a refund (auto-approved) → the cashback is `void` and the balance unchanged;
  - buy another course, backdate its cashback row's `available_at` (and the payment's `webhook_received_at`, for consistency) by 8 days through the compose Postgres, then call `GET /wallet` twice concurrently → the balance rises by the cashback exactly once (round-1 S3);
  - refund vs payout, in sequence (drift D1: a payment is claimable only after the 7-day hold, and the refund window closes at 7 days on the same clock, so a concurrent race on an eligible payment would only ever be auto-denied and couldn't fail). On a new paid course (not `checkout.payment_id`, which the script expects paid out): make an in-window 20–50 % refund request (it stays pending), backdate the payment's `webhook_received_at` and `created_at` past the hold, run payouts → the payment is unclaimed; deny the refund, run payouts again → it is claimed;
  - record the same bank transfer twice concurrently → one payment;
  - (A3) a gift with a fully used coupon → 400, and the sponsor's gift count is unchanged. A1 and A2 can't be reached in mock mode (a cron, and a live-only sweep), so they are unit-tested only.
- [x] 9. Full gate: api build + tests + typecheck + `db:check`, web typecheck + test + build, all e2e scripts, both images build.
- [ ] 10. Code review by ethio-reviewer; the user approves push/PR (same-day merge and deploy); rollout below.

## Test plan
- Unit (fake DB): steps 3–7 and 7b as listed.
- Real Postgres: step 8 in CI's e2e job, plus a mutation check logged in Progress: remove the claim's `refund_requested_at` predicate and the release's `state` condition, and confirm the e2e fails each time.
- Commands: `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`; `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`; `node scripts/e2e-payments.mjs` (on `.env.example` values only).

## Rollout and ops
1. **Read-only checks against production before merging** (the user runs them):
   - refunded payments whose cashback or referral reward was kept (history, for the user to decide; no automatic action);
   - payments with a pending refund that already have a `payout_id` (support cases);
   - the count of pending refunds (the backfill target);
   - **(A1)** Chapa course payments still `pending` after 48 h whose learner is enrolled in that course. Each one is a confirmation the reminder may have reverted; the user decides, and nothing is automatic.
   - **(A1, round-3 N7)** coupons whose `uses` exceeds their confirmed payments. A row reverted within 24 h was re-confirmed by the sweep, which ran `recordCouponUse` a second time; 6a counts `GREATEST(uses, confirmed)`, so an inflated `uses` closes a coupon early. The user decides whether to correct `uses`.

   The SQL goes in DEPLOYMENT.md's Phase 6c section and selects only.
2. Deploy financial first (the new response fields are additive), then the web. The notification service picks up the new optional field without a deploy-order constraint.
3. Same-day merge and deploy (public repo, money hole).
4. **Rollback:** revert the code and keep the columns. **Before** reverting, the user releases every pending credit, so no learner loses one: a single transaction that adds each user's pending sum to `balance_etb` and sets those rows `available`. That SQL goes in DEPLOYMENT.md next to the checks.

## Risks and open questions
- **Learners see cashback a week later.** That's the user's decision; the dashboard and notification say when it becomes available.
- **Boundary race:** closed by the one-hour margin (decision 1) and by keying the release on the payment row (decision 2).
- **6a overlap:** both phases edit `payment.service.ts`, `growth.service.ts`, `entities.ts` and the migrations list. Stacking on `fix/security-platform` avoids conflicts; the line references above will have moved. 6a's financial migrations end at `1790966512489`, so 6c's timestamps come after it.
- **Fake DB brittleness:** every new raw SQL string needs a matching fake-db rule. Budget for it in steps 3–5.

## Progress and deviations (implementer)
Branch `fix/money-integrity`, created from `fix/security-platform` @ `e2c4014` (6a APPROVED). The plan folder is committed with `git add -f` (`5a81bef`). 6a merged as PR #24 (`c82d091`), and `origin/main` is merged in as `ac596e6`. It brought docs only, because 6a's code was already on the branch. The code review base is now `origin/main`.

- **Step 2 (`0a9eb57`):** `1790966512490-PendingCreditsRefundMark` and `1790966512491-PendingCreditIndexes`, and the entity declarations (`@Check('CHK_wallet_transactions_state', …)`, both partial `@Index`es).
  - `db:check` reports no drift on a fresh DB and on a copy of the dev DB.
  - Both partial-index predicates were checked by hand in `pg_indexes`.
  - The `-t none` revert removes the columns, the indexes and the CHECK, and a re-run restores them.
  - The backfill was tested on a seeded pending refund and an approved one: only the pending refund's payment is marked.
- **Step 3 (`839e853`, `ebfe1f2`):** pending cashback and referral rewards, and `releaseMatured` in `GET /wallet` (now one transaction) and in `debitWith`.
  - `confirmPayment` passes its own `now` to both credit helpers.
  - `fake-db.ts` matches the wallet INSERT with two exact column lists instead of a wildcard, plus an exact release rule.
  - The D2 specs are rewritten to the new rule.
  - api: 62 suites, 1015 tests pass. A throwaway real-Postgres run of the built service released once across 8 concurrent reads and used the partial index.
  - Interim until step 7: a pending credit's `WalletCredited` notice still has the old "spend it" copy.
- **Method:** subagent-driven development, with a task review per step. Rulings P1–P3 are in the pre-flight scan:
  - P1: A3 also covers `createBulk`, which has the same create-then-checkout shape.
  - P2: replaying a non-confirmed `bank-<REF>` row re-runs `confirmPayment` with the existing bank source.
  - P3: the DEPLOYMENT.md Phase 6c SQL goes into step 8.
- **Step 4 (`a93ce7d`, `471e08e`, fix round 1 `a3da407`):**
  - The rules run first. `DENIED` doesn't touch `payments`. `PENDING`/`APPROVED` mark the payment in one transaction with the insert, and an approval runs the flip and the void in that same transaction.
  - A 0-row mark answers the paid-out 400 or `ALREADY_OPEN`. A 0-row flip re-reads the payment: `payout_id` set → the 400 with rollback, otherwise Phase 4's no-op (D3).
  - Admin denial clears the mark in its transaction.
  - The window runs from `COALESCE(webhook_received_at, created_at)`.
  - The void is `GrowthService.voidPurchaseCredits(m, paymentId)`. `RefundService` now depends on `GrowthService`, with no DI cycle.
  - A refusal that wrote nothing commits an empty transaction and throws after it. On Postgres that's the same as a rollback.
  - api: 1034 tests pass. 9 mutation checks were caught. A real-Postgres run passed 20/20, including a request racing a payout claim 40 times.
  - **Ruling R1/R1a (deviation):** a request is judged on the payment's clock only when the learner's entitlement is `active`. With no enrollment, or an entitlement still `refunded` (a re-purchase whose grant hasn't been consumed yet), it keeps today's outcome: denied `outside_7_day_window`, payment not marked. Read literally, decision 4 would auto-approve these, and then a late grant would reopen access on a refunded payment.
- **Step 5 (`1c1b7fc`):** the claim and the candidate read add `refund_requested_at IS NULL`. The pre-transaction refund lookup and its `RefundRequest` constructor parameter are removed. The "request after the claim → 400" test drives the real `runPayouts` and `RefundService`. api: 1037 tests pass.
- **Step 6 (`a970b1b` api, `01d538a` web):** the five checks run in the plan's order, with the exact messages, and the 23505 re-read is in.
  - 201 or 200 comes from `@Res({ passthrough: true })`, as in `auth.controller.ts`.
  - The admin form has a required "Bank reference" field, with errors through `alert()`.
  - The messages the plan doesn't give are "Learner not found" (404) and "Couldn't check the learner. Try again." (503).
  - **Ruling R2:** check 3 tells 404 from 503 by InternalHttpClient's `-> 404` message suffix. ethio-planner added this call site to 9c decision 2, where `PeerNotFoundError` replaces the match.
  - api: 1076 tests pass, web: 381. 12 mutation checks were caught.
- **Merge (ruling R3):** 7a (PR #25) landed after the first merge, so `origin/main` is merged again as `c2798c7`, before step 7's web work. `admin/page.tsx` auto-merged and no api files changed. After installing web deps (7a added `@axe-core/playwright`), web typecheck is clean and 478 tests pass.
- **Step 7 (`4c78ab0` api, `508e26f` web):**
  - `GET /wallet` returns `pending_etb` (an SQL sum over all the owner's pending rows, open-refund rows included) and per-row `state` and `available_at`. Admin stats add `pending_rewards_etb` and leave `void` rows out of `by_kind`.
  - `WalletCredited.available_at` is set only for pending credits. The notification title for one reads "{amount} ETB cashback, available on {date}" (or "referral reward"). The body says when the credit moves to the balance and no longer says "spend it". Other credits keep today's copy. The notification service had no date helper, so it uses `en-GB` in `Africa/Addis_Ababa`. The web uses `formatDate`.
  - `WalletCard` moved to `dashboard/wallet-card.tsx` so vitest can import it (a Next page file can't export it). It shows "+{n} ETB pending" only when there is some, "Available {date}" on pending rows and "Refunded" on void rows. The admin page gets a separate "Pending rewards" tile beside "Wallet liability".
  - api: 1081 tests pass. web: 481 tests pass.
- **Step 7b (`a13f9e8` A1, `8bdc153` A2, `aecfe51` A3):**
  - A1: one conditional claim (`status = pending`, `nudged_at IS NULL`) after `ownsCourse` and before `learnerInfo`. A reminder goes out only when `affected === 1`.
  - A2: a second `find` for failed Chapa rows with a checkout URL (24 h window, newest first, 10 rows). The sweep runs one loop over pending rows, then failed rows. There is no guard against confirming superseded rows.
  - A3: a gift undo is `delete({ id, status: 'pending_payment' })`. A pay request is reset with decision 11's predicate. On an undo failure the error is logged and the original error rethrown.
  - Tests: the race tests fire a signed webhook from inside the job's own internal call. api: 1099 tests pass, RED first, and 8 guard mutations were each caught.
  - **Deviation (ruling P1):** bulk orders get the same undo, `bulk.delete({ id, status: 'pending_payment' })`.
  - **Deviation (ruling R4):** the gift and bulk deletes are conditional on `pending_payment`, not by id alone. A confirmation that already granted the row keeps it.
  - **Deviation (ruling R5):** the pay-request undo writes `sponsor_name: ''`, not `null`. The column is `NOT NULL DEFAULT ''`.
  - R15 was confirmed on the branch before the step started. `reconcile` is unchanged.
- **Step 8 (`307b612` e2e, `7a90d78` DEPLOYMENT.md):**
  - `e2e-payments.mjs` adds 22 checks, 42 in all, on its own learners, coupon and bank reference, so it can run again on the same DB. It covers every bullet in step 8:
    - pending cashback;
    - a refund that voids it;
    - a matured cashback released once, across two concurrent wallet reads (the balance is read from `wallets`, so the check doesn't release anything itself);
    - refund vs payout, in sequence, with progress at 33 % through the lesson-completion API;
    - two identical bank transfers at once give one payment (one 201, one 200);
    - a gift with a fully used coupon gives a 400 and adds no gift row.
  - It passed twice in a row on a fresh, unmutated `el_e2e`.
  - **Mutation checks (ruling R6):**
    - Removing `refund_requested_at IS NULL` from both the payout candidate read and the claim fails "a payout run skips the payment while its refund is under review".
    - Removing it from the claim alone passes. The candidate filter hides it there, so the claim-only predicate is pinned by the unit test and Task 4's real-Postgres race.
    - Removing the release's `state = 'pending'` fails "the matured cashback raised the balance exactly once" (0 → 50 for a 25 ETB cashback) and "a later wallet read releases nothing more".
  - **DEPLOYMENT.md (ruling P3):** a "Phase 6c" subsection under "Database migrations", with the five read-only pre-merge checks (pre-6c columns only) and the pre-rollback release transaction. All of it was run against `el_e2e`, with the release inside a rolled-back transaction: 6 credits for 4 owners, each balance up by exactly the owner's pending sum.
- **Rulings made during execution (SDD ledger):**
  - P1–P3, R1–R3: above.
  - R4: the gift and bulk undo deletes are conditional on `pending_payment`.
  - R5: `sponsor_name: ''`.
  - R6: mutation 1 removes the predicate from both queries.
- **Final whole-branch review (SDD, opus):** "With fixes", no Critical. One fix wave, re-reviewed as all addressed:
  - I1 (`abb9beb`): DEPLOYMENT.md gets a read-only refund-mark check (stale and missing marks, both 0) after every 6c deploy, and a mark re-sync to run before redeploying 6c after a rollback, while no one is deciding refunds (ruling R7).
  - M1 (`c63cbbf`): a concurrent identical bank-transfer submit that reaches check 2 or 4 after its twin re-reads by `bank-<REF>` and replays (200) instead of answering 409.
  - M2 (`4c09b86`): the admin refunds tab shows a refused decision (the paid-out 400) through `alert()`.
  - M3 (`1d9a0d0`): migration 1 alters and backfills `payments` before `wallet_transactions`, the app's lock order. `db:check`, the revert round-trip and the backfill were re-verified.
  - M4 (`c7c8962`): rollout check 5 counts refunded purchases apart from confirmed ones.
  - M5 (`f8fdce9`): a voided credit's amount is muted and struck through.
  - M6 (`579306c`): the nudge comment names the real lost-reminder case.
  - Left deferred, as the review triaged them: no index serves the A2 failed-row query (fine at today's volume; revisit in Phase 11), plus the listed test-pinning and logging minors.
- **Backlog for ethio-planner:**
  - `payRequest` and the gift and bulk `payment_id` saves still `save()` the whole row they read, so a grant landing in between can be overwritten (the A1 bug class, in `sponsorship.service.ts`). A payer opening a pay request while another payer's checkout is open overwrites the sponsor.
  - A refund on a duplicate purchase revokes an entitlement that another payment still pays for (enrollment side).
- **Deferred minors from the task reviews:** in the SDD ledger, for the final review to triage. They are test-pinning gaps, the payee listing including marked-only payees, bank-transfer refusals not logged with the admin id, and different references for one (learner, course) not being serialized.

- **Step 9 (gate on `c08d1db`, the fix-wave head plus docs):**
  - Run 1, on `c08be3a`, before the fix wave, passed everything except two 7a Playwright specs that timed out under load and passed on re-run.
  - Run 2, on `c08d1db`, passed everything:
    - api: build and typecheck clean, 62 suites and 1101 tests pass;
    - web: typecheck clean, 55 files and 482 tests pass;
    - a fresh `el_e2e` seeded with `db:check` "No drift";
    - e2e: demo-seed, revisions, institution, payments (42 checks), security and smoke all pass;
    - the web build passes in a clean env, and Playwright passes 75/75 with no flakes;
    - all 9 images build (8 api and the web).
  - Migrations: applied on a fresh and an existing DB, with the revert round-trip, in step 2. Re-verified after M3's reorder (`1d9a0d0`).

### In flight / next step (2026-10-03, after step 9)
- **Done:** steps 1–9. No push yet.
- **Next:** step 10, code review round 1 by ethio-reviewer (base `origin/main` = `ebc1eba`). After APPROVED, ethio-planner merges 6c (USER-ACTIONS item 6, the read-only pre-checks, is done).
- **Stack:** served from this tree on `el_e2e`. ethio-planner needs one more short window for its Task 11 gate.
- **SDD workspace:** `.superpowers/sdd/plan-2026-10-02-money-integrity/`.
  - `progress.md` is the ledger, with every ruling from P1 to R7 and the triaged deferred minors.
  - `final-review-report.md` and `final-fix-report.md`.
  - Delete the workspace after the code review is APPROVED.
- **Runners:** in scratchpad `/tmp/claude-1000/-home-kal-Documents-code-ethi0-learning-platform/74a75a51-886f-43fa-98db-aebd9fe9f3c8/scratchpad/`:
  - `full-gate.sh`, `gate.sh`, `e2e-up.sh`, `e2e-run.sh`, `e2e-env.sh`, `images.sh`;
  - `e2e-up-wt.sh` (`WT=<worktree>` brings the stack up from another worktree).
- **Environment:** `export PATH="/home/kal/.local/opt/node22/bin:$PATH"`. Stage explicit paths, with `git add -f` for this plan folder. Production is off-limits.
