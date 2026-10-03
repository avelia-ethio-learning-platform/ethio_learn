# Code review: Phase 6a, security hardening I (platform)

## Early read (2026-10-03) · no verdict
Started early at ethio-planner's request (parallel work), on the committed steps only: `fix/web-p0...fix/security-platform`, 28 commits `931a9a1..ff56ebe` (steps 2, 3, 3a, 4, 5, 6). Steps 7–9 are still in progress and not reviewed. Round 1's verdict follows when impl asks for review; it covers steps 7–9 and rechecks these findings. Base becomes `origin/main` after impl's merge of Phase 5 (#22, `4b4a64c`).

Checks run in a separate detached worktree at `ff56ebe` (`../ethi0-review-6a`); the shared tree and the running stack were untouched:
- `pnpm -C api build`, `pnpm -C api typecheck`: clean.
- `pnpm -C api test`: 59 suites, 937 tests pass.
- `pnpm -C web typecheck`: clean. `pnpm -C web test`: 28 files, 369 tests pass.
- **Not run yet:** `db:check` and the migration round trip on my side (impl reports 0 drift on a fresh and a copied DB and a clean `-t none` revert), the e2e scripts, the image builds. I run them for Round 1.

### Against the plan (steps 2–6)
- **Internal paths (decisions 1–2):** the `InternalPath` brand makes `get()` refuse raw strings, so the compiler covers all call sites. I listed every interpolated value: all are ids, emails or the constant `institutions`/`educators` segment, with no pre-built query strings that encoding would break. No other code sends `x-internal-token`. `get()` checks the prefix, rejects `\` and `#`, and compares the WHATWG pathname; the spec covers `..`, `%2e%2e`, a bare `..` value and a prefix without the trailing slash. The rejection log has the reason and length only.
- **Route params (decision 3):** I checked all 112 `@Param`s. Each `UuidParam` is on a uuid column, including `multipart/:id` (our session id, not the S3 upload id), `messages/threads/:id`, `notification-preferences/:userId` and `me/certificates/:id`. The web callers send ids. The token, invite and certificate-uid pipes match their generators. The free-text pair (`users/by-email/:email`, `knowledge/:title`) is explicit in the per-service guard specs. Reading Nest's route-arg metadata is a good regression guard.
- **A1 (decision 15):** `PayRequestPublicController` has no guards and one route, and is registered after `GrowthController`, so no static route is shadowed. `GrowthController` keeps its class-level `RolesGuard` and `POST pay-requests/:token/pay`. The public shape is unchanged and has no payer email.
- **Password change (decisions 4–8):** the current-password rules, `has_password`, the reset clearing `must_change_password`, `PASSWORD_CHECK` in `auth-strict` (checked after `MUTATING`, case- and slash-normalized) and the shared `refresh-cookie.ts` are as planned. The specs check the order: update, then revoke, then issue. One gap, B1.
- **Email caps (decisions 9–10):** referral invites email only new rows and answer `{ invited }`. The per-recipient 7-day skip, the 24 h allowance filled in request order (R9), pay-request dedupe then caps (R10), the gift cap, and the institution cap plus the no-resend-within-24 h rule on every invite (R11) all match. Cap logs have the user id and path, no addresses. The `{ invited }` count still tells a single-address caller whether the address is new, but signup's 409 "Email already in use" already reveals that, so it isn't a new oracle.
- **Migrations (step 6):** additive and nullable. The `invited_at` backfill is one `UPDATE` on a small table. The indexes are `CONCURRENTLY` with `transaction = false`, drop-if-exists first. No unique index, so no duplicate check. The check constraint is declared with `@Check`, so there's no drift.

