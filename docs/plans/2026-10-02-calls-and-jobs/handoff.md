# Handoff: Phase 9c, outbound calls, scheduled jobs and status codes

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 2, see [plan-review.md](plan-review.md))
Code review goes to: ethio-reviewer (size L)

## What to build
- The internal client classifies failures into typed errors. A peer 404 becomes a 404, and a sleeping peer, a 5xx or a timeout becomes a 503 with `code` and `Retry-After: 30`. The web treats `service_waking` like Phase 5's `WakingError`.
- Lookups whose default is wrong fail closed: `ownsCourse` gives a 503 and `progressPercent` gives `null` ("—"). The receipt email is looked up by notification, so `PaymentConfirmed` never waits on auth.
- Chapa is called over `fetch`, with timeouts and honest results. `chapa-nestjs` and `axios@1.2.1` are removed.
- Jobs run under database leases, can be started through authenticated 202 endpoints, and are triggered by a GitHub Actions schedule sized to the free tier.
- The sweep checks the least recently checked payments first, and `reconcile` re-checks `failed` payments (N1). The re-publish cron orders by `COALESCE(webhook_received_at, created_at)` (N2).
- Validated `page`/`limit`, Postgres errors mapped to 4xx, a graceful gateway shutdown with `tini`, and database guards for the four remaining races.

## Read first, in order
1. `plan.md` decisions 1–11, then the round-1 findings in `plan-review.md` that changed the plan:
   - B1: `PaymentConfirmed` keeps `learnerInfo`'s blank default and is never gated on the email. When `learner_email` is blank, notification looks it up through `userInfo` and throws on a 503 (so 9a retries), and skips with a warn on a 404;
   - S1: the schedule comes to about 136 h a month. The sweep runs every 4 h and wakes only gateway and financial, and notification is never woken;
   - S2: with `useWallet`, the payment row is inserted as `method = wallet` inside the locked transaction;
   - S3: a Chapa 4xx on `initialize` keeps its body in the error, so the `CHAPA_FALLBACK_EMAIL` retry still matches;
   - N1: the lease is cleared only by its holder. N2: a verify 401/403 is `ChapaUnavailableError`. N3: retry only after a fast network failure, never after a timeout.
