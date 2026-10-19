# Handoff: Phase 9d, observability

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 2, see [plan-review.md](plan-review.md))
Code review goes to: ethio-reviewer (size L)

## What to build
- One request id follows a request from the gateway through every service, internal call and event it causes. It is UUID-only.
- The gateway writes one JSON access line per request, with emails and tokens redacted from the path.
- Every service and the gateway log JSON lines in production (`LOG_FORMAT`, `LOG_LEVEL`). Local dev stays readable.
- No log line carries an email address, a reset or invite link, or a query parameter value.
- A production notification service refuses to boot without a real email provider.

## Read first, in order
1. `plan.md` decisions 1–6, then `plan-review.md`:
   - round 1 B1: `redactPath` decodes each segment, then replaces `[email]`, `[token]` after `invite` and `pay-requests`, and any other non-UUID segment of 32+ hex characters. Plus the token-route guard;
   - B2: request ids are UUID-only, because the id becomes 9b's `uuid` `correlation_id`;
   - S1: `logQueryError` honours `logging`;
   - N1: provider failure bodies are redacted;
   - N2: the PII guard scans whole multi-line calls, case-insensitively;
   - N3: the bus supervisor and the job runners start outside any request;
   - round 2 nit: `logging` is passed into `SafeTypeOrmLogger`.
2. `api/packages/common/src/bootstrap.ts`, `typeorm.ts` (`:56-58`) and the 9a event context (`currentEvent()`) as they stand on the base branch.
3. `api/gateway/src/main.ts`: the proxy (`:134-157`), the proxy error (`:147`) and the middleware chain (`:164-229`).
4. The internal client from 6a and 9c, and `api/packages/common/src/events/event-bus.service.ts` (`publish`/`publishConfirmed`, `:171`), plus 9b's `emit`.
5. The email log sites: `auth.service.ts:189`, `notification.service.ts:663`, `sponsorship.service.ts:421`, `payment.service.ts:260`. Then `notification/src/email.provider.ts` (`:60,90,97-113,203-208`) and its spec.

## Decisions already made (don't relitigate)
- **One context store:** 9a's `AsyncLocalStorage` becomes `requestContext` in `packages/common/src/context.ts`, and `currentEvent()` stays as a view onto it.
  - The HTTP middleware is registered first in `bootstrapService`. The review tested it with the repo's express and body-parser: the store reaches the handler after JSON parsing.
- **Request id rule:** accept an incoming `x-request-id` only if it's a UUID, otherwise generate one.
  - The same rule applies at the gateway, in services, and in the dispatcher when it turns a `correlation_id` into `request_id`.
  - `publish`/`publishConfirmed` default `correlationId` to `request_id`; an explicit one (Phase 4's `payment.id`) still wins.
- **Background work:** the bus connection supervisor and 9c's job runners start under `requestContext.exit(…)`.
- **`redactPath`** lives in common, and both the gateway access log and the internal client use it.
  - No route templates: the gateway proxies by prefix and doesn't know them.
  - Course slugs and certificate uids stay readable.
  - `TOKEN_PARENTS = ['invite', 'pay-requests']`. The token-route guard fails the build when a controller adds a `/token|secret/i` param under any other parent.
- **Access log:** on `res.on('finish')`, with `request_id`, `method`, the redacted path, `status`, `ms`, `user_id` (only from a verified JWT), `upstream` and `ip`. A `/health` or `/ready` 200 isn't logged. Proxy errors add `error_code`, never the upstream URL.
- **`JsonLogger`:** implements Nest's `LoggerService` and writes one line per call with `process.stdout.write`. No pino. `LOG_FORMAT` defaults to `json` when `NODE_ENV=production`, `pretty` (Nest's ConsoleLogger) otherwise. `LOG_LEVEL` defaults to `log`.
- **PII:** `maskEmail` (first character, `***@`, domain). The listed lines log ids and counts, not addresses. The guard spec is a source scan, not a runtime check.
- **`SafeTypeOrmLogger(schema, logging)`:**
  - never prints parameters;
  - query errors log nothing under today's `['schema']`;
  - with `logging: true`, query errors print the SQLSTATE code, the constraint name and the truncated SQL, never the error `message`.
  - `assertProductionConfig` refuses `DB_LOGGING=true`.
- **Email in production:** the notification service's `productionRules` require one of `BREVO_API_KEY`, `SMTP_HOST` or `RESEND_API_KEY`, and `ConsoleEmailProvider` refuses to construct in production too. Development still prints the body.

