# Phase 6c: code review (ethio-reviewer)

## Reviewer state (2026-10-03) · Round 1 APPROVED at `935a889`; sent to ethio-impl and ethio-planner. Nothing left for this session unless a fix lands before merge (then review only `935a889..<new head>`).
- **Since checkpoint 2:** the spec pre-read is done (below). The review worktree's web deps were reinstalled. The precheck (item 6) is done. The branch has moved past `c08be3a` to `c08d1db` ("steps 8 and final review done, checkpoint 2", with DEPLOYMENT.md edits `c7c8962` and `abb9beb`), but impl hasn't asked for Round 1 yet. Wait for its message, then start at step 1 below with `git log c08be3a..<head>`.
- **Notification rule (user, 2026-10-03):** push only for a needed user action, a choice, or something crucial, never for a finished round. The desktop hook handles "all finished" itself. See memory `notifications-only-when-needed`.
- **6a is closed.** PR #24 merged as `c82d091`. Production is verified: `verify 6a` PASS, the P1-01 probe returns 400. See `../2026-10-02-security-hardening/code-review.md`.
- **Next: 6c Round 1, when ethio-impl asks** (after its step 9 gate). Start from the two pre-reads below:
  1. `git log c08d1db..fix/money-integrity` (pre-read 3 covers everything up to `c08d1db`) and review only what changed since then;
  2. skim the specs;
  3. run the gate in the review worktree (`pnpm -C api build && test && typecheck && db:check`, and `pnpm -C web typecheck && test && build`);
  4. append Round 1 with the verdict, then message ethio-impl.

  The base is `origin/main` = `ebc1eba`, which impl merged as `c2798c7`.
- **Review worktree:** `../ethi0-review-6a` (detached at `c08be3a`; run `pnpm install --store-dir` there before the gate if `node_modules` is stale). Reuse it with `git -C ../ethi0-review-6a checkout --detach <sha>`. Never touch the shared tree, which is impl's, on `fix/money-integrity`. Scratch DBs go in the compose Postgres (host port 55432) as `el_verify_*`, created from `docker/postgres-init.sql` and dropped after.
- **Merge, after APPROVED:**
  - green CI (`secret-scan`, `api`, `web`, `e2e` with `e2e-security`), then `gh pr merge <N> --merge --match-head-commit <sha>`;
  - USER-ACTIONS item 6 (the user's read-only SQL from `DEPLOYMENT.md`'s Phase 6c section) is **done**: all five checks came back empty (ethio-planner, 2026-10-03; report `~/ethio-ops/report-6c-precheck-20261003-140930.txt`);
  - **ethio-planner merges 6c** (its message, 2026-10-03), as it did 6a. On APPROVED, message both ethio-impl and ethio-planner.
- **Base:** 7a merged as PR #25 (`ebc1eba`, web only), and impl has merged it in (`c2798c7`), so the base is `ebc1eba`.

## Pre-read (2026-10-03, before any request) · steps 2–6 at `01d538a`
Read `origin/main...01d538a`: migrations, entities, `growth.service.ts`, `refund.service.ts`, `payout.service.ts`, bank transfer (`payment.service.ts`, `controllers.ts`), `fake-db.ts`, the admin form. No blocker found so far. Checked and fine:
- **Release:** the conditional `pending → available` is once-only under the row lock. The `NOT EXISTS` is keyed on the payment row. `debitWith` releases after its own insert and before the overspend UPDATE.
- **Refunds:**
  - the rules run first, and `DENIED` writes only the request row;
  - accepted requests mark the payment, file the row and (auto) flip and void in one transaction;
  - admin approval rolls back on a paid-out payment, and admin denial clears the mark in the same transaction;
  - `finalizeApproval` emits only when the flip happened (`voided !== null`).
- **Window:** it runs from `COALESCE(webhook_received_at, created_at)`, and only an `active` entitlement is judged (`a3da407`). The enrollment service's `entitlement()` returns `entitlement_status`. This is a deviation to confirm is logged in Progress.
- **Payout:** the candidate query and the claim both filter `refund_requested_at IS NULL`, and the `RefundRequest` repo is gone from `PayoutService`.
- **Bank transfer:** checks 1–5 run in the plan's order. The global `ValidationPipe` has `transform: true`, so the `@Transform` upper-casing reaches the service. `chapa_tx_ref` is the only unique index on `payments`, so a 23505 re-read can't come from elsewhere.
- **Migrations:** the named CHECK, both partial indexes created `CONCURRENTLY`, and the backfill only from `pending` requests.

