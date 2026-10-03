# Handoff: Phase 6c, money integrity II

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 2; amendment A approved in round 3; drift check folded in; see [plan-review.md](plan-review.md))
Code review goes to: ethio-reviewer (size L)

## What to build
- **Pending rewards:** a purchase's cashback and referral reward are recorded as pending and become spendable 7 days + 1 hour after confirmation, on the first wallet read or spend after that. There is no cron. An approved refund voids them. This is the user's policy decision.
- **Refund window:** 7 days from the payment's confirmation, not from `enrolled_at`.
- **Refunds and payouts:** a refund the rules accept (pending or approved) marks the payment. The payout claim skips marked payments, and a request on a paid-out payment is sent to support.
- **Bank transfers:** the bank's reference is the idempotency key. A course the learner already paid for, or otherwise owns, is a 409, and the checks fail closed.
- **Wallet UI:** the dashboard shows pending and voided credits. The admin form gets the bank reference field.
- **Amendment A:**
  - A1: the abandoned-checkout reminder claims the row with a conditional update and never saves it;
  - A2: the sweep also re-verifies failed Chapa rows that have a checkout URL. A superseded row that Chapa says is paid is confirmed, as the webhook does. `reconcile` is 6a's (R15), not this phase's;
  - A3: a refused gift or pay-request checkout undoes its sponsorship side.

## Read first, in order
1. `plan.md` decisions 1–12, the migrations section and the API contract, then `plan-review.md`:
   - round 1 B1: why `DENIED` must never mark the payment;
   - S1: why the release is keyed on the payment row, and why decision, flip and void share one transaction;
   - S2: why `confirmedAt` is passed in rather than read from `payment`;
   - round 3 S1: why a superseded Chapa row that verifies as paid **is** confirmed (no guard against it);
   - the drift check: D1 (why step 8's refund-vs-payout check runs in sequence) and D2 (the Phase 4 specs that break by design, listed under steps 3–6).
2. `api/services/financial/src/growth.service.ts`: `wallet()`, `creditWith`, `debitWith`, `creditCashback`, `rewardReferrer`, the admin stats.
3. `refund.service.ts`, all of it: `request` (the rule engine), `decide`, `finalizeApproval`.
4. `payout.service.ts`: `payPayee` (the refund lookup and the claim).
5. `payment.service.ts`: `confirmPayment` (where `now` comes from and the savepoints), `recordBankTransfer`, `ownsCourse`, `sweepPendingPayments`, `nudgeAbandonedCheckouts`, `reconcile` (6a's R15 version). Also `sponsorship.service.ts`: `createGift`, `payRequest` (A3).
6. `entities.ts` (wallet, wallet transactions, payments) and `migrations/index.ts`.
7. `testing/fake-db.ts`: its exact-regex raw-SQL matcher. Every new SQL string needs a rule.
8. Web:
   - `(learn)/dashboard/page.tsx` (`WalletCard`);
   - `(admin)/admin/page.tsx` (`BankTransferForm`);
   - `(admin)/admin/growth-tabs.tsx`;
   - `notification.service.ts` (`WalletCredited`).

Read every file on the `fix/security-platform` tip. The plan's line numbers are from Phase 4 and will have moved.

## Decisions already made (don't relitigate)
- **Wallet:** `wallets.balance_etb` stays the spendable balance, and the overspend guard stays its conditional UPDATE. Pending is a `state` on the transaction row (`available | pending | void`), with `available_at` and `payment_id`.
- **Release:** a conditional `pending → available` UPDATE, with `NOT EXISTS` on the payment row (`refund_requested_at IS NOT NULL OR status <> 'confirmed'`). It runs in `GET /wallet` (now transactional) and inside `debitWith`.
- **Refund request:**
  - The rules run first.
  - `DENIED` doesn't touch `payments`.
  - `PENDING`/`APPROVED` mark the payment with a conditional UPDATE, in one transaction with the insert. 0 rows → the paid-out 400, or `ALREADY_OPEN`.
- **Approval** (auto and admin) is one transaction: the refund status, the flip `confirmed → refunded` with `payout_id IS NULL`, then the void. `RefundApproved` goes out after commit.
- **Admin denial** is one transaction: `pending → denied` plus clearing the mark.
- **Claim:** `AND refund_requested_at IS NULL`; the pre-transaction refund lookup goes.
- **Bank transfer checks, in order:**
  1. an existing `bank-<REF>` row (exact replay → 200 with it; mismatch → 409);
  2. a `confirmed` course payment in the financial DB → 409;
  3. the learner exists (404/503);
  4. entitlements (409/503);
  5. insert, with 23505 → re-read.
- **New internal calls** use 6a's `internalPath`.

## Gotchas learned while planning
- **`available_at`:** compute it from `confirmPayment`'s `now`. The in-memory `payment.webhook_received_at` is set only after commit; inside the transaction it is `null`, or the failure time for a payment that failed first.
- **Referral rewards:** `reference` is the referral id, not the payment id. That's why `payment_id` is its own column. Don't re-arm the referral on void (non-goal).
- **`WalletCredited`:** it's announced at confirmation, so for a pending credit the notification must say when it becomes available, not "spend it on any course".
- **`db:check`:** the entity decorators (column defaults, the CHECK, the indexes) must match the migration DDL. It doesn't compare partial-index `WHERE` predicates, so check both in `pg_indexes` by hand, and name the `state` CHECK (`@Check('CHK_wallet_transactions_state', …)`), because an unnamed CHECK drifts (drift D4).
- **Public repo:**
  - This plan folder is in `.git/info/exclude` (done 2026-10-03). Commit it on your branch with `git add -f docs/plans/2026-10-02-money-integrity/`. Stage paths explicitly; several plan folders are untracked.
  - Push only when the user can merge and deploy the same day.
  - Describe the class of issue in commit messages, not the exploit.
- **Rollout SQL:** DEPLOYMENT.md gets the read-only checks and the pre-rollback "release all pending" SQL. Production is off-limits; the user runs both.
- **Environment:**
  - the node PATH export and pnpm `--store-dir`;
  - Postgres on 55432;
  - e2e on `.env.example` values only.

## How to run
- `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`
- `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`
- Every e2e script, including the extended `scripts/e2e-payments.mjs` (step 8).
- Migrations: apply on a fresh and an existing local DB, and check that `migration:revert` round-trips.
- Mutation checks, logged in Progress:
  - remove the claim's `refund_requested_at` predicate;
  - remove the release's `state` condition.

  The e2e must fail each time.

## Branch
Create `fix/money-integrity` from the `fix/security-platform` tip (stacked on 6a). The code-review base is `fix/security-platform`; tell ethio-reviewer. No push or PR until 6a has merged; then `git merge origin/main` once, and the review base becomes `origin/main`. Security phases stay unpushed until they can merge and deploy the same day.
