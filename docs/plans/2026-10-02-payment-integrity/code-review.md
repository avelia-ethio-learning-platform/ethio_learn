# Code review: Phase 4, payment integrity

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: branch `fix/payment-integrity` (9 commits, `b99f802`), base `fix/access-control` (`fcbb94a`). Checked against the approved plan (round 3) and the logged deviations.

Checks run (read-only: the working tree and the running stack were untouched):
- `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`:
  - 12/12 built;
  - 43 suites / 831 tests pass;
  - typecheck clean;
  - no drift on the dev DB.
- On a throwaway database (`review_oc_tmp`, dropped afterwards), I checked the partial unique index `(kind, reference) WHERE kind IN (…)` with the exact `INSERT … ON CONFLICT DO NOTHING RETURNING id` that `creditWith` and `debitWith` use:
  - a second `topup` with the same reference inserts 0 rows;
  - `admin_adjust` with the same reference inserts twice, as intended.
- **Not rerun: the e2e scripts.** They need the dev stack's ports, and the dev stack runs on real SMTP and Chapa credentials. I rely on the implementer's run on `el_e2e` with `.env.example` values; CI runs `e2e-payments.mjs` on the PR.

### Against the plan
Decisions 1–10 are implemented as written:
- **Confirmation (decision 1):** a conditional `UPDATE … WHERE status IN ('pending','failed')` decides the winner.
  - In the same transaction: the wallet debit and the top-up credit.
  - One savepoint per secondary effect (a logged deviation, and a better one).
  - After commit, winner only: `WalletCredited` and the access events.
- **Purpose handlers (decision 2 and plan-review round 2 B1):** sponsorship and bulk handlers change state conditionally. The event they publish follows the row's current status, so `pending_claim` gets `SponsorshipInvited` and nothing ever publishes a grant with a null recipient.
- **Wallet ledger (decision 4):** writes use `ON CONFLICT DO NOTHING` with no conflict target, which correctly covers the partial index without poisoning the transaction. `m.query` results are destructured correctly: rows for INSERT, `[rows, count]` for UPDATE.
- **Broker confirms (decision 5):** `publishConfirmed` handles `error` and `close` on its own channel, and the connection close handler resets it. A late delivery after a timeout is the accepted duplicate-receipt risk.
- **Re-publish cron (decision 6):** has the running flag, stops on `BrokerPublishError` only, and skips rows that fail for their own reason.
- **Webhook signature (decision 7):** checks `x-chapa-signature` only, with the 64-hex check, `timingSafeEqual` on equal-length buffers, and an empty secret rejecting everything. Accepting the re-serialized-JSON HMAC is not exploitable: it still needs the secret.
- **Payouts (decisions 8–9):**
  - an advisory lock inside the transaction;
  - the `payout_id IS NULL` claim as the guarantee;
  - the gross amount computed from the claimed rows only;
  - disburse and release conditional on status.
- **Refunds (decision 5a):** conditional updates, and 23505 maps to 400.
- **Production rules (decision 10):** checked through the new `rules` hook. They name variables, never values, and no literal webhook-secret fallback is left.

Two more checks:
- **Migrations:** both match the plan, including the `to_regclass` guard, the NOT EXISTS backfill, the drop-if-exists-first `CONCURRENTLY` builds and `down()`.
- **Tests:** they cover each race and guard the plan lists. The mutation checks logged in the plan (removing the confirm guard, the claim guard, the lock, the disburse guard) back that up.

### Blockers
- **B1. Disbursing leftover `scheduled` payouts pays large payouts that never cleared KYC.** At `payout.service.ts:93-95` (new) together with the existing `FraudFlagResolved` handler at `payout.service.ts:57-68`.
  - How it happens: a payee with an open fraud flag gets `HELD`/`fraud_flag_open` (`:158-160`), even above the KYC threshold, because the KYC branch is the `else`. When the flag is resolved, the handler moves **every** `HELD` payout of the payee to `SCHEDULED`, `kyc_required` ones included.
  - Before this branch, nothing disbursed a `SCHEDULED` payout after creation, so these were stuck: a bug, but no money moved. Now the next run's leftover step disburses them.
  - Scenario: an educator earns 15,000 ETB, net above `KYC_PAYOUT_THRESHOLD_ETB` (10,000), while a fraud flag is open. The payout is held for fraud. An admin resolves the flag. At 02:00 the payout is marked `PAID` and `PayoutCompleted` tells the educator they were paid, without the KYC release that `release()` is meant to gate (`:182`).
  - The same happens to any `kyc_required` payout of a payee who has a fraud flag resolved.
  - Suggested fix: the handler releases only `hold_reason = 'fraud_flag_open'` payouts, and re-applies the KYC rule when it does. Two conditional UPDATEs scoped to the payee:
    1. set `hold_reason = 'kyc_required'`, still `HELD`, where `status = 'held' AND hold_reason = 'fraud_flag_open' AND net_amount_etb > threshold`;
    2. set `SCHEDULED` with `hold_reason = NULL` for the remaining `fraud_flag_open` rows.
  - Tests needed:
    - a fraud-held payout above the threshold stays held (`kyc_required`) after `FraudFlagResolved`, and a run doesn't pay it;
    - a `kyc_required` payout is untouched by `FraudFlagResolved`;
    - a fraud-held payout under the threshold is paid by the next run, once.
  - Rollout: add to step 1, read-only before merge:

    ```sql
    SELECT id, payee_id, net_amount_etb, hold_reason, created_at
    FROM financial.payouts
    WHERE status = 'scheduled';
    ```

    The first run after deploy will disburse every row it returns, so the user should review them first.
  Response: **fixed.** `FraudFlagResolved` (once the payee has no open flag) now calls `releaseFraudHolds`: it touches only payouts held for fraud (`fraud_flag_open` from a run, or `fraud:<signal>` from a flag raised after scheduling). A payout whose net amount is above the KYC threshold stays `HELD` as `kyc_required`; the rest go to `SCHEDULED`. Each update is conditional on the status and reason it read, so a concurrent admin `release()` wins. `kyc_required` payouts are never touched. Four tests in `payout.service.spec.ts`: your three plus a `fraud:<signal>` hold above the threshold. Mutation check: putting the old "schedule every held payout" back fails 3 of the 4 (the under-threshold case passes either way, as it should). The scheduled-payouts query is added to rollout step 1.