2. `api/packages/common/src/http/internal-client.ts` (`:17-35`, in 6a's retyped form), `api/packages/common/src/db-error.filter.ts` and `bootstrap.ts:67-69`.
3. `api/services/financial/src/payment.service.ts`:
   - `ownsCourse` (`:742-749`), `learnerInfo` (`:828-834`), `emitConfirmed` (`:794-812`);
   - `createSession`/`initiate` (`:170-187,216-221`) and `confirmPayment` (`:446,454-456`);
   - the fallback-email retry (`:258-261`), the sweep (`:322`), nudges (`:350`), the re-publish cron (`:553,570`).
4. `api/services/financial/src/chapa.provider.ts` (`:74-114`, mock at `:123-162`), and the installed SDK's `node_modules/chapa-nestjs/dist/chapa-sdk/chapa.service.js` for the wire format.
5. `api/services/notification/src/notification.service.ts:627` (`userInfo`) and its `PaymentConfirmed` handler.
6. The races and jobs: `sponsorship.service.ts:279-328` (`assignSeats`), `growth.service.ts:342-374,439-450`, `payout.service.ts:73,248`, `enrollment.service.ts:263,636-648`.
7. `api/gateway/src/routes.ts:33-41`, `api/gateway/src/main.ts:60-64,66-234`, `api/Dockerfile:23`.

Line numbers are at `2cdccf9`. 6a, 6c, 9a and 9b move them, so re-find each site by its code.

## Decisions already made (don't relitigate)
- **Typed client errors:**
  - `PeerNotFoundError` (404), `PeerAsleepError` (a hibernation 429, or any non-JSON 429), `PeerUnavailableError` (5xx, network, timeout);
  - both 503s carry `{ code: 'service_waking' | 'service_unavailable' }` and `Retry-After: 30`;
  - messages never include the path;
  - one retry after 500 ms, only after a fast network failure (refused or reset), never after a timeout or a 429;
  - no service or gateway code tries to wake a peer.
- **Fail-closed rule (decision 3):** a default stays only if it errs on the safe side (a longer hold, hidden optional data, no grant, an optional message skipped). Otherwise it throws.
  - Known keeps: the payout tier's 14-day-hold fallback, and blank names in notifications.
  - Known changes: `ownsCourse`, the receipt lookup (moved to notification), `progressPercent`.
  - Review every other listed site and log each decision in Progress.
- **Chapa via `fetch`:** the exact URLs, headers and body fields are copied from the installed SDK and pinned with fixtures, then `chapa-nestjs` is removed.
  - `initialize`: a 4xx keeps its body and becomes a 400; a timeout, network error or 5xx becomes a 503 `ChapaUnavailableError`.
  - `verify`: a returned status is mapped as today; a 401/403 is `ChapaUnavailableError`, logged as a configuration error; any other 4xx is `pending`; a timeout, network error or 5xx throws.
  - The sweep stops its batch, the webhook still answers 200, and `reconcile` adds `provider_unreachable: true`.
- **Leases:** a `job_leases` table in the financial and enrollment schemas, and `runJob` in common (an `UPDATE … RETURNING` lease, no connection held during the job, cleared only `WHERE holder = <this run>`).
  - TTLs: 10 min for sweep and effects, 30 min for the rest.
  - The in-process `@Cron`s stay and go through `runJob`; payouts keep their advisory lock.
- **Job endpoints:** a gateway `jobs` auth mode with `Authorization: Bearer <JOBS_TOKEN>`, checked timing-safe.
  - `JOBS_TOKEN` is separate from `INTERNAL_API_TOKEN`, so the mesh credential never goes to GitHub.
  - Services return 202 without awaiting the job. `GET /api/v1/jobs/<service>` returns the lease rows.
  - The admin `POST /payouts/run` stays.
- **The scheduler is GitHub Actions** (`.github/workflows/jobs.yml`): it wakes each needed service's `/health` from `RENDER_SERVICE_URLS`, then calls the job endpoints.
  - Every 4 h: sweep, effects and nudges, waking gateway and financial.
  - 02:15 UTC: payouts, waking gateway, financial and auth.
  - 06:15 UTC: inactivity, waking gateway, enrollment and course.
  - Without the secret and the variable, the workflow fails its first step and does nothing else.
  - Not Render Cron Jobs, not an external cron service.
- **Sweep:** `verify_checked_at` and `verify_attempts`, ordered `NULLS FIRST`, capped at 30 attempts, with a partial index. The sweep stays `pending`-only; only `reconcile` accepts `failed`.
- **Status codes:**
  - `PageQuery` on the four listed endpoints;
  - `DbErrorFilter`: 23505 → 409, 23503 → 400, and 23502, 22001 and 22003 → 400, with no detail or values in the body.
- **Shutdown:** the gateway calls `enableShutdownHooks()` and has a 10 s grace (`SHUTDOWN_GRACE_MS`). `api/Dockerfile` runs under `tini`.
- **Races:**
  - `assignSeats`: a locked order row, plus a unique `(bulk_purchase_id, lower(recipient_email))` with `ON CONFLICT DO NOTHING`;
  - referral invites: a unique `(referrer_id, lower(referred_email))`, publishing only on insert;
  - `codeFor`: `ON CONFLICT (user_id) DO NOTHING`;
  - wallet purchases: `pg_advisory_xact_lock` with a local check, and the row inserted as `wallet` inside the lock. Chapa checkouts keep today's behaviour.

## Gotchas learned while planning
- **Sleeping Render services** answer at once with 429 and `x-render-routing: hibernate-rate-limited`. Traffic from inside Render doesn't wake them; only an outside `GET` of the service's own `/health` does. That's why the client never retries a 429, and why only the browser (Phase 5) and the scheduler wake services.
- **Copy the Chapa wire format before removing the SDK.** Then confirm `axios@1.2.1` is gone from `api/pnpm-lock.yaml`. Mock mode is unaffected, and `e2e-payments.mjs` must stay green. Never call live Chapa.
- **The wallet race spec runs against the real local Postgres,** not the fake, which can't show the race.
- **Unique indexes** are built `CONCURRENTLY` in their own `transaction = false` migration. A duplicate makes the build fail and leaves an INVALID index, and the rerun drops it (the Phase 3 pattern). The user runs the read-only duplicate checks in Rollout before merge.
- **Rollout is the user's.** `JOBS_TOKEN` goes on the gateway service only (`sync: false` in `render.yaml`, not the shared env group) and in a GitHub Actions secret. `RENDER_SERVICE_URLS` is a repository variable. The user reads this month's instance-hour usage on Render's billing page first, because using up the 750 free hours suspends every free service until the next month. Don't set any of these yourself. For local runs, put a throwaway `JOBS_TOKEN` in your shell only.
- **9d and 9e build on these error classes:** 9d adds request ids, and 9e has display reads degrade on them. Keep the class names and `code` values as in the plan.
- **This plan folder isn't security-sensitive.** Commit it on your branch, staging paths explicitly. Several other plan folders are untracked, so never `git add -A`.
- **Environment:**
  - the node PATH export;
  - Postgres on 55432;
  - the pnpm `--store-dir` flag;
  - production is off-limits;
  - e2e runs on `.env.example` values only (blank the real SMTP, Chapa and Groq keys). Don't export `api/.env.example` into the shell that runs Playwright.

## How to run
- **Build and tests:** `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`.
- **Web (two edits):** `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`.
- **Migrations:** apply on a fresh DB and on the dev DB, and `migration:revert` round-trips.
- **E2E:** the CI scripts locally: `demo-seed`, `e2e-revisions`, `e2e-institution`, `e2e-payments` (now with the parallel wallet-buy case), `e2e-smoke`; then the Playwright suite.
- **Jobs:** `node scripts/run-jobs.mjs` against the local gateway with a local `JOBS_TOKEN`. Each job starts and records a result, and a second call while it runs reports `running`. Run `actionlint` on `jobs.yml` if it's available.
- **Shutdown:** the step 8 check: a slow request survives SIGTERM, and the process exits within the grace period.

## Branch
Create `fix/calls-and-jobs` from the tip of the stack when it starts (expected `fix/outbox`, 9b). Don't push until everything below has merged; then `git merge origin/main`.

## Definition of done
- The acceptance criteria are met.
- The decision 3 site review, the shutdown check and the `run-jobs.mjs` result are recorded in Progress.
- Build, tests, typecheck and `db:check` pass, along with the web gates, and migrations apply and revert.
- The checklist is ticked, with deviations logged.
- Then request code review from ethio-reviewer.

## Amendment 2026-10-03 (ethio-planner [aeff2b]): parallel tracks
- Phase 10 (web) and 11a (CI gates) now run in parallel from `origin/main`. **If 11a has merged** when you merge `origin/main`: add your own short section to `docs/DEPLOYMENT.md` (and your env vars to the env examples, if 11a's versions lack them), and keep `pnpm -C api lint` at or under `.github/lint-baseline.json` (fix new warnings rather than raising the baseline).
- The local stack is shared by every track: builds and unit tests run any time; the stack gate only in your window. Ask the current holder and hand it on when done.

## Amendment 2026-10-03 #2 (ethio-planner [aeff2b]): start early, overrides "Branch" above
- **Implementer:** ethio-impl [9be294] (9a/9b are with [572e5c]). Worktree `../ethi0-9c`.
- **Base:** create `fix/calls-and-jobs` from the current `fix/outbox` tip now, while 9b is still in progress. Merge `fix/outbox` into it whenever 9b commits a step; 9a's review fixes reach you the same way, through 9b.
- **Order:** first the steps that don't touch 9b's outbox conversions: 2 (internal client errors), 4 (Chapa over `fetch`), 7 (status codes), 8 (graceful shutdown) and 10 (`jobs.yml`). Do steps 3, 5, 6 and 9 (lookups, leases and job endpoints, sweep fairness, races) after 9b's step 4 (site conversions) is committed and merged in, because they edit the same financial, auth and notification code.
- **Ships after 9a+9b merge;** then `git merge origin/main`, push and PR. The merge waits for the user's `JOBS_TOKEN` and `RENDER_SERVICE_URLS` on Render. When your Rollout values are final (names, which services, the exact commands), send them to ethio-planner [aeff2b] so they go into USER-ACTIONS before your review ends.
- **Drift check vs 9a** is folded into `plan.md` (step 3's `requireUserEmail`; header). Read `plan-review.md` "Drift check vs 9a" too.