### Blockers
- **B1. A suspended or banned user can keep a working session indefinitely through `PUT /profiles/password`.** `changePassword` (`auth.service.ts:244-258`) now issues a fresh session through `startSession`, but never calls `assertActive`, unlike `login` (`:108`), Google sign-in (`:157`), `refresh` (`:202`) and the invite setup link (`:307`). The gateway checks only the JWT signature, never the user's status (`gateway/src/main.ts:50-58,209-220`).
  - Scenario: an admin suspends user X (`admin.controller.ts:61` revokes X's refresh tokens). X still holds an access token, valid for up to 15 minutes, and knows the password. X calls `PUT /profiles/password` with `{ current_password: A, new_password: B }` and gets a fresh 15-minute access token. Calling it again before each expiry, switching between A and B, keeps X signed in for as long as they like. The refresh token is useless to X, but the access tokens aren't. Before 6a this call returned only `{ message }`, so suspension took effect within one token lifetime, as `refresh`'s comment promises.
  - Fix: call `this.assertActive(user)` right after loading the user, before any check or update, so a suspended account can't change its password either. Add a spec: a suspended user gets 401, with no update, no revoke and no session.

### Should-fix
- **S1. `/teach/analytics` breaks for an owner with more than 25 courses.** The new `AnalyticsQuery` rejects 26 or more ids with a 400 (`analytics-query.dto.ts`). The page sends every id from `GET /courses` (`teach/analytics/page.tsx:15-19`), drafts and archived courses included, and the service used to cut the list to 25 silently (`enrollment.service.ts:304`). An institution with 26 courses now gets an error instead of the funnel. Fix: the page sends `ids.slice(0, 25)`, so the DTO cap stays strict.
- **S2. The password page can hide the field the server requires.** `hasPassword` starts false and stays false if `GET /profiles/me` fails, for example while the server is still waking up. The current-password field stays hidden, the server answers 400 "Current password is required.", and there's nothing to fill in until a reload. The same happens on a manually opened `?first=1`. impl's ledger already flags this for triage. Fix: when the 400 says the current password is required, set `hasPassword` to true, so the field appears with the message.
- **S3. A referral invite treats any lookup failure as "not an account"** (`growth.service.ts`, the `catch` after `users/by-email`). On the free tier, a sleeping auth service (hibernation 429) or a timeout makes every address look new, so existing users get a "join EthiopiaLearn" email and a referrals row. The 20-a-day and 7-day caps bound it, and the behaviour predates 6a. Phase 9c step 2 adds a typed `PeerNotFoundError`. **I suggest deferring it there:** narrow this `catch` to `PeerNotFoundError` and add the call site to 9c's list (the planner owns that edit). Fixing it now means matching the error text for "-> 404", which 9c then replaces.
  - **Deferred to 9c (planner, 2026-10-03).** 9c's decision 2: `GrowthService.invite` treats only `PeerNotFoundError` as "not an account"; any other error fails with 503 and writes no row and no event. 9c's step 3 (fail-closed lookups) carries it. No 6a change.

### Nits
- **N1.** `invite()` does up to 20 internal `by-email` lookups before it checks the daily allowance, so a caller already at the cap still costs 20 internal calls per request. Moving the `sentToday`/`remaining` check above the lookup loop costs nothing.

### Next (Round 1)
Steps 7–9: the coupon hold transaction, the per-user limit, the failure-path releases and the `PaymentFailed` reasons, `e2e-security.mjs`, and the gate. Plus B1, S1, S2 and S3's outcome, and the `origin/main` merge.

## Early read 2 (2026-10-03) · step 7 · no verdict
Step 7 as committed, `ff56ebe..a1fb767` (`f8800bc`, `9de4954`, `23d5bdc`, `a1fb767`). I read it before impl's own task review, so round 1 rechecks whatever that review changes. Steps 8–9 are not reviewed yet.

Checks, in the detached worktree at `a1fb767`: `pnpm -C api build` clean; `pnpm -C api test` 61 suites, 972 tests pass. The real lock behaviour (5 concurrent checkouts of a one-use coupon) is step 8's e2e. The fake DB can't prove it, so round 1 relies on that run.

### Against the plan (decisions 11–14)
- **The transaction (decision 11):** it locks the coupon (`pessimistic_write`), re-checks active and expiry with the same `couponUnavailable` the quote uses, handles the payer's same-purchase rows, counts `GREATEST(uses, confirmed)` plus holds, and inserts. All of it is DB work, with no HTTP while the lock is held; `generateTxRef` and the quote run before it, Chapa after. Under Postgres's default READ COMMITTED, each count after the lock wait sees the previous holder's committed insert, so the counts are right.
- **Same purchase only (round 2 B2):** `isSamePurchase` matches purpose first, then the course for `course`, or `meta.sponsorship_id` / `meta.bulk_purchase_id`, and `mine` is already filtered to this payer and this code. A different purchase is never reused or superseded. When the payer's own holds are what blocks them, the refusal names the hold that lapses soonest, and `checkout_url` is theirs only.
- **Supersede inside the transaction:** a later refusal rolls the supersede back, so the payer's old checkout stays open when the new one is refused. That's the right outcome. The hold count runs after the supersede, so the superseded row isn't counted twice.
- **The three decisions beyond the brief.** I checked each, and all three are sound:
  - *An instant settlement claims only a pending row, and the loser gets a 409.* Without this, a 100% or wallet checkout that a concurrent retry superseded would still settle, so the purchase would settle twice. The claim fails before the wallet debit, so the loser is never charged. Gateway sources still claim failed rows, so a superseded checkout that is paid late confirms through the webhook, as the plan requires.
  - *The confirmation locks the coupon first.* This is needed. Without it, a webhook confirmation locks the payment and then waits on the coupon for `uses + 1`, while a checkout holds the coupon and waits on that payment to supersede it, which deadlocks. Both paths now lock the coupon, then the payment. I checked the other writers: refund, fail, nudge and `completeEffects` are single-row updates that wait on no other lock, and deactivation is a single coupon update. So nothing closes a cycle. A row lock taken in a released savepoint stays held until the outer commit, so the savepoint wrapper keeps it.
  - *Every post-insert failure fails the row, coupon or not.* It goes beyond the plan, and it's an improvement. Before, a failed Chapa open left a `pending` CHAPA row. The sweep then verified it for 24 h, and the nudge sent a "finish your purchase" email for a checkout that never opened. A no-coupon wallet shortfall also left a `pending` row stored as `chapa`.
- **Reasons and notices:** `PaymentFailed` has one consumer, the notification service, so skipping the publish for `superseded`, `wallet_insufficient` and `checkout_open_failed` is the plan's first option. `error` and the gateway's reasons still notify. A 409 loser's fail is a guarded no-op, because the row is already failed, so it sends no notice either.
- **The URL write after Chapa:** `update({ chapa_checkout_url })` rather than `save()` keeps a concurrent supersede from being undone. That's correct, and it avoids the stale-row write that the nudge job has (P1-61, 6c).
- **Per-user limit (decision 12), 100% path (decision 13), the validate bucket (decision 14), the coupon-manager field:** as planned. The DTO and the web reject 0, negatives and fractions, and blank means unlimited.
- **Pre-existing finds:** impl's three (the reminder's lost update, the sweep and reconcile skipping failed rows, orphan sponsorship rows) went into 6c amendment A (P1-61, P1-62, P2-46), so they aren't 6a findings. One note for 6c: 6a creates the first failed rows that can still be paid, which are superseded checkouts. Until P1-62 lands, the return page's reconcile shows such a payment as failed until the webhook confirms it. That's confusing for the payer, but no money is lost, and the web only reaches it through a wallet retry, which is offered only with enough balance.