### Should-fix
- **S1. `e2e-payments.mjs` doesn't race reconcile against the webhook, though its header, the step 10 tick and the progress note say it does.** At `scripts/e2e-payments.mjs:3-6,147-149`.
  - `reconcile` only verifies in live mode (`payment.service.ts:309`), so in mock mode the four reconcile racers return the current view and never reach `confirmPayment`.
  - On real Postgres the script proves webhook against webhook, which exercises the same conditional UPDATE. Cross-path races (webhook against reconcile, sweep or settlement) have unit coverage only, with the fake DB.
  - That's adequate, because every path goes through the one `confirmPayment`. But the claim should match what runs.
  - Suggested: say so in the script header and in the plan's deviations, and drop the reconcile racers or rename the check. I don't need a new cross-path e2e; mock mode can't produce one on a single row.
  Response: **fixed.** The top-up race is now 8 concurrent mock webhooks, followed by one reconcile call that must report `confirmed`. The script header says the race is webhook against webhook on a mock stack, and that cross-path races are unit-tested. Plan step 10 and the deviations say the same.

### Nits (optional)
- **N1. Reconcile and the sweep only look at `PENDING`** (`payment.service.ts:309`, sweep query). So decision 1's "failed → confirmed" is reachable through a webhook only. This matters only if Chapa lets a learner pay on a `tx_ref` that verify has already reported as failed or cancelled, which is unverified. If it does, and the webhook is lost or rejected (the signed-bytes question), that learner stays unconfirmed.
  - Letting `reconcile` (user-initiated, so cheap) accept `status IN ('pending','failed')` would close it. Leave the sweep as is, or defer with a reason.
- **N2. The cron's `order: { webhook_received_at: 'ASC' }` sorts NULLs last** in Postgres, so legacy victims with no confirmation time wait behind every other row. `ORDER BY COALESCE(webhook_received_at, created_at)` would fix it. Harmless at today's volumes.

Nit responses:
- N1: deferred. It rests on unverified Chapa behaviour (paying on a `tx_ref` that verify already reported failed), and it would add a Chapa verify call for every reconcile on a terminal row. Worth revisiting with sandbox evidence in Phase 9.
- N2: deferred. At most 50 rows per tick and very few victims; ordering by `COALESCE` means swapping `find` for a query builder in the cron. Folded into the Phase 9 notes.

### Out of scope (not findings)
The security pass also found pre-existing money gaps that this phase doesn't touch and its non-goals exclude. They are not described here because the repo is public. I've sent them to ethio-planner for the local audit backlog.

## Round 2 (2026-10-02) · Verdict: APPROVED
Reviewed: `fix/payment-integrity` @ `39cf472` (round 1 fixes `0808f10` B1, `11cc031` S1, `39cf472` responses), base `fix/access-control` (`fcbb94a`). Only the changes since `b99f802`.

Checks run (read-only): `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`:
- 12/12 built;
- 43 suites / 835 tests pass, the 4 new ones included;
- typecheck clean;
- no drift.

The e2e wasn't rerun, for the same reason as round 1. I rely on the implementer's fresh `el_e2e` run (20 checks), and CI runs it on the PR.

- **B1: resolved.**
  - `releaseFraudHolds` (`payout.service.ts:179-195`) touches only fraud holds: `fraud_flag_open` from a run, and `fraud:<signal>` from the existing `FraudFlagRaised` handler (`:55`).
  - It re-applies the KYC threshold on the payout's net amount, and never touches `kyc_required` payouts.
  - Each update is conditional on the status and reason it read, so a concurrent admin `release()` can't be overwritten.
  - The four tests cover the three cases I asked for plus the `fraud:<signal>` hold. The under-threshold test runs two concurrent payout runs and expects one `PayoutCompleted`.
  - Rollout step 1 now lists `scheduled` payouts for review before merge, and says why.
- **S1: resolved.** The top-up race is 8 concurrent webhooks, then one reconcile that must report `confirmed`. The header, plan step 10 and the deviations describe exactly that.
- **N1 and N2: deferred to Phase 9** with reasons. I accept both.

No open blockers or should-fix items. For the user before push: rollout step 1 (read-only production checks, now including the scheduled-payouts list) and the same-day merge-and-deploy rule. This branch also waits on Phase 2 (#19) and Phase 3, then rebases onto main.