**Complexity check** (the user's standing rule, relayed by ethio-plan-review on 2026-10-03: raise unneeded abstractions, config, env vars, tables, jobs or helpers as should-fix, naming the simpler option). Steps 2–6 add none: no env var, table or job. The small helpers (`addToBalance`, `heldFor`, `unmarkable`, `replayBankTransfer`/`settleBankTransfer`, fake-db `updateWhere`) each serve a plan step and replace duplicated code. Apply the same check to steps 7–8.

**Pre-read 2, at `c08be3a` (steps 7–8, after impl merged `origin/main` as `c2798c7`; base `ebc1eba`).** No blocker so far.
- **Step 7:**
  - `pending_etb` is a sum over every pending row;
  - `available_at` appears only on pending `WalletCredited` events;
  - the notification copy no longer says "spend it";
  - `WalletCard` is moved out of the page file for vitest;
  - "Pending rewards" is a separate admin tile rather than part of the liability card, which is simpler and fine.
- **A1:**
  - `ownsCourse` runs, then the conditional claim, then `learnerInfo`;
  - a reminder is published only when the claim affected 1 row;
  - the owned branch claims and publishes nothing.
- **A2:** a second `find` (failed, Chapa, with a `chapa_tx_ref` and a checkout URL, 24 h window, newest first, 10 rows) after the pending one, and no superseded guard. All of this is per the plan.
- **A3:**
  - `checkoutOrUndo` has 3 callers, so it isn't over-engineering;
  - the undos are conditional on `pending_payment`, and the pay-request undo also on this sponsor and `payment_id IS NULL`;
  - I checked that `createSession` can't throw after a successful instant settlement: `confirmPayment` catches `completeEffects` failures and `announceCredits` catches publish failures. So the undo never deletes a paid gift.
- **e2e:** pending → void on an auto-refund; a backdated release by 2 concurrent reads raises the balance once; review vs payout in sequence; the bank transfer twice at once gives one 201, one 200 and one payment; a refused gift leaves the count unchanged.
- **DEPLOYMENT.md:**
  - checks 1–5 only select, and use only pre-6c columns (`referrals.rewarded_at` exists; the `enrollment` schema is in the same DB);
  - the rollback CTE (`pending → available`, then upsert into `wallets`) conflicts with the app's release only through `state = 'pending'`, so each credit moves once.
- **Deviations logged:** R1/R1a (the window applies only to an active entitlement), R2, R3, R4, R5 and P1. The deferred minors are in impl's SDD ledger.

**Spec pre-read (at `c08be3a`, via a read-only agent).** Every test bullet in steps 3–8 and 7b has a test. The fake-db rules for the release, mark, flip, void and claim evaluate their guarded predicates (`state`, `refund_requested_at`, `payout_id`, `status`), and `atomically` restores the store on a throw. No vacuous test was found. Candidate notes for Round 1:
- **Mutation checks not yet logged.** The e2e double-release check (`e2e-payments.mjs` ~:298) is timing-dependent, so confirm that Progress records the mutation runs: the release `state` condition and the claim `refund_requested_at`.
- **Nit:** A3's pay request is tested only on the Chapa refusal (`sponsorship.service.spec.ts` ~:237), not on a wallet refusal.
- **Nit:** the admin "Pending rewards" tile has no vitest. The plan doesn't ask for one.
- **Review worktree:** web deps were reinstalled for 7a's `@axe-core/playwright`.

**Pre-read 3, `c08be3a..c08d1db` (2026-10-03, after resume).** No blocker.
- `c63cbbf` bank transfer: the step 2 and step 4 conflicts re-run step 1 (`replayed()`) before answering 409, so a concurrent identical submit gets the replay. The 23505 path reuses it. Another learner's row under the same reference still gets the mismatch 409 from `replayBankTransfer`. There are two unit tests, one per interleaving.
- `1d9a0d0`: the migration now runs `payments` before `wallet_transactions`, matching the app's lock order, and the spec asserts the order.
- `4c09b86`: the admin refund decision shows a refusal through `alert()`, with a vitest. `f8fdce9`: a void credit is muted and struck through, with a vitest.
- `c7c8962` and `abb9beb` (DEPLOYMENT.md): check 5 now counts refunded purchases separately and stays select-only. The refund-mark check is read-only. The re-sync is a single transaction (clear the stale marks, then set the missing ones) and is scoped to `status = 'confirmed'`, so refunded payments keep their mark. Its "no admin deciding" caveat is stated.
- Complexity: nothing new (no env var, table, job or helper beyond the local `replayed` closure).

**Gate at `c08d1db` (review worktree, 2026-10-03):**
- api: build ok, typecheck ok.
- api jest: 1101/1101 on four clean runs. The first run, which overlapped impl's gate, had 2 failures I didn't capture; they look like timing flakes under load. If CI shows a failure, name the spec.
- db:check, on scratch `el_verify_6c` (init SQL, then every service's `migration:run`): no drift. The shared dev DB `ethiopialearn` is behind and shows drift; it isn't a valid target.
- Partial indexes in `pg_indexes`: `IDX_wallet_transactions_pending_user_id_available_at … WHERE state = 'pending'` and `IDX_wallet_transactions_payment_id … WHERE payment_id IS NOT NULL`.
- The financial `migration:revert` ×2 then `migration:run` round-trips, and db:check is still clean. The scratch DB was dropped.
- web: typecheck ok, vitest 482/482, build ok.

Still to do when asked: diff the final head against `c08d1db` and re-run the gate only if code changed.
- **User-facing rule (2026-10-03):**
  - Anything the user must do goes in the "Start here" section at the top of `docs/plans/USER-ACTIONS.md`, with a copy-paste command tested on a scratch copy.
  - Tell the user directly, and send a push if they're away.
  - The user's production commands: `bash ~/ethio-ops/prod-rollout.sh verify 6c` after the deploy. It now takes any phase from 5 on, against `../ethi0-verify-main`, which ethio-planner keeps at the deployed main.
  - Auto mode blocks this session from production (even a public curl), from editing `~/ethio-ops/*`, and from editing settings.

## Round 1 (2026-10-03) · Verdict: APPROVED
Head `935a889` (base `origin/main` = `ebc1eba`). `c08d1db..935a889` changes only `plan.md`, so the gate above (at `c08d1db`) holds for this head. This round rests on three pre-reads: pre-read 1 (steps 2–6), pre-read 2 (steps 7–8, A1–A3, DEPLOYMENT.md) and pre-read 3 (the fix wave), plus the spec pre-read.

**Gate:** see "Gate at `c08d1db`" above. api build, typecheck and jest 1101/1101; db:check no drift on a freshly migrated scratch DB; both partial indexes checked by hand; financial revert ×2 and re-run round-trips; web typecheck, vitest 482/482 and build. impl's e2e (payments 42 checks, security, demo-seed, revisions, institution, smoke), Playwright 75/75 and image builds were taken from its report, not re-run here.

**Mutation checks:** logged in Progress under step 8 (R6). Removing the release's `state` condition fails the double-release e2e. The claim predicate is pinned by the e2e when removed from both queries; the claim-only removal is pinned by the unit test and Task 4's real-Postgres race (40 runs). Accepted.

**Blockers:** none.

**Should-fix:** none for this branch. The ledger's deferred items are test-pinning, logging and cosmetic gaps. None of them has a concrete money or data failure that 6c introduces:
- *Two different references for one (learner, course) both confirm:* this is two real admin-entered transfers, both recorded. It's a backlog note.
- *`payRequest` whole-row save, and the A3 undo resetting a re-sponsored row:* the root predates 6c, and before 6c the grant named the wrong payer, which was equally wrong. It's already in impl's backlog for ethio-planner. **Planner: please schedule it** (the A1 bug class in `sponsorship.service.ts`).
- *M7, no index for A2's failed-row query:* fine at today's volume; Phase 11.

**Nits (optional):**
- N1: A3's pay-request undo is tested only on a Chapa refusal (`sponsorship.service.spec.ts` ~:237), not on a wallet refusal.
- N2: the web bank-transfer success alert says "recorded" on a 200 replay as well. "Already recorded" would tell the admin nothing new was created.
- N3: the admin "Pending rewards" tile has no vitest (the plan doesn't ask for one).

**Complexity check:** no new env var, table, job or config. The helpers each serve a plan step (see the pre-reads).

**Merge** (ethio-planner merges): green CI (`secret-scan`, `api`, `web`, `e2e` incl. `e2e-security`), then `gh pr merge <N> --merge --match-head-commit <sha>`. USER-ACTIONS item 6 (the read-only pre-merge checks) is done. After the deploy, the user runs `prod-rollout.sh verify 6c` and the DEPLOYMENT.md refund-mark check (both counts 0).

### Implementer response (ethio-impl, 2026-10-03)
- N1, N2, N3: deferred, to keep the approved head for a same-day merge. All three are in ethio-planner's backlog note (plan.md Progress, step 10).
