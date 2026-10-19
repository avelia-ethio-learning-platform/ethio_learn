# Phase 9c: Outbound calls, scheduled jobs and status codes

Status: approved (round 2); drift check vs 9a (2026-10-03) D1–D2 folded in
Size: L (sessions: 4 — ethio-impl implements, ethio-plan-review reviews the plan, ethio-reviewer reviews the code)
Base branch: `fix/outbox` (9b), or `origin/main` once it has merged. This phase edits 6a's retyped internal client (`get(internalPath\`…\`)`) and 6c's bank-transfer and refund code. · Feature branch: `fix/calls-and-jobs`
Roadmap: phase 9c (see 9a's "Roadmap change"). Findings:
- P1-18, including the Phase 4 code-review note: a failed learner lookup must throw, so the re-publish cron retries the receipt;
- P1-19, plus the ops half of P0-09 for jobs: jobs must run while free instances sleep;
- P1-23;
- P2-15;
- Phase 4's deferred N1 and N2;
- the parts of P2-03 still open after Phases 4, 6a and 6c.

## Goal
A slow or sleeping dependency should give a clear, retryable answer, never a wrong default. Examples today: a second checkout for a course the learner owns, a receipt with no email, "0% progress".
- Chapa calls time out instead of hanging the webhook and the sweep, and a Chapa outage is no longer reported as "still pending".
- Scheduled jobs (the missed-webhook sweep, the effects re-publish, payouts, nudges) run even though free instances sleep, never overlap, and don't starve older rows.
- Client mistakes get 4xx, not 500.
- Deploys don't drop in-flight gateway requests.
- The remaining check-then-act races get database guards.

Acceptance criteria:
- **Internal calls (P1-18):**
  - A peer that answers 404 gives the caller a 404, not a 500.
  - A sleeping peer (Render's hibernation 429), a peer 5xx or a timeout gives a 503 with `code: 'service_waking'` or `'service_unavailable'` and `Retry-After: 30`.
  - The web treats a `service_waking` 503 like Phase 5's `WakingError`.
- **No unsafe defaults (P1-18):**
  - `ownsCourse` failing refuses checkout with a 503 ("try again in a minute"); it no longer answers "not owned";
  - **the receipt never holds back access:** `PaymentConfirmed`, which grants entitlement, is published with whatever the learner lookup returned, as today. When `learner_email` is blank, notification looks the learner up itself and throws on a 503, so 9a's retry covers a short sleep and the receipt arrives once auth is awake (plan-review B1);
  - `progressPercent` returns `null` on failure, and the dashboard shows "—", not "0%";
  - every other fail-open default is either justified as erring on the safe side or changed to throw (decision 3).
- **Chapa (P1-18):**
  - every Chapa call has a timeout (`CHAPA_TIMEOUT_MS`, default 10 s);
  - `verify` distinguishes "Chapa says pending" from "Chapa unreachable";
  - the sweep stops its batch when Chapa is unreachable;
  - `chapa-nestjs` and the `axios@1.2.1` it pulls in are removed (decision 4), which also clears that P1-08 advisory.
- **Jobs (P1-19, P0-09 ops):**
  - each job (payment sweep, effects re-publish, abandoned-checkout nudges, payouts, inactivity nudges) runs under a lease in the database, so two instances, or the in-process cron plus an external trigger, never overlap;
  - each job can be started by an authenticated `POST /api/v1/jobs/<service>/<job>` that returns 202 at once;
  - a GitHub Actions schedule wakes the needed services and triggers the jobs inside the free tier's instance-hour budget;
  - each job's last start, finish and result are visible through `/ready`'s companion `GET /api/v1/jobs/<service>` (decision 6).
- **Sweep fairness (P1-19):** the sweep checks the payments it has checked least recently first, so a busy day no longer starves older, paid but unconfirmed payments.
- **N1:** the learner's own `reconcile` also re-checks a payment marked `failed`.
- **N2:** the re-publish cron orders by `COALESCE(webhook_received_at, created_at)`.
- **Status codes (P1-23):**
  - `limit`, `page` and similar query numbers are validated (400 when out of range) on every endpoint that takes them;
  - Postgres 23505 maps to 409; 23503, 23502, 22001 and 22003 map to 400. No stack or SQL in the body.
- **Shutdown (P2-15):** the gateway closes gracefully on SIGTERM, finishing in-flight requests up to 10 s, and the API images run under an init process.
- **Races (P2-03, still open):**
  - two concurrent bulk-seat assignments can't exceed the order's seats or give one email two seats;
  - two concurrent referral invites to the same email make one row;
  - two concurrent first calls to the referral code endpoint don't 500;
  - two concurrent wallet payments for the same course charge once.

## Non-goals
- **Keeping free services warm,** or moving to paid instances. The schedule fits the free budget (decision 7). Upgrading is the user's call; the docs say how.
- **Reusing or expiring abandoned checkouts (P2-01),** and two Chapa checkouts for one course paid in two tabs. Both stay as today, with refunds as the remedy.
- **Request IDs and JSON logs** (9d); batched internal endpoints (P1-22, 9e).
- **Retrying non-GET internal calls.** There are none; the client is GET-only.
- **CI and branch gates for the jobs workflow** (Phase 11).

## Current state
At `2cdccf9`, plus 6a (`internalPath` brand on all ~75 internal call sites), 6c (bank transfer and refunds), 9a and 9b.

- **Internal client** `api/packages/common/src/http/internal-client.ts`:
  - GET only, raw `fetch` with `x-internal-token`, `AbortSignal.timeout(INTERNAL_HTTP_TIMEOUT_MS ?? 8000)`, no retry (`:17-35`);
  - every failure (peer 404, hibernation 429, 5xx, timeout) is a plain `Error`, so a 500;
  - every call goes service → public gateway URL → target (`render.yaml:111-112`).
  - **Production finding (P0-09 update):** a sleeping service answers the gateway immediately with 429 and `x-render-routing: hibernate-rate-limited`, and traffic from inside Render doesn't wake it. Only an outside request to its own `/health` does.
- **Fail-open defaults:**
  - `payment.service.ts:742-749` `ownsCourse` returns false;
  - `:828-834` `learnerInfo` returns `{ email: '', name: '' }`. `confirmPayment` relies on it never throwing (`:446`), and `emitConfirmed` (`:794-812`) uses it before `publishConfirmed`; then `completeEffects` sets `effects_completed_at` (`:541`), so a transient lookup failure loses the receipt for good;
  - `enrollment.service.ts:636-648` `progressPercent` returns 0;
  - others at `sponsorship.service.ts:494,524,533,541`, `growth.service.ts:457,468`, `refund.service.ts:158,179`, `payout.service.ts:233,248,274`, `enrollment.service.ts:310,321,559-566,606-615,654`, `assessment.service.ts:383,507,674,790-823,901`, `notification.service.ts:591,613,621`, `quality.service.ts:647`, `course.service.ts:805,1146-1241,1332,1512`, `revision.service.ts:707,720`, `profiles.controller.ts:78`.
- **Chapa** (`financial/src/chapa.provider.ts`):
  - `LiveChapaProvider` wraps `chapa-nestjs@1.3.1` (`@nestjs/axios` 0.1.1, `axios@1.2.1`, no timeout; `app.module.ts:25-27`);
  - `initialize` (`:74-90`) maps every error, network ones included, to a 400 "gateway rejected";
  - `verify` (`:92-114`) returns `pending` on any error, so the sweep's catch never fires, the webhook (`payment.service.ts:297`) can hang until the gateway's 30 s proxy timeout, and reconcile reports an outage as pending.
  - Mock mode is unaffected (`:123-162`).
- **Jobs:** `ScheduleModule` only in financial and enrollment.
  - `sweepPendingPayments` (`payment.service.ts:322`, every 2 min, newest 25 pending Chapa rows of the last 24 h, `created_at DESC`, no guard, no attempt cap);
  - `nudgeAbandonedCheckouts` (`:350`, hourly);
  - `completePendingEffects` (`:553`, every 2 min, in-process flag only, `ORDER BY webhook_received_at ASC` with NULLs last, `:570`);
  - payouts `nightly` (`payout.service.ts:73`, 02:00, already guarded by an advisory lock and conditional updates);
  - `nudgeInactiveLearners` (`enrollment.service.ts:263`, 06:00, `take: 500`).
  - Sleeping instances run none of them. The only HTTP trigger is the admin-JWT `POST /payouts/run`.
- **Gateway routes** (`gateway/src/routes.ts`): auth modes `jwt`, `optional` and `internal` (`:33-41`). `internal` requires `x-internal-token` (timing-safe, `main.ts:60-64,198-206`). The gateway sets the internal token on every proxied request.
- **Errors:**
  - `bootstrap.ts:67-69`: `ValidationPipe({ whitelist, transform })` and only `DbErrorFilter`;
  - `db-error.filter.ts` maps 22P02 only, so 23505 and others are 500.
  - **Unvalidated `limit`/`page`:** admin payments (`controllers.ts:202`, `payment.service.ts:644-650`), course search (`course.controller.ts:151-154`, `course.service.ts:1098-1101`), top educators (`course.controller.ts:159-160`, `course.service.ts:1118-1139`) and admin users (`admin.controller.ts:26-28`; Phase 8 adds `q`).
- **Shutdown:**
  - services call `enableShutdownHooks()` (`bootstrap.ts:69`), but the gateway doesn't (`gateway/src/main.ts:66-234`);
  - `api/Dockerfile:23` runs `node` as PID 1.
- **Races still open after Phases 4, 6a and 6c:**
  - `assignSeats` (`sponsorship.service.ts:279-328`): reads used seats, then inserts per email; no lock and no unique `(bulk_purchase_id, recipient_email)`;
  - referral `invite` (`growth.service.ts:342-374`): find-then-save, no unique `(referrer_id, referred_email)`; 6a adds only non-unique indexes;
  - `codeFor` (`:439-450`): find-then-save, so a concurrent first call gets an unhandled 23505;
  - wallet double purchase: `initiate` checks ownership remotely, then creates a payment, so two parallel wallet payments for one course both debit and confirm.
- **Docs:** `docs/DEPLOYMENT.md:57`, `DEPLOYMENT.md:149` and `README.md:41,160` promise a self-healing sweep and a single-replica schedule.

## Design and key decisions
1. **The internal client classifies failures; callers decide:**
   - Typed errors in `packages/common/src/http/internal-errors.ts`:
     - `PeerNotFoundError extends NotFoundException`;
     - `PeerAsleepError extends ServiceUnavailableException`: a 429 with the hibernation header, or any non-JSON 429;
     - `PeerUnavailableError extends ServiceUnavailableException`: 5xx, network, timeout.
   - Both 503 variants carry `{ code: 'service_waking' | 'service_unavailable' }` and set `Retry-After: 30` through a small filter.
   - Messages never include the path. The path can carry an email (`users/by-email/…`); it is logged only through 9d's `redactPath`.
   - **Retry:** one retry after 500 ms, only when the first attempt failed fast with a network error (connection refused or reset), not after a timeout. A retry after an 8 s timeout would push one call to 16.5 s and two sequential calls past the gateway's 30 s proxy timeout (plan-review N3). A sleeping peer won't wake from inside Render, so a hibernation 429 isn't retried either.
   - `INTERNAL_HTTP_TIMEOUT_MS` stays 8 s.
   - **Web (small):** `web/src/lib/api.ts` treats a 503 whose JSON `code` is `service_waking` as `WakingError`, so Phase 5's wake and retry flow covers server-side sleeps too. Add one vitest.
   - **Rejected:** having the service or the gateway wake the sleeping peer. Production showed traffic from inside Render doesn't wake services, so it would be dead code. Waking comes from the browser (Phase 5) and the scheduler (decision 7).
2. **Fail closed where a default is wrong:**
   - **`ownsCourse`:** throws (503 from the client error), so checkout says "We couldn't check your courses just now. Try again in a minute."
   - **`learnerInfo` keeps its default, and the receipt moves its lookup to the consumer** (plan-review B1). The Phase 4 code-review note asked for a throwing lookup, but `emitConfirmed` publishes `PaymentConfirmed`, which grants access. Gating it on auth being awake would leave a learner who paid without access whenever auth sleeps.
     - `emitConfirmed` keeps `learnerInfo` with its blank default, and still publishes and completes effects at once.
     - Notification's `PaymentConfirmed` handler (and any other email handler whose payload email is blank) looks the learner up through `userInfo` (`notification.service.ts:627`). It throws on a 503, so 9a's retry delivers the receipt once auth wakes, and it skips with a warn on a peer 404 (deleted user).
     - This closes the note's actual problem, the lost receipt, without touching the access path.
   - **`progressPercent`:** returns `null` on failure. `GET /enrollments` and the entitlement endpoint return `progress_percent: number | null`, and the dashboard renders "—" for null (one web edit plus a vitest).
   - **Referral invite lookup (added 2026-10-03, from 6a's code review S3; a pre-existing bug):**
     - **The bug:** `GrowthService.invite` treats any failed auth lookup as "not an account". When auth is asleep, an existing user is recorded as invited and emailed.
     - **The fix:** catch only `PeerNotFoundError` as "not an account". Any other error fails the request with the client's 503.
     - **Spec:** a `PeerAsleepError` from the lookup → 503, with no referral row and no event.
   - **Bank transfer "learner exists" check (added 2026-10-03, from 6c ruling R2):**
     - **Today (after 6c):** `recordBankTransfer`'s check 3 tells an unknown learner (404) from a failed lookup (503) by matching an `InternalHttpClient` error message that ends in `-> 404`, with a comment pointing here. That text is the only signal before this phase.
     - **The change:** catch `PeerNotFoundError` for the 404 and let every other client error through as the 503. Drop the message match and its comment.
     - **Spec:** `PeerNotFoundError` → the same 404 that 6c returns; `PeerAsleepError` or `PeerUnavailableError` → 503, with no payment row written.
3. **Every other fail-open default gets one rule:** a default stays only if it errs on the safe side (a longer hold, hidden optional data, no grant, an optional message skipped). Otherwise it throws.
   - The implementer reviews each site listed in Current state against the rule and logs every decision in Progress.
   - **Known keeps:** the payout tier fallback to the 14-day hold (`payout.service.ts:248`), and blank names in notifications.
   - **Known changes:** `ownsCourse`, the receipt lookup, `progressPercent`.
4. **Chapa via `fetch`, with timeouts and honest results:**
   - `LiveChapaProvider` calls Chapa's REST API directly: initialize (`POST /v1/transaction/initialize`), verify (`GET /v1/transaction/verify/:tx_ref`), and the tx-ref generator the SDK provides today. It sends `Authorization: Bearer <secret>` and `AbortSignal.timeout(CHAPA_TIMEOUT_MS)`.
     - The implementer copies the exact URLs, headers and body fields from the installed SDK's source (`node_modules/chapa-nestjs/dist/chapa-sdk/chapa.service.js`) and pins them in a spec with recorded request and response fixtures, so the wire format is unchanged.
     - Then `chapa-nestjs` is removed from `financial/package.json`, which drops `@nestjs/axios` and `axios@1.2.1` from the lockfile.
   - **`initialize`:** a Chapa 4xx keeps its body in the error message, as the SDK's `HttpException` does today, and becomes a 400. The `CHAPA_FALLBACK_EMAIL` retry (`payment.service.ts:258-261`) matches `/validation\.email|valid email/i` on that text, so it must survive (plan-review S3). A timeout, network error or 5xx becomes a 503 "The payment provider is not responding. Try again in a minute." (`ChapaUnavailableError`).
   - **`verify`:**
     - Chapa answers with a status → mapped exactly as today (`success`, `failed` by substring, otherwise `pending`);
     - Chapa answers 401 or 403 → `ChapaUnavailableError`, logged at error as a configuration problem (a wrong or rotated secret), so the sweep stops loudly instead of leaving every payment pending in silence (plan-review N2);
     - any other Chapa 4xx → `pending`, which is fail-safe, as today;
     - timeout, network or 5xx → throws `ChapaUnavailableError`.
   - **Callers of `verify`:**
     - the sweep catches it, logs once, and stops the batch;
     - the webhook catches it, logs, and still answers 200, leaving the row for the sweep, as today;
     - `reconcile` returns the current payment view, unchanged, plus `provider_unreachable: true`, which the payment-return page ignores safely.
   - Rejected: keeping the SDK with `Promise.race`. A hung axios socket stays open, and the vulnerable axios remains.
5. **Leases for jobs, in the database:**
   - New table `job_leases (name varchar(64) PRIMARY KEY, locked_until timestamptz NULL, holder varchar(64) NULL, last_started_at timestamptz NULL, last_finished_at timestamptz NULL, last_result jsonb NULL)` in the financial and enrollment schemas.
   - Helper `runJob(dataSource, name, ttl, fn)` in common:
     1. `UPDATE job_leases SET locked_until = now() + ttl, holder = $id, last_started_at = now() WHERE name = $1 AND (locked_until IS NULL OR locked_until < now()) RETURNING 1` (the row is upserted first);
     2. if no row comes back, it returns "already running";
     3. otherwise it runs `fn`, then records `last_finished_at`, a small `last_result` (counts, never personal data) and `locked_until = NULL`, `WHERE name = $1 AND holder = <this run>`, so a run that outlived its TTL never clears the lease of the run that took over (plan-review N1).
   - **TTLs:** sweep 10 min, effects 10 min, nudges 30 min, payouts 30 min, inactivity 30 min. A crashed run's lease simply expires.
   - **No connection held during the job:** unlike an advisory lock, this matters with a pool of 3. Payouts keep their existing advisory lock inside `runPayouts`.
   - **The in-process `@Cron`s stay** (they still run while an instance is awake) and go through `runJob` too, which retires the effects cron's in-process flag.
6. **Job endpoints for an external scheduler:**
   - **Gateway:** routes `POST /api/v1/jobs/financial/{sweep,effects,nudges,payouts}` and `POST /api/v1/jobs/enrollment/inactivity`, with a new auth mode `jobs`.
     - It requires `Authorization: Bearer <JOBS_TOKEN>`, checked timing-safe.
     - It proxies to the service path `/api/v1/jobs/<job>`, stamped with the internal token as usual.
     - `GET /api/v1/jobs/<service>` returns each job's lease row (start, finish, result counts), with the same auth.
   - **Services:** a `JobsController` guarded by the existing internal guard starts `runJob` without awaiting it. It returns 202 `{ job, started: true }`, or 202 `{ job, started: false, reason: 'running' }`. The proxy's 30 s timeout never cuts a job.
   - **`JOBS_TOKEN`** is gateway-only: an env var on the gateway service in `render.yaml` with `sync: false` (the value is set in the dashboard), not the shared env group that every service reads. It is also a GitHub Actions secret. A separate token keeps the mesh-wide `INTERNAL_API_TOKEN` out of GitHub and lets it rotate alone.
   - The admin `POST /payouts/run` stays.
   - Rejected: reusing `INTERNAL_API_TOKEN` for the scheduler, which would put the mesh credential in a third system.
7. **The scheduler: GitHub Actions, sized to the free tier:**
   - **`.github/workflows/jobs.yml`:**
     - `schedule` entries, plus `workflow_dispatch` with a job choice;
     - each run first wakes the services it needs by `GET <service public URL>/health` with retries (every 10 s, up to 90 s per service; URLs from a repository variable `RENDER_SERVICE_URLS`, the same list as `NEXT_PUBLIC_WAKE_URLS`);
     - then it calls the gateway job endpoints with `JOBS_TOKEN`.
   - **Budget:** the 750 free instance-hours a month are shared by every free service in the workspace, and running out suspends every free web service until the next month (Render's free-tier terms). So every scheduled wake comes straight off what real traffic can use. Each wake keeps a service up at least 15 minutes. The schedule therefore wakes only what each job needs to run. Events wait in durable queues, and consumers handle them on their next wake (any visitor's Phase 5 wake pings) (plan-review S1).

     | When (UTC) | Jobs | Services woken | Hours a month |
     |---|---|---|---|
     | `0 */4 * * *` | sweep, effects, nudges | gateway, financial | 2 × 6/day × 0.25 h × 30 ≈ 90 h |
     | `15 2 * * *` | payouts | gateway, financial, auth (payee lookups) | ≈ 23 h |
     | `15 6 * * *` | inactivity | gateway, enrollment, course | ≈ 23 h |

     - About 136 h in total. After B1 the sweep no longer needs auth.
     - The every-4-hours sweep is a backstop: the in-process cron still runs every 2 minutes whenever financial is awake, and the payment-return page reconciles on its own.
     - **Before enabling the workflow,** the user reads the current month's usage on Render's billing page and picks the cadence. The docs show how to change it and say plainly that exhausting the hours takes the whole site offline.
   - **Workflow hygiene:** `permissions: {}`, `concurrency: jobs`, `timeout-minutes: 15`.
   - The secret and variable are set by the user (Rollout). Without them the workflow fails its first step with a clear message and does nothing else.
   - Rejected: Render Cron Jobs (not on the free plan) and an external cron service (another account and another place for the token).
8. **The sweep and re-publish order (P1-19, N1, N2):**
   - **`payments` gains `verify_checked_at timestamptz NULL` and `verify_attempts int NOT NULL DEFAULT 0`** (metadata-only).
   - **The sweep:**
     - selects pending Chapa rows of the last 24 h ordered by `verify_checked_at NULLS FIRST, created_at`, limit 25;
     - stamps both columns per check;
     - skips rows with 30 or more attempts, logging them once a day at warn as "payment X unverifiable after 30 checks".
     - A partial index `(verify_checked_at NULLS FIRST, created_at) WHERE status = 'pending' AND method = 'chapa'` keeps it cheap.
   - **N1:** `reconcile` (one learner, one payment, user-initiated) accepts `pending` or `failed`. The sweep stays `pending`-only, per the Phase 4 review.
   - **N2:** the re-publish cron uses a query builder ordered by `COALESCE(webhook_received_at, created_at)`. The partial index from Phase 4 already restricts it to the few unfinished rows, so no new index.
9. **Status codes (P1-23):**
   - A `PageQuery` DTO in common (`page`: int 1–10 000, default 1; `limit`: int 1–`max`, per-endpoint default and max), with `@Type(() => Number)`. It is applied to admin payments, admin users, course search and top educators.
   - `DbErrorFilter`:
     - 23505 → 409 "This already exists." (callers that already catch it keep their own message);
     - 23503 → 400 "A related record doesn't exist.";
     - 23502, 22001, 22003 → 400 "Invalid value.";
     - logs the code and table at warn, never the detail with values.
   - The internal client's typed errors (decision 1) cover peer 404s, e.g. `enrollFree` for a missing course → 404.
10. **Graceful shutdown (P2-15):**
    - the gateway calls `app.enableShutdownHooks()`;
    - on SIGTERM it stops accepting connections, waits up to 10 s (`SHUTDOWN_GRACE_MS`) for in-flight requests, then destroys the keep-alive agents;
    - `api/Dockerfile` installs `tini` and uses `ENTRYPOINT ["/sbin/tini", "--"]`;
    - services already have hooks; their crons stop on close, and an interrupted job's lease expires.
11. **The races still open (P2-03):**
    - **Bulk seats:** `assignSeats` runs in one transaction that locks the bulk order row (`SELECT … FOR UPDATE`), counts used seats inside the lock, and inserts with `ON CONFLICT DO NOTHING` against a new unique index `(bulk_purchase_id, lower(recipient_email))`. Emails that conflict are reported as "already assigned", not charged twice. The per-email HTTP lookups run before the transaction, so the lock isn't held across network calls.
    - **Referral invites:** unique `(referrer_id, lower(referred_email))` plus `INSERT … ON CONFLICT DO NOTHING`. Publish only on insert, matching 6a's rule.
    - **`codeFor`:** `INSERT … ON CONFLICT (user_id) DO NOTHING`, then select.
    - **Wallet double purchase:** `initiate` takes `pg_advisory_xact_lock(hashtext('course-purchase:' || learner_id || ':' || course_id))`.
      - Inside the lock it refuses when financial's own `payments` already has a `confirmed` course payment for that learner and course (409 "You already own this course."), or, for wallet payments, a `pending` wallet payment for it (409 "A payment for this course is in progress.").
      - **When `useWallet` is set, `createSession` inserts the row as `method = wallet` inside that locked transaction.** Today it inserts as `chapa` and switches to `wallet` only in `confirmPayment` (`payment.service.ts:170-187,216-221,454-456`), which would let a second request's check miss the first's pending row (plan-review S2).
      - This is a local check, so it doesn't depend on enrollment having processed `PaymentConfirmed` yet.
      - Chapa checkouts keep today's behaviour (Non-goals).
    - **Migrations** build the unique indexes `CONCURRENTLY`. A duplicate makes the build fail and leaves an INVALID index; the rerun drops it (the Phase 3 pattern). Rollout lists the read-only duplicate checks the user runs before merge.

## Data model and migrations
- **financial:**
  - `job_leases` (decision 5);
  - `payments ADD verify_checked_at timestamptz NULL, ADD verify_attempts int NOT NULL DEFAULT 0` (metadata-only on PG 11+), plus the partial index (decision 8);
  - unique `sponsorships (bulk_purchase_id, lower(recipient_email)) WHERE bulk_purchase_id IS NOT NULL`;
  - unique `referrals (referrer_id, lower(referred_email))`.

  Table and column names are confirmed against the entities.
- **enrollment:** `job_leases`.
- **Indexes** use `CONCURRENTLY` in their own migration (`transaction = false`). Each `down()` drops what its `up()` added.

## API contract
| Endpoint | Auth | Request | Response |
|---|---|---|---|
| `POST /api/v1/jobs/financial/{sweep,effects,nudges,payouts}` (new) | `Authorization: Bearer <JOBS_TOKEN>` at the gateway | — | 202 `{ job, started: true }` or `{ job, started: false, reason: 'running' }`; 401 without a valid token |
| `POST /api/v1/jobs/enrollment/inactivity` (new) | same | — | same |
| `GET /api/v1/jobs/{financial,enrollment}` (new) | same | — | 200 `[{ name, last_started_at, last_finished_at, last_result, running }]` |
| Any endpoint that calls a peer (changed) | as today | as today | 404 when the peer says 404; 503 `{ code: 'service_waking' \| 'service_unavailable' }` + `Retry-After: 30` |
| `POST /payments/initiate` (changed) | learner | as today | adds 409 already owned; 409 wallet payment in progress; 503 ownership check unavailable or Chapa unreachable |
| `POST /payments/reconcile` (changed) | learner | as today | also re-checks a `failed` payment; may add `provider_unreachable: true` |
| `GET /enrollments`, entitlement (changed) | as today | as today | `progress_percent: number \| null` |
| Paged endpoints (changed) | as today | `page`, `limit` validated | 400 out of range |
| `POST /bulk-purchases/:id/assign` (changed) | as today | as today | per-email result adds `already_assigned` |

## Steps
- [x] 1. Branch `fix/calls-and-jobs` from `fix/outbox`.
- [x] 2. Internal client errors and retry (decision 1), plus the web `service_waking` → `WakingError` mapping. · Specs: 404 → `PeerNotFoundError`; hibernation 429 (with header, and a plain-text 429 without it) → `PeerAsleepError`; 5xx and timeout → `PeerUnavailableError`; a fast network error (refused or reset) is retried once after 500 ms, and a timeout is not retried; the thrown message has no path; the web vitest.
- [x] 3. Fail-closed lookups (decisions 2, 3): `ownsCourse`; the referral-invite lookup (decision 2, 6a S3); the bank-transfer learner check switches to `PeerNotFoundError` (decision 2, 6c R2); the receipt lookup, which moved to notification's `PaymentConfirmed` handler (decision 2); `progressPercent` null plus the dashboard "—"; the review of the remaining sites, logged in Progress.
  - Specs:
    - checkout with the enrollment peer down → 503 and no payment row;
    - `completeEffects` with auth down → `PaymentConfirmed` is still published (access granted) with a blank email;
    - notification's `PaymentConfirmed` handler with a blank email and auth down → throws (retried), and with auth up → looks up the email and sends the receipt;
    - a deleted learner → notification skips with a warn.
  - **Drift D1:** at 9a, `userInfo` (`notification.service.ts:640`) degrades every error to blank and has eight callers whose fallback is intended (`userName`, the follower fan-out, `CourseUpdated`, PayRequest, wallet and staff notices). Leave it as it is. Add a separate `requireUserEmail(id)`: it rethrows `PeerAsleepError`/`PeerUnavailableError` and returns `null` on `PeerNotFoundError`. Use it only where the payload email is blank (the receipt and the other `deliver(…, p.learner_email, …)` handlers). The specs above name it.
- [x] 4. Chapa over `fetch` (decision 4). Fixture specs for initialize and verify request shapes; a Chapa email-validation 4xx on initialize triggers the fallback-email retry; a verify 401 → `ChapaUnavailableError`. Timeout → `ChapaUnavailableError`. The sweep stops its batch, the webhook still answers 200, reconcile flags `provider_unreachable`. Remove `chapa-nestjs`, then `pnpm install` and confirm `axios@1.2.1` is gone from `api/pnpm-lock.yaml`.
  - The mock-mode e2e (`e2e-payments.mjs`) stays green.
- [x] 5. Leases and job endpoints (decisions 5, 6): `job_leases` migrations; `runJob`; the crons through `runJob`; `JobsController`s; the gateway `jobs` auth mode and routes; `JOBS_TOKEN` in config and `.env.example`.
  - Specs:
    - two concurrent `runJob` → one runs;
    - an expired lease is taken over, and the late original run doesn't clear the new holder's lease;
    - the endpoint returns 202 before the job finishes;
    - the gateway refuses without the token, refuses the wrong token, and the timing-safe compare is used;
    - the result rows hold no personal data.
- [x] 6. Sweep fairness, N1, N2 (decision 8): migration, query, attempt cap, reconcile accepting `failed`, the re-publish order. · Specs: with 30 pending rows, two sweeps cover all 30, oldest-unchecked first; reconcile on a failed row verifies; the re-publish order puts NULL `webhook_received_at` rows by `created_at`.
- [x] 7. Status codes (decision 9): `PageQuery` on the four endpoints; the `DbErrorFilter` mappings. · Specs: `limit=-5` → 400; `limit=1000` → 400; a 23505 → 409 with no detail in the body.
- [x] 8. Graceful shutdown (decision 10). · Check: start the gateway, open a slow request, send SIGTERM, and see the request complete and the process exit within the grace period. Record it.
- [x] 9. Races (decision 11): migrations and code.
  - Specs:
    - concurrent `assignSeats` (two transactions, sequenced with the fake or the local DB) never exceed the seats;
    - duplicate invite → one row;
    - concurrent `codeFor` → no throw;
    - two concurrent wallet initiations → one 409, with the row inserted as `wallet` inside the lock (checked against the real local database, not the fake);
  - Add a concurrency case to `scripts/e2e-payments.mjs`: two parallel wallet buys of one course, one charge.
- [x] 10. Scheduler (decision 7): `.github/workflows/jobs.yml`.
  - Dry run with `workflow_dispatch` against the local stack is impossible from GitHub, so test the script part locally: a `scripts/run-jobs.mjs` that the workflow calls, run against the local gateway with a local `JOBS_TOKEN`.
  - The workflow itself is checked by `actionlint` if available, or by review.
- [x] 11. Docs:
  - replace the self-healing and single-replica claims (`docs/DEPLOYMENT.md:57`, `DEPLOYMENT.md:149`, `README.md:41,160`) with how jobs actually run: in-process while awake, the GitHub schedule otherwise, the budget table, how to change the cadence;
  - document `JOBS_TOKEN`, `RENDER_SERVICE_URLS` and `GET /api/v1/jobs/<service>`.
- [x] 12. Full gate:
  - `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`;
  - the web gates for the two web edits;
  - the CI e2e scripts and Playwright locally;
  - migrations apply on a fresh DB and the dev DB, and revert round-trips.
- [ ] 13. Code review by ethio-reviewer; the user approves push and PR.

## Test plan
- **Unit:**
  - client error classification;
  - fail-closed lookups and the receipt retry;
  - Chapa fixtures and unavailability handling;
  - `runJob`;
  - job endpoints and gateway auth;
  - sweep order and cap, reconcile N1, re-publish N2;
  - `PageQuery` and `DbErrorFilter`;
  - race guards.
- **Web vitest:** `service_waking` → `WakingError`; "—" for null progress.
- **E2E:** `e2e-payments.mjs` (mock Chapa, now with the wallet race case); `scripts/run-jobs.mjs` against the local stack (each job starts and records a result; a second call while running reports `running`).
- **Manual:** the gateway shutdown check (step 8).

## Rollout and ops
- **Before merge (the user; read-only on production):**
  - duplicate checks that must return no rows, or the unique index builds fail:
    - `SELECT bulk_purchase_id, recipient_email, count(*) FROM financial.sponsorships WHERE bulk_purchase_id IS NOT NULL AND status <> 'cancelled' GROUP BY 1, 2 HAVING count(*) > 1`;
    - `SELECT referrer_id, referred_email, count(*) FROM financial.referrals WHERE referred_email <> '' GROUP BY 1, 2 HAVING count(*) > 1`.
  - Confirm which Render services are awake-on-demand; nothing to change.
- **Secrets and variables (the user):**
  1. Generate a long random `JOBS_TOKEN`. Set it on the gateway service only (Render dashboard; `render.yaml` declares it with `sync: false`), not in `ethiopialearn-shared`, and as a GitHub Actions secret.
  2. Set the repository variable `RENDER_SERVICE_URLS` to the eight public service URLs, comma-separated.
  3. Read this month's instance-hour usage on Render's billing page first. If real traffic already uses most of the 750 hours, lengthen the sweep interval in `jobs.yml` before enabling it.

  Until both are set, the jobs workflow stops at its first step and the in-process crons keep running whenever an instance is awake, so nothing regresses.
- **Deploy:**
  - Removing `chapa-nestjs` changes the financial image only.
  - The `job_leases` and `payments` migrations are additive.
  - The races' unique indexes build `CONCURRENTLY`.
- **Watching:**
  - `GET /api/v1/jobs/financial` (with the token) shows each job's last run;
  - the GitHub Actions run history shows the schedule;
  - logs: `chapa unreachable, sweep stopped`, `payment X unverifiable after 30 checks`.

## Risks and open questions
- **Rewriting the Chapa client is on the live payment path.** The fixture specs pin the SDK's wire format, mock-mode e2e covers the flow, and the first production payment after deploy should be watched (the user's check: one real low-value payment, or the next organic one, confirms and enrolls).
- **GitHub scheduled workflows** run late under load and are disabled after 60 days without repository activity. The in-process crons and the payment-return reconcile remain, and the docs mention re-enabling the workflow.
- **The instance-hour estimate** assumes a 15-minute minimum per wake. The 750 hours are workspace-wide, and exhausting them suspends every free service until the next month. The schedule adds about 136 h on top of real traffic. If traffic grows, the user may need a paid gateway or financial instance; the budget table and the docs make that visible.
- **Every service that calls a peer** can now return 503 where it used to return 500 or a wrong default. The web handles `service_waking` (step 2). Other clients see an honest 503.
- **`progress_percent: null`** is a response change. The dashboard and the bulk-purchase seat list (the only consumers) are updated in this phase.

## Progress and deviations (implementer)

### Batch 1 (steps 2, 4, 7, 8, 10), 2026-10-03, ethio-impl
Branch `fix/calls-and-jobs` from `fix/outbox` 99204b7, plan commit 01ca4ce; `fix/outbox` b55f76e (9b steps 1–3) merged in with no conflicts.

- **Step 2** (5c62f68, b8195d5): `internal-errors.ts` (`PeerNotFoundError`, `PeerAsleepError`, `PeerUnavailableError`) and `PeerErrorFilter`, which adds `Retry-After: 30`.
  - The client retries once after 500 ms on `ECONNREFUSED`, `ECONNRESET` or `UND_ERR_SOCKET` (the early-read nit). It never retries a timeout, a 429 or any HTTP answer.
  - A stall while reading the body is a 503.
  - The web maps `service_waking` to `WakingError`.
  - **Deviation:** the two callers that matched the old `-> 404` message text now test `instanceof PeerNotFoundError`, with behaviour unchanged: `recordBankTransfer`'s learner check and notification's `userInfo`. Without that, step 2's message change would have broken both. Step 3 still owns the rest of decision 2.
  - **Deviation:** `isHibernation` is duplicated in the client, because api can't import web.
- **Step 4** (b98b047, 2ff6677): Chapa now goes over `fetch` with `CHAPA_TIMEOUT_MS` (10 s), and the timeout also covers reading the body.
  - The wire format was copied from chapa-nestjs 1.3.1 and pinned in `chapa.provider.spec.ts`.
  - A 4xx keeps its detail, so the fallback-email retry still fires.
  - A verify 401/403 logs an error and throws `ChapaUnavailableError`.
  - The sweep stops its batch on an outage, the webhook answers 200 with `provider unreachable`, and reconcile adds `provider_unreachable: true`.
  - `chapa-nestjs`, `@nestjs/axios` and every axios are gone from the lockfile.
  - **Deviation:** the SDK's client-side yup validation of the initialize options is dropped. Chapa validates on the server, and a 4xx maps to 400.
- **Step 7** (761cbf6, 710363a): page and limit are validated on admin payments and admin users (default 20, max 100), search (12 and 50) and top educators (limit only, 12 and 50).
  - `DbErrorFilter` maps 23505 → 409 and 23503/23502/22001/22003 → 400. The log carries only the code and table.
  - The catalog page clamps a typed `?page` to 10000.
- **Step 8** (f06f860): the gateway calls `enableShutdownHooks()` and cuts requests still open after `SHUTDOWN_GRACE_MS` (10 s), then destroys the keep-alive agents. `api/Dockerfile` runs under tini.
  - **Check:** a built gateway with a slow upstream stub.
    - A 3 s request that was in flight at SIGTERM finished with 200, and the process exited at +3.06 s.
    - A 15 s request was cut at the grace limit, with exit at +11.0 s (SIGTERM was sent at +1 s).
    - A new request after SIGTERM was refused.
- **Step 10** (7cbb262): `scripts/run-jobs.mjs` and `.github/workflows/jobs.yml`.
  - `node --test scripts/run-jobs.test.mjs` passes 4/4.
  - The YAML was checked with PyYAML, because actionlint isn't installed.
  - The run against the local gateway waits for step 5's endpoints.
- **Gate on this head:**
  - api build and typecheck are green.
  - jest is green except `packages/ai/src/index.spec.ts`, which timed out at 5 s under a load average of about 26 and passes 57/57 alone.
  - web vitest passes 647/647.

**In flight / next:** steps 3, 5, 6 and 9, after 9b's step 4 (site conversions) is merged in.

### Batch 2 (steps 3, 5, 6, 9, 11, 12 + review B1, S1, S2, N2, N3), 2026-10-19, ethio-impl
Commits 7b173cc, 56ecda6, 5be54ce, be61ed5, a1b181a, f825f31, 04c9af3, d094ff4; origin/main e4b4cde merged in.

- **Step 3** (7b173cc). Decision 3 site review: the remaining defaults stay, each logged where it applies; only these changed:
  - `ownsCourse` fails closed (initiate 503 with no row; nudges stop before the claim); the invite lookup rethrows all but `PeerNotFoundError`; `progressPercent` → null (refund throws `PeerUnavailableError`, milestones and inactivity skip); the receipt email is looked up in notification.
  - **Deviation:** the teach analytics page also shows "—" for a null average (not in the brief's list). `quality.service.ts:662` kept: null refuses the review, which is safe.
- **Step 5** (56ecda6). **Deviations:** one `createJobsController(service)` factory in common instead of a controller per service; the JobsAndSweep payment columns ship in this commit's migration.
- **Step 6** (5be54ce). **Deviations:** `find` with `{ nulls: 'FIRST' }` instead of a query builder, so no NULLS FIRST index; the effects re-publish merges two finds in memory. The 30-attempt cap logs once.
- **Step 9 + B1** (be61ed5, d094ff4): the wallet guard (try-lock, one read of confirmed or in-flight rows, insert, one transaction) on both paths; `assignSeats` locks the order row; invites ON CONFLICT and emit only on insert; `codeFor` upserts; the unique indexes in `1791100000001-UniqueSeatsAndInvites`. The Rollout duplicate checks above now match the index predicates.
  - The e2e race found a hole the specs missed: two separate reads let a settlement slip between them (fixed in d094ff4).
  - fake-db: a rollback undoes only its own transaction; `lock` takes row locks.
- **S1, S2** (a1b181a): payout disburse, createStaff, institution invites and pay requests commit with their events. A failed disbursement stays scheduled; the run and the admin release go on.
- **Scheduler change (the user):** two runs a day, each waking only what its jobs call (`run-jobs.mjs` `NEEDS`):

  | Run | Jobs | Wakes | Est. instance-hours/month |
  |---|---|---|---|
  | `daily` 02:15 UTC | all five | gateway, financial, enrollment, auth, course, quality | ~45 |
  | `frequent` 14:15 UTC | sweep, effects | gateway, financial | ~15 |

  ~60 h/month (was ~136), at ~15 min per woken service; less when traffic keeps them awake. Nudges moved to `daily` because they need enrollment.
- **Lint** (04c9af3): the earlier 9c commits had put three rules over the baseline; fixed.
- **Gate (2026-10-19, after the merge):**
  - api: build, typecheck, jest 1511 passed / 5 skipped, lint-check under baseline, `db:check` clean on the dev DB.
  - Fresh DB: all migrations apply; financial (2) and enrollment (1) revert and re-apply; `db:check` clean. Revert needs `transaction: 'none'` for the CONCURRENTLY migration.
  - Real Postgres on fresh DBs: resend 1/1, wallet race 2/2 (7 runs), job lease 2/2.
  - web: typecheck, vitest 746/746, build.
  - e2e (local, `CHAPA_MODE=mock`): revisions, institution, learning, security, smoke all green; payments green except "each of our payments is in a paid payout": the dev DB's demo educator has open fraud holds from earlier runs (environment, not code; CI uses a fresh DB). Playwright on :3002: 119 passed, 2 skipped.
  - Jobs dry run (local gateway, throwaway token, nothing called on Render): `frequent` and `daily` start every job; GET lists counts; no token or a wrong token → 401; three parallel POSTs → one `started:false, reason: running`.
  - `node --test scripts/run-jobs.test.mjs`: 7/7.