## Gotchas learned while planning
- **`pay-requests` tokens aren't hex.** They're `randomCode(24)` (`sponsorship.service.ts:80,123`), so only the `TOKEN_PARENTS` rule catches them. The hex catch-all is for invite tokens and future ones.
- **Decode before matching.** `users/by-email/` is built with `encodeURIComponent`, so the raw segment reads `name%40domain`. A malformed escape must give `[token]`, not throw.
- **A custom TypeORM logger is called for every query error,** whatever `logging` says. That's why the constructor takes `logging`. Drive step 6's specs through that argument, not `process.env`.
- **Postgres error messages quote input** (`invalid input syntax for type uuid: "<value>"`), and `course.controller.ts:169` has no UUID pipe. Never log `message` from a query error.
- **E2E scripts:** check in step 10 that none parses plain-text log lines before switching the format.
- **This plan folder isn't security-sensitive.** Commit it on your branch, staging paths explicitly. Several plan folders are untracked, so never `git add -A`.
- **Environment:**
  - export the node PATH first: `export PATH="/home/kal/.local/opt/node22/bin:$PATH"`;
  - Postgres is on host port 55432;
  - pnpm installs need `--store-dir /home/kal/snap/code/current/.local/share/pnpm/store/v3`;
  - production is off-limits;
  - e2e and Playwright run on `.env.example` values only, never `api/.env`'s real keys. Never export `api/.env.example` into the shell for `next start` (its `NODE_ENV=development` breaks ISR). Run one Playwright suite at a time.

## How to run
- **Build and tests:** `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`.
- **E2E:** the CI scripts locally (`demo-seed`, `e2e-revisions`, `e2e-institution`, `e2e-payments`, `e2e-smoke`), then the Playwright suite.
- **Trace drill (step 8):** with the stack up and `LOG_FORMAT=json`:
  - buy a free course through the gateway with a fixed UUID `x-request-id`;
  - `grep` that id across `.devlogs/*.log`;
  - run the email-regex grep from step 8, which should find only masked addresses or none;
  - record both results in Progress.

## Branch
Create `feat/observability` from the tip of the stack when it starts (expected `fix/calls-and-jobs`, 9c). Don't push until everything below has merged; then `git merge origin/main`.

## Rollout (the user's)
- **Before merge (read-only):** the user confirms in the Render dashboard that the notification service has `SMTP_HOST` or `BREVO_API_KEY` set. Otherwise the new guard stops that deploy.
- **Env:** none required. The defaults follow `NODE_ENV`.

## Definition of done
- The acceptance criteria are met.
- The trace drill and the no-email grep are recorded in Progress.
- Build, tests, typecheck and `db:check` pass, and the CI e2e scripts and Playwright pass locally.
- The checklist is ticked, with deviations logged.
- Then request code review from ethio-reviewer.

## Amendment 2026-10-03 (ethio-planner [aeff2b]): parallel tracks
- Phase 10 (web) and 11a (CI gates) now run in parallel from `origin/main`. **If 11a has merged** when you merge `origin/main`: add your own short section to `docs/DEPLOYMENT.md` (and your env vars to the env examples, if 11a's versions lack them), and keep `pnpm -C api lint` at or under `.github/lint-baseline.json` (fix new warnings rather than raising the baseline).
- The local stack is shared by every track: builds and unit tests run any time; the stack gate only in your window. Ask the current holder and hand it on when done.

## Amendment #2 2026-10-03 (ethio-planner [31d0d2]): early start for ethio-impl [796289]
- **Where:** a new worktree `../ethi0-9d`. Branch `feat/observability` from the `fix/calls-and-jobs` (9c) tip, currently `2ff6677`. Then `git merge fix/outbox` to get 9b's OutboxService and migrations (957d59e, 3f50dd3), which 9c doesn't have yet.
- **Keep current:** merge `fix/outbox` and `fix/calls-and-jobs` again whenever they move. Merge only, never rebase. Their owner is ethio-impl [572e5c] for 9a+9b and ethio-impl [9be294] for 9c. Never commit in their worktrees.
- **Order:** start with the steps that only need what's already there: the context store on 9a's `currentEvent()`, the JsonLogger, redaction, the gateway access line and the notification boot guard. Leave the parts that touch 9b's converted emit sites (9b step 4) and 9c's job runners (9c step 5) until those land on their branches.
- **Ships after 9a, 9b and 9c have merged.** Don't push and don't open a PR before then. Then run `git merge origin/main` (no rebase), run the gate, and send the code review to ethio-reviewer.
- **Stack window:** shared, as above. Phase 10 ([688c71]) and 11a ([066aad]) hold it in turn now. Builds and unit tests run any time.
- Report progress and the plan's Deviations to "ethio-planner [31d0d2]".
