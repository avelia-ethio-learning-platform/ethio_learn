# Handoff: Phase 4, payment integrity

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 3, see [plan-review.md](plan-review.md))
Code review goes to: ethio-reviewer (size L)

## What to build
Every money path in the financial service becomes exactly-once:
- one guarded `confirmPayment` path, with failing guarded the same way;
- wallet credits made idempotent by the database;
- a lost access-granting event re-published by a cron until the broker acknowledges it;
- the webhook authenticated by `x-chapa-signature` only;
- payouts claimed per payee in one transaction, and disbursed once;
- refunds decided once;
- the mock checkout path closed in production.

## Read first, in order
1. `plan.md` decisions 1–10, the migrations section and the test plan. In `plan-review.md`:
   - round 1 S1 explains why the secondary effects run in a savepoint (a cashback bug must never block access);
   - round 2 B1 explains why the required event follows the sponsorship's current status (no re-sent invitations, no grant with a null recipient);
   - round 2 S6 and S7 cover the fresh-DB backfill guard and the poisoned row.
2. `api/services/financial/src/payment.service.ts`:
   - `:182-212` `settleInstantly`;
   - `:261-332` webhook, reconcile and the current sweep (`@Cron('*/2 * * * *')` at `:311`);
   - `:382-443` `applyVerification` and `onConfirmed`;
   - `:457-487` `mockComplete` and `recordBankTransfer`;
   - `:626-649` `verifyHmac` and `emitConfirmed`.
3. `growth.service.ts:136-139,177-209,300-344` (coupon increment, credit/debit, referral claim and reward) and `sponsorship.service.ts:47-49,356-391`.
4. `refund.service.ts:35-36,108,131-139` and `payout.service.ts:65-151,189-243`.
5. `api/packages/common/src/events/event-bus.service.ts`: the publish path and where the channel is created (`:115`); `publishConfirmed` goes next to it.
6. `entities.ts:248-273,408-411` (wallet_transactions, referrals) and the Phase 2 financial migrations folder for the pattern.
7. `api/services/course/src/course.service.spec.ts:20-133`: the memRepo (`In`, `update → {affected}`), transaction and bus fakes to reuse.

## Decisions already made (don't relitigate)
- **Confirmation:** a conditional `UPDATE … WHERE status IN ('pending','failed')`, where `affected === 1` decides the winner. No new "source" column; the source goes in the log line. failed → confirmed is allowed because `verify()` is authoritative.
- **What runs where:**
  - in the main transaction: wallet debit and top-up credit;
  - in a nested savepoint that may roll back alone: coupon, cashback and referral;
  - after commit, winner only: the access-granting events and `WalletCredited`.
- **Wallet credits:** `INSERT … ON CONFLICT DO NOTHING RETURNING id`, not catching 23505, which would poison the surrounding transaction. `admin_adjust` stays non-unique.
- **`effects_completed_at` on payments, set only after the broker acknowledged every required event.** Top-ups are marked at confirmation. The required event follows the purpose row's status:
  - course → `PaymentConfirmed`;
  - sponsorship `granted` → `SponsorshipGranted`;
  - sponsorship `pending_claim` → `SponsorshipInvited` once, then done;
  - bulk `active` → `BulkPurchaseActivated`.
- **`completePendingEffects` cron:** every 2 minutes in every `CHAPA_MODE`, 50 rows, rows confirmed more than 60 s ago, oldest first. An in-process `running` flag skips overlapping ticks. It stops at the first broker failure and skips a row that fails for its own reason.
- **Webhook signature:** `x-chapa-signature` only. Accept the HMAC of the raw body or of re-serialized JSON. Ignore `chapa-signature`, which is a replayable constant.
- **Payout claim:** a transaction-scoped `pg_try_advisory_xact_lock`, because the Neon URL is pooled. The claim UPDATE with `payout_id IS NULL` is the real guarantee. Disburse with `WHERE status='scheduled'`, release with `WHERE status='held'`.
- **Production rules** go through Phase 3's `assertProductionConfig`. `mockComplete` returns 403 under `NODE_ENV=production`, whatever the mode.
- **Out of scope** (later phases): the general outbox, consumer dedupe and AMQP reconnect (Phase 9), coupon reservation (Phase 6) and the external cron scheduler (Phase 11).