### Blockers
None in step 7.

### Should-fix
None in step 7.

### Nits
- **N2.** `failPayment` logs "marked failed via checkout (superseded)" inside the checkout transaction. When the checkout is then refused, the transaction rolls back, and the log describes a supersede that never happened. That's misleading in an incident. Logging the superseded ids after the transaction returns, or adding "(rolled back if refused)", fixes it.

### For Round 1 (planner, 2026-10-03)
impl's step 7 fix round 1 adds ruling R15. Check both parts:
- the checkout-URL write is guarded on `status = pending`, and 0 rows answers 409, which covers a retry superseding the row while Chapa was answering;
- `reconcile` also verifies a failed row that has a `chapa_checkout_url`, so a superseded checkout paid late isn't shown as failed. 6c's A2 now builds on this and keeps only the failed-row sweep.

## Round 1 (2026-10-03) · Verdict: CHANGES REQUESTED
Branch `fix/security-platform` at `e20c76c`, base `origin/main` `4b4a64c` (merged in as `8d3bccc`, a clean merge with no hand-resolved hunks). This round covers the whole 6a diff, 82 files outside `docs/`. Steps 2–6 and 7 were read in early reads 1 and 2; this round covers what changed since then, steps 8–9, and the deferred minors.

Checks, in my detached worktree at `e20c76c` (the shared tree and the :4000 stack untouched):
- `pnpm -C api build`, `pnpm -C api typecheck`: clean. `pnpm -C api test`: 61 suites, 997 tests pass.
- `pnpm -C web typecheck`: clean. `pnpm -C web test`: 30 files, 377 tests pass.
- **Migrations:** on my own scratch DB `el_verify_r6a`, made with `docker/postgres-init.sql`:
  - all 7 services' migrations applied, then `db-check` showed no drift;
  - reverting the four 6a migrations (financial ×2, auth ×2, `-t none`) removed both columns and all 7 indexes, with 0 invalid indexes;
  - re-running put them back, and `db-check` again showed no drift.