## Gotchas learned while planning
- **`manager.query` with `UPDATE … RETURNING`:** TypeORM's Postgres runner returns `[rows, rowCount]` for UPDATE and DELETE, not just `rows`. Prefer the QueryBuilder (`.update().set().where().returning([...]).execute()` → `affected` and `raw`). If you use `query()`, destructure accordingly and cover it in a test.
- **Nested `manager.transaction`** inside a transaction is a `SAVEPOINT` in TypeORM 0.3 on Postgres. That is what decision 1 relies on. Add a test proving that a throwing cashback leaves the confirmation committed.
- **Confirm channel:** open it lazily with `connection.createConfirmChannel()`, then `publish` and `waitForConfirms()` raced against 5 s. Null it in the existing connection close handler so the next call reopens it. Leave the existing `publish()` and its channel alone.
- **Two crons are now 2-minute:** the existing live-mode sweep at `payment.service.ts:311` stays as is. `completePendingEffects` is a separate method that also runs in mock mode, so CI exercises it.
- **Migration 1's backfill** is the one deliberate cross-schema read (`enrollment.enrollments`), guarded by `to_regclass`. CI starts services in parallel, so financial can migrate before enrollment exists. Test that order on a fresh throwaway DB.
- **Migration 2** follows the Phase 2 CONCURRENTLY rules: `transaction = false`, `DROP INDEX CONCURRENTLY IF EXISTS` first, one statement per `query()`. Revert with `-t none`. `db:check` doesn't compare partial-index `WHERE` predicates, so check the four predicates in `pg_indexes`.
- **Secrets in docs and scripts:** the secret-guard hook scans every untracked file for `api/.env` values. Concretely:
  - the `.env.example` webhook-secret default belongs only in the denylist in code (`production-config.ts` from Phase 3);
  - in `e2e-payments.mjs`, backdate rows through the container's own env (`docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c …'`), never with the user or password written out;
  - tests use obviously fake secrets.
- **Public repo:** this plan folder describes unfixed money bugs. It is in `.git/info/exclude` until your branch exists. When you create `fix/payment-integrity`, remove that line and commit the folder on the branch. Push only when the user can merge and deploy the same day (rollout step 2).
- **CI e2e order:** add `node scripts/e2e-payments.mjs` before the smoke step, which exhausts the login rate limit. Phase 5 will later slot Playwright in before smoke too, so keep smoke last.
- **Environment:** the same notes as Phase 2's handoff apply:
  - the node PATH export and pnpm `--store-dir`;
  - Postgres on 55432;
  - after rebuilding, restart with `scripts/stop-backend.sh && scripts/start-backend.sh`;
  - no `pkill -f` patterns that match your own shell.
- **Production is off-limits.** Rollout step 1 is for the user: the duplicate checks for the three unique indexes, the list of past P0-05 victims, and the Render checks of `CHAPA_WEBHOOK_SECRET` length and the live key.

## How to run
- Build and test: `pnpm -C api build && pnpm -C api test && pnpm -C api db:check`
- Migrations: apply them on a fresh throwaway DB with financial migrating before enrollment, then on the existing local DB. `migration:revert -t none` must round-trip.
- E2E: `node scripts/e2e-payments.mjs` (new, mock mode), plus `demo-seed.mjs`, `e2e-revisions.mjs`, `e2e-institution.mjs` (Phase 3) and `e2e-smoke.mjs` last.
- Images: both docker builds (the CI `docker` matrix for `@ethiopialearn/financial-service`, at least).

## Branch
Create `fix/payment-integrity` from `origin/main` if Phase 3 has merged; otherwise create it from `fix/access-control` and rebase later. Tell ethio-reviewer which base to diff against.

## Definition of done
- The acceptance criteria are met, including the step 10 race script: one credit and one receipt under concurrent `mockComplete` and `reconcile`, and at least one payout from two concurrent runs, with no payment in two payouts.
- The api build, tests and `db:check` pass, every e2e script passes, and the images build.
- The plan checklist is ticked, with deviations logged.
- Then request code review from ethio-reviewer.