- **gitleaks v8.30.1 with the repo's `.gitleaks.toml`, over `4b4a64c..e20c76c`:** 3 findings, see B2.
- **Not rerun by me:** the e2e scripts (the :4000 stack is in ethio-planner's 7a Playwright window), the web build and the images. impl's step 9 gate reports all of them passing, and the PR's CI runs e2e and both builds again before merge.

### Against the plan
- **Early-read findings:** all resolved.
  - B1 `d76e28f`: `assertActive` runs right after the user loads, before any check. The spec covers suspended and banned accounts: no update, no revoke, no session.
  - S1 `0740870`: at most 25 ids, with a vitest.
  - S2 `4a3701f`: the server's "Current password is required." reveals the field, for both a failed `/profiles/me` and a manual `?first=1`.
  - N1 `412fc8f`: the cap is checked before the lookups.
  - N2 `e3f7234`: a supersede is logged after the commit, naming the payment that replaced it.
  - S3: deferred to 9c (R13).
- **R15 `c4d2c85`, the guarded URL write:**
  - `update({ id, status: pending }, { chapa_checkout_url })` with 0 rows answers 409, and the URL is never returned.
  - The fail that follows is a guarded no-op, because the row is already failed, so it sends no notice.
  - The only realistic cause of 0 rows is a same-purchase retry's supersede. A confirmation can't come first, because nobody has the URL yet.
- **R15, reconcile:**
  - A failed row is verified only when it has a `chapa_checkout_url`. So a wallet, 100% or never-opened row is never sent to Chapa.
  - With `success`, it confirms through the gateway path, which claims failed rows.
  - With `failed` or `pending`, `failPayment` is guarded on `pending`, so there is no state change and no second notice.
  - It stays scoped to the caller's own `tx_ref` (`learner_id: ctx.id`).
- **R18 `c17ade9`:**
  - The payer's own holds are read `FOR UPDATE` after the coupon lock. That is the same coupon-then-payment order a confirmation uses, and the URL write only locks its one row, so there is no cycle.
  - Under READ COMMITTED, the URL write either commits first, and the locked read sees the URL so the row is reused; or it waits, re-evaluates `status = pending` on the superseded row and matches 0 rows, so it answers 409.
  - Either way, a double-click leaves exactly one live checkout.
- **Step 8 (`e2e-security.mjs`):** every line of step 8 has a check:
  - the P1-01 probe;
  - password change: 400, 401, then 200 with a working fresh access token and refresh cookie, and session B's rotated cookie revoked, with a 200 refresh before the change proving the cookie worked;
  - referral invites: `invited: 0`, 20, then the 429, matched by the daily-limit message, not the per-minute limiter's;
  - coupons: 5 concurrent 100% checkouts by 5 different learners give exactly 1 success and 4 "fully used", with one confirmed row and `uses = 1` in the DB;
  - abandon and retry gives the same payment, `tx_ref` and URL, and the other learner is refused;
  - every A1 case.

  `sql()` passes the DB name as a positional argument, not through the shell. It reads only `SEED_PASSWORD` and the DB name from the env file and prints neither. CI runs it after `e2e-payments` and before the web build (`ebc9e61`).
- **Scope:** no unplanned files. `payout.service.ts`, `refund.service.ts` and the other service files outside the plan's list are `internalPath` and `UuidParam` call-site edits. Commit messages describe the classes of issue, with no probe strings, and have no attribution trailers.

### Blockers
- **B2. CI's `secret-scan` job will fail on the 6a PR, which blocks the merge.**
  - **Scenario:** CI runs gitleaks over the full history with `.gitleaks.toml`. I ran the same image and version with that config over this branch's range. It reports 3 `generic-api-key` findings, all made-up test values:
    - `api/services/auth/src/auth.password.spec.ts:65`, the wrong current-password literal (commit `39ed343`);
    - `scripts/e2e-security.mjs:141`, the `TOKEN_ALPHABET` constant (`c76f5e6`);
    - `scripts/e2e-security.mjs`, the wrong current-password literal, at :164 now (:160 in `c76f5e6`).

    `main` passes today (PR #23's `secret-scan` was green), so these are new. Pushing 6a as it is means a red required check on a same-day security merge.
  - **Fix:** follow `9274e9f`'s precedent:
    1. Add the three exact values to `regexes` in `.gitleaks.toml`, each with a `# made-up …` comment. Use values, not a path entry, so a real key pasted into those files still fails, as the file's header asks.
    2. Changing the literals instead doesn't help, because the scan covers history.
    3. Verify with CI's command, from the repo root: `docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.30.1 git /repo --config /repo/.gitleaks.toml --redact --no-banner`. It must show 0 leaks.
  - **Fixed (impl, `b3db839`).** Two exact values in `regexes`, each with a `# made-up …` comment. `Wrong-passw0rd` covers both password literals, because the e2e one (`Wrong-passw0rd-x`) contains it. The other is the token alphabet. CI's command from the repo root reports 189 commits scanned and no leaks. With `HEAD~2`'s `.gitleaks.toml` mounted in place of the new one, the same scan reports 3 leaks, so the new entries are what clear them.

### Should-fix
None.

### Nits
- **N3.** The referral dashboard's "Sent 0 invitations." when every address was skipped (an existing user, or one invited within 7 days) reads like a failure. "No new invitations sent: these people already have an account or were invited recently." would say why. Optional; it's a ledger item.
  - **Taken (impl, `0c876de`).** `invited: 0` shows that sentence; any other count keeps "Sent n invitation(s).". The web typecheck is clean, and the tests pass (30 files, 377 tests).

### Deferred minors (triage)
None is a blocker or a should-fix; all can stay deferred. Notes on the ones worth a word:
- **`COUPON_HOLD_MINUTES` parsed per checkout:** this is the codebase's existing `envInt` pattern, also used by the email caps, and the variable is set nowhere (render.yaml, compose). Leave it.
- **The nudge reverting a supersede when the window is over 60 minutes:** covered by 6c A1 (P1-61). Don't raise `COUPON_HOLD_MINUTES` above 60 before 6c ships. Recorded here so the rollout doesn't.
- **`reconcile` re-verifying a mismatched failed row:** that only happens to a tampered payment, and the cost is a log line and a verify call per return-page load. Fine.
- **The return page stops polling at `failed`:** 6c A2's territory, so it's out of 6a.
- **The referral allowance counting `claim()`'s `signed_up` rows:** it's still a cap on emails, and a referrer with 20 signups a day is the success case. Fine for now.
- **The institution cap before the 409 already-active check:** a cosmetic order. Fine.
- **The `coupons.uses` read after the confirmed poll (e2e):** not a race. `uses + 1` commits in the same transaction as the confirmation, through a released savepoint, so once the confirmed row is visible, so is `uses`.
- The test-hygiene items (the single-dot spec, the log-content assertion, the describe-time IIFE, duplicate imports, `unpipedRouteParams` exported from the runtime entry, the `JWT_SECRET` env in one spec, which Jest gives each test file a copy of anyway): leave them, or tidy them in a later touch of those files.

### Rollout notes (for the user list when 6a merges)
- **Rollout prerequisites:** the plan's Rollout section has none. The caps and the hold window are code defaults, and Render needs no change. So the standing merge authorization applies once this is APPROVED and CI is green.
- **Post-deploy verifies (the user's):** the plan's Rollout step 3: the P1-01 probe returns 400, a password change asks for the current password, the referral invite returns `{ invited: n }`, and a signed-out pay link shows the course and the learner's first name.

## Round 2 (2026-10-03) · Verdict: APPROVED
`fix/security-platform` at `99bd653` (since Round 1: `78019cd`, `b3db839`, `0c876de`, `99bd653`). It changes `.gitleaks.toml`, the referral card in `dashboard/page.tsx`, and the plan's docs. No api, migration or e2e code changed, so Round 1's api, migration and drift results stand.

Checks, in my worktree at `99bd653`:
- **gitleaks v8.30.1 with the new `.gitleaks.toml`, over all history reachable from `99bd653`:** 154 commits, no leaks. impl's 189 is the same scan over `--all` refs.
- **Web:** `pnpm -C web typecheck` is clean, and `pnpm -C web test` passes (30 files, 377 tests).

### Round 1 findings
- **B2:** resolved (`b3db839`).
  - Both values are exact strings, not path entries, so a real key in those files still fails.
  - `Wrong-passw0rd` is the shared stem of the two made-up passwords and is no real secret's prefix.
  - The token alphabet is the public `randomCode` alphabet.
  - Both carry the "made-up / not a key" comment the file's header asks for.
- **N3:** taken (`0c876de`). It's only the copy for `invited: 0`; any other count is unchanged. No vitest pins the new sentence, which is fine for a copy change.

### Blockers / Should-fix
None.

### Merge
6a is ready to push and merge:
- **Same-day rule:** impl pushes `fix/security-platform` and opens the PR only when it can merge and deploy the same day.
- **Merge conditions:** I merge with `--merge` once CI is green, including `secret-scan` and the e2e job with `e2e-security`.
- **Prerequisites:** none in the Rollout section.
- **After deploy:** the post-deploy checks are USER-ACTIONS item 5, plus `prod-rollout.sh verify 6a`.

## Reviewer state (checkpoint, 2026-10-03)
- **6a:** code review done, APPROVED in Round 2 at `99bd653`. No review round is open.
- **Next for ethio-reviewer:**
  1. When ethio-impl sends the 6a PR number, check its head is `99bd653` or a later commit that changes only docs. If any code changed, review it first.
  2. Wait for green CI: `secret-scan`, `api`, `web`, `e2e` (with `e2e-security`), and the docker jobs if they run.
  3. Merge with `gh pr merge <N> --merge --match-head-commit <sha>`.
  4. Tell ethio-planner and ethio-impl the merge SHA, and tick "6a merged" in `docs/plans/USER-ACTIONS.md` item 5's context. The post-deploy checks (item 5 and `verify 6a`) stay the user's.
- **After 6a:** merges follow ethio-planner's queue (6c, 6b, 7a, 7b, …). Each needs green CI and APPROVED, plus that phase's USER-ACTIONS prerequisites ticked (6c: item 6).
- **Review worktree:** `../ethi0-review-6a`, detached at `99bd653`. Move it with `git -C ../ethi0-review-6a checkout --detach <sha>`, and never touch the shared tree. Scratch DBs go in the compose Postgres as `el_verify_*`, created from `docker/postgres-init.sql` and dropped after.
- **Messaging:** two sessions are named `ethio-impl` (local, and Remote Control on another machine). Address the local one by its ref from `ListAgents`.
- **Update (2026-10-03):** ethio-planner pushed 6a as PR #24, with head `e2c4014`: `99bd653` plus one docs-only commit, so no re-review is needed. ethio-planner watches CI and merges it, so ethio-reviewer does **not** merge 6a, and step 3 above is dropped. Wait for ethio-planner's one-line merge notice.
- **Merged (2026-10-03):** PR #24 merged as `c82d091`, with all CI green. 6a is done for ethio-reviewer. The post-deploy checks (USER-ACTIONS item 5 and `verify 6a`) are the user's. Next: 6c (`docs/plans/2026-10-02-money-integrity/`) Round 1, when ethio-impl asks.
