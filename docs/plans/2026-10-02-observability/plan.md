# Phase 9d: Observability

Status: in progress (ethio-impl [110afc], which took over from [796289]; worktree `../ethi0-9d`); steps 1–9 done; approved in round 2, drift check vs 9a D1–D3 folded in
Size: L (sessions: 4 — ethio-impl implements, ethio-plan-review reviews the plan, ethio-reviewer reviews the code). Cross-cutting: common, the gateway and every service's logs.
Base branch: `fix/calls-and-jobs` (9c), or `origin/main` once it has merged. This phase builds on 9a's per-event context store, 6a's `internalPath` client and 9c's typed client errors. · Feature branch: `feat/observability`
Roadmap: phase 9d. 9a's "Roadmap change" planned one 9d for observability and read paths together. It is split again: this plan is observability, and 9e is read paths (P1-22, P2-04), for the same reviewability reason as Phase 8's split. Findings: P1-21; the Phase 2 review note that the slow-query log prints parameter values; the console email provider's lack of a production guard (part of P1-21).

## Goal
"Learner X paid but isn't enrolled" should be answerable from Render's logs in minutes:
- one id follows a request from the gateway through every service it touches and every event it causes;
- logs are structured;
- no log line carries an email address, a password-reset link or a query parameter value;
- a misconfigured production can never print account-takeover links.

Acceptance criteria:
- **One id per request:**
  - the gateway accepts an incoming `x-request-id` only when it is a UUID, otherwise generates one, forwards it upstream, and returns it in the response;
  - services read it, include it on every log line made while handling that request, forward it on internal calls, and use it as the `correlation_id` of every event published while handling it;
  - consumers log the `correlation_id` and carry it into their own calls and events.
- **Access log:** the gateway writes one JSON line per request (method, path with emails and tokens redacted and no query string, status, duration ms, user id when authenticated, upstream service, request id). Proxy errors log the same fields plus an error code. No invite token, pay-request token or encoded email ever appears in a logged path.
- **JSON logs in production:**
  - every service and the gateway log one JSON object per line (`ts`, `level`, `service`, `context`, `msg`, `request_id`, `event_id` when set, `stack` on errors);
  - `LOG_LEVEL` filters;
  - local dev keeps readable output (`LOG_FORMAT=pretty`, the default outside production).
- **No personal data in logs:** none of these logs an email address (masked as `a***@example.com` where an address is genuinely useful):
  - `auth.service.ts:189`;
  - `notification.service.ts:698`;
  - `sponsorship.service.ts:421`;
  - `payment.service.ts:260`;
  - the internal client's path logs and thrown messages.

  A test fails the build if a `logger.*(` call, multi-line calls included, interpolates an identifier matching `/email|^to$|recipient/i` outside `maskEmail(` (decision 4).
- **Slow queries without values:** the slow-query log prints the SQL (truncated to 1,000 characters) and the duration, never parameter values. Query errors stay unlogged by TypeORM, as today (Nest's exception handler and 9c's `DbErrorFilter` report them). `DB_LOGGING=true` prints queries without values and query errors as SQLSTATE code plus constraint name, and is refused in production.
- **No console email in production:**
  - a production boot of the notification service refuses to start unless a real provider is configured (`BREVO_API_KEY`, `SMTP_HOST` or `RESEND_API_KEY`), the same fail-fast as Phase 3's production config;
  - in development the console provider still prints the body, so local sign-up links work.

## Non-goals
- **Shipping logs to a third-party service** (Datadog, Logtail), metrics endpoints or tracing (OpenTelemetry). Render keeps logs, and JSON lines are searchable there. Adding a drain later is configuration.
- **RED metrics dashboards.** The access log carries status and duration; aggregation is a later concern.
- **Read paths and N+1 calls** (9e).
- **Changing what is stored in `notification_log.recipient`.** It's a database column for delivery records, not a log.
- **Web logging.** The browser has no server logs. Vercel logs the Next server, which logs nothing personal today.

## Current state
At `2cdccf9`, plus 6a, 9a, 9b and 9c.

- **Loggers:** no custom logger, `LOG_LEVEL` or JSON anywhere. Services boot via `bootstrapService` (`packages/common/src/bootstrap.ts:30`), the gateway via its own `NestFactory.create` (`gateway/src/main.ts:71`). Nest's default ConsoleLogger prints ANSI free text.
- **Gateway** (`gateway/src/main.ts`):
  - `http-proxy-middleware` (`:134-157`), with no request id and no access log;
  - the proxy error logs only `err.message` (`:147`);
  - the middleware order is prefix, route, strip `x-user-*` and `x-internal-token`, stamp the internal token, internal-route check, JWT, rate limits, proxy (`:166-229`).
- **Services:** nothing reads a request id. `user-context.ts:17-19` reads `x-user-*`.
- **Events:** the envelope's `correlation_id` is random (`event-bus.service.ts:171`) except on Phase 4's payment paths (`payment.id`). 9a adds an `AsyncLocalStorage` event context (`currentEvent()`) around every handler.
- **Emails in logs:**
  - `auth.service.ts:189` (new Google learner);
  - `notification.service.ts:698` (failed email, recipient and provider text);
  - `sponsorship.service.ts:421` (claimed seats);
  - `payment.service.ts:260` (Chapa rejected an email);
  - the internal client logs and throws with the full path, which is `…/users/by-email/<email>` for `sponsorship.service.ts:533` and `growth.service.ts:353`. 9c's typed errors already drop the path from messages; its debug logs still need the redaction.
  - `auth/src/seed.ts:42` is a CLI seed `console.log`, out of scope.
- **`ConsoleEmailProvider`** (`notification/src/email.provider.ts:97-113`) prints recipient, subject and the full body, including verify, reset and invite links. It is selected whenever none of `BREVO_API_KEY`, `SMTP_HOST` or `RESEND_API_KEY` is set (`:203-208`), with no production check. `email.provider.spec.ts:22` expects that default. `assertProductionConfig` doesn't know about email.
- **Slow queries:**
  - `typeorm.ts:56-58`: `logging: DB_LOGGING ? true : ['schema']`, `maxQueryExecutionTime: DB_SLOW_QUERY_MS (500)`, with no custom logger;
  - TypeORM's default logger prints a slow query with `-- PARAMETERS: [...]`, which leaks emails and reset tokens (`auth.service.ts:274,294,318` look users up by token);
  - `schema-check.ts:23` sets its own `logging: false`.

## Design and key decisions
1. **One context store for requests and events:**
   - 9a's `AsyncLocalStorage` becomes `requestContext` in `packages/common/src/context.ts`, holding `{ request_id?, user_id?, event_id?, event_type?, correlation_id? }`. `currentEvent()` stays as a view onto it.
   - **HTTP:** a middleware registered first in `bootstrapService`:
     - reads `x-request-id` only if it is a UUID (`isUuid` in common), otherwise generates a UUID. Reason (review B2): the id becomes the event's `correlation_id`, which 9b stores in a `uuid` column, so a non-UUID id such as nginx's 32-hex `$request_id` or `checkout-1` would fail every outbox insert in that request with 22P02;
     - runs the rest of the request inside `requestContext.run(…)`;
     - sets the `x-request-id` response header.
   - **Events:** the 9a dispatcher sets `event_id`, `event_type` and `correlation_id`, and also `request_id = correlation_id` when it is a UUID (otherwise a fresh UUID, the same rule as HTTP), so everything a consumer logs or calls carries the original request's id.
   - **Background work starts outside any request:** 9a's connection supervisor and 9c's job runners start under `requestContext.exit(…)`, so a reconnect set off by a `publish()` inside a request doesn't stamp that request's id on later connection logs (review N3).
   - **Outgoing:**
     - the internal client adds `x-request-id` from the context;
     - `publish`/`publishConfirmed` default `correlationId` to `request_id`, so an explicit one (Phase 4's `payment.id`) still wins;
     - 9b's `emit` stores the same correlation id on the outbox row.
   - Rejected: passing the id through function arguments (hundreds of signatures) or cls-hooked (deprecated; `AsyncLocalStorage` is built in).
2. **Gateway: request id, access log, proxy errors:**
   - **First middleware:** the same `x-request-id` rule, stored on `req`, set on the proxied request (`proxyReq.setHeader`) and on the response.
   - **Access line** on `res.on('finish')`, with fields:
     - `request_id`, `method`;
     - `path`: `redactPath(req.path)` from common (also used by the internal client). It drops the query string, then decodes each segment (`decodeURIComponent` in a try/catch; an undecodable segment counts as a token) and replaces:
       - an email-shaped segment (`name@domain` after decoding, so `name%40domain` too) with `[email]`;
       - the segment after a token-bearing parent (`TOKEN_PARENTS = ['invite', 'pay-requests']`, from `auth.controller.ts:66` and `growth.controller.ts:264,269`) with `[token]`;
       - any other non-UUID segment of 32 or more hex characters with `[token]`, as a catch-all for future hex tokens.

       Rejected: logging the route template. The gateway proxies by prefix and doesn't know the downstream templates. Course slugs and certificate uids stay readable: certificate uids are public verification codes by design.
     - `status`, `ms`;
     - `user_id`, only from a verified JWT;
     - `upstream`: the route's service name;
     - `ip`: Express's `req.ip` with trust proxy 1, as the rate limiter uses it.
   - **Health:** `/health` and `/ready` are logged only on a non-200, to keep wake pings and probes out of the log.
   - **Proxy errors** log the same fields plus `error_code` (`ECONNRESET`, `ETIMEDOUT`, …), never the upstream URL with credentials.
3. **JSON logger:**
   - `JsonLogger implements LoggerService` in common, passed to `NestFactory.create(…, { logger })` by `bootstrapService` and the gateway.
   - **Each line:** `{ ts, level, service, context, msg, request_id?, user_id?, event_id?, stack? }`, one per call, written with `process.stdout.write`.
   - **Errors:** `Logger.error(msg, stack)` maps to `stack`. An `Error` passed as the message is serialized as `msg` plus `stack`.
   - **Settings:** `LOG_FORMAT=json|pretty` (default `json` when `NODE_ENV=production`, else `pretty`, which delegates to Nest's ConsoleLogger), and `LOG_LEVEL=error|warn|log|debug|verbose` (default `log`).
   - No library: pino would mean replacing Nest's `Logger` calls or an adapter, and Nest's `LoggerService` interface is enough for one JSON line.
4. **No personal data in logs:**
   - **`maskEmail(email)`** in common: first character, `***@`, then the domain.
   - **The listed lines change:**
     - `auth.service.ts:189` logs the user id;
     - `notification.service.ts:698` logs `user_id`, the event type and the masked recipient, with the provider's reason run through a redaction that replaces any email-shaped substring;
     - `sponsorship.service.ts:421` logs the count and the user id;
     - `payment.service.ts:260` logs the payment id and "email rejected, retrying with the fallback".
   - **The internal client's debug and warn logs** use `redactPath` (decision 2), so `users/by-email/name%40domain` logs as `users/by-email/[email]`. 9c's error messages already omit the path.
   - **Provider failure bodies:** the Brevo and Resend failure logs (`email.provider.ts:60,90`) run the provider's body through the same email-substring redaction as the notification reason (review N1).
   - **Guard test** (`packages/common/src/logging/no-pii-in-logs.spec.ts`): it scans `api/services` and `api/gateway` sources for each whole `logger.(log|warn|error|debug|verbose)(…)` call, multi-line calls included (from the opening parenthesis to its matching close). It fails on any call that interpolates or concatenates an identifier matching `/email|^to$|recipient/i` (so `customerEmail` and `recipient_email` too) outside `maskEmail(`. It's cheap, catches the common mistake, and its message names the file and line (review N2).
   - **Token-route guard** (same spec file): it scans controllers for route params named like `/token|secret/i` and fails unless the segment before the param is in `TOKEN_PARENTS`. A new token route can't reach the access log unredacted without the build failing.
5. **TypeORM logger without parameters:**
   - `SafeTypeOrmLogger` in common implements TypeORM's `Logger`:
     - `logQuerySlow(time, query)` → warn `slow query {ms} ms: {sql truncated}`, ignoring parameters;
     - `logQueryError(error, query)` honours `logging` like TypeORM's own loggers: with today's `['schema']` it logs nothing, so expected unique violations (`membership.service.ts:87-90,151-153,215-217`, 9c's race guards) don't become error lines. With `DB_LOGGING=true` it logs the SQLSTATE code, the constraint name and the truncated SQL, never the error `message` (Postgres quotes the input in messages such as `invalid input syntax for type uuid: "<value>"`) and never parameters (review S1);
     - `logQuery` prints SQL only when `DB_LOGGING=true`;
     - `logSchemaBuild`/`logMigration` → log.
   - `buildTypeOrmOptions` sets `logger: new SafeTypeOrmLogger(schema, logging)`, passing the same `logging` value it sets on the data source so the logger can honour it, and keeps `logging` and `maxQueryExecutionTime` as today (round 2 nit).
   - `assertProductionConfig` refuses `DB_LOGGING=true` in production.
6. **Email provider in production:**
   - The notification service's `productionRules` (Phase 3's mechanism) require at least one of `BREVO_API_KEY`, `SMTP_HOST` or `RESEND_API_KEY` when `NODE_ENV=production`. The boot error names the variables, never their values.
   - `ConsoleEmailProvider` also refuses to construct in production, as a second line in case the rule is bypassed.
   - In development it still prints the body, so local sign-up and reset links work.
   - `email.provider.spec.ts` keeps its default-to-console case for development and adds the production refusal.

## Configuration
In `api/.env.example`, with comments:
- `LOG_FORMAT` (`pretty` locally; `json` is the production default);
- `LOG_LEVEL=log`.

No change to `render.yaml` is needed (the defaults follow `NODE_ENV`). The user confirms a real email provider is set before deploy (Rollout).

## Steps
- [x] 1. Branch `feat/observability` from `fix/calls-and-jobs`.
- [x] 2. Context store (decision 1): `requestContext`, the HTTP middleware, the 9a dispatcher integration, the internal-client header, the bus correlation default, 9b's outbox correlation.
  - Specs:
    - a request with a UUID id keeps it; a non-UUID one (`checkout-1`, a 32-hex id) gets replaced, and a request that emits through 9b's outbox still commits;
    - an event whose `correlation_id` isn't a UUID gets a fresh `request_id` in the consumer;
    - the bus connection supervisor's logs carry no request id;
    - a log inside a handler and an internal call carry the id;
    - an event published in the request has `correlation_id` = request id;
    - a consumer's internal call carries the same id.
  - **Drift D3:** 9a's `eventContext` is `{ event_id, event_type, correlation_id, handler }`. Add `handler?` to `requestContext`'s shape and put it on JSON lines when set.
- [x] 3. `JsonLogger` (decision 3), wired into `bootstrapService` and the gateway. · Specs: JSON shape, level filtering, `stack` on errors, pretty mode delegating.
- [x] 4. Gateway request id, access log and proxy error fields (decision 2). · Specs on the extracted middleware:
  - the id is propagated and echoed;
  - the access line has the fields;
  - `redactPath` cases: `/api/v1/auth/invite/<64 hex>` → `/api/v1/auth/invite/[token]`; `/api/v1/pay-requests/<token>/pay` → `/api/v1/pay-requests/[token]/pay`; `/internal/users/by-email/name%40example.com` → `/internal/users/by-email/[email]`; a bare 40-hex segment → `[token]`; a UUID and a course slug unchanged; the query string stripped; a malformed `%E0%A4%A` segment → `[token]` without throwing;
  - `/health` 200 is not logged.

  If the middleware is still inline in `bootstrap()`, extract it into `gateway/src/request-log.ts` so it's testable (Phase 11's P1-29 extracts the auth middleware the same way).
- [x] 5. PII (decision 4): `maskEmail`, the listed lines, the internal-client redaction, the provider-body redaction, the PII guard and the token-route guard. · Guard spec fixtures: a multi-line `logger.warn(` call with `customerEmail` fails; the same wrapped in `maskEmail(` passes; a controller with `@Get('reset/:token')` fails the token-route guard.
  - **Drift D1:** the listed lines also include 9a's dedupe skip, `notification.service.ts:690` (`… to ${to} already sent …`): log the masked recipient or the user id. The failed-email line is now `:698`.
  - **Drift D2:** the bus's retry (warn) and park (error) logs and the parked message's `x-last-error` header print `errorText(err)` raw (`event-bus.service.ts:393,413,441`, `errorText` at `:492`), and SMTP/Brevo/Resend errors quote the recipient. Run `errorText` through decision 4's email-substring redaction, once, in the bus, so every handler's error is covered. Spec: a handler throwing "…<a@b.com>…" logs `[email]`, and `x-last-error` has no address.
- [x] 6. `SafeTypeOrmLogger` and the `DB_LOGGING` production refusal (decision 5). · Specs:
  - a slow query log line contains the SQL and no parameter value. Run a deliberately slow `SELECT pg_sleep(0.6), $1` with an email-shaped parameter;
  - built with `logging: ['schema']` (the constructor argument, not `process.env`), a query error (a 23505 and a 22P02 from `SELECT $1::uuid` with an email-shaped value) logs nothing;
  - built with `logging: true` (what `DB_LOGGING=true` sets), the same 22P02 logs the code and the SQL, and not the value.
- [x] 7. Email provider production guard (decision 6), plus the spec updates.
- [x] 8. Local trace drill: with the stack up and `LOG_FORMAT=json`, buy a free course through the gateway with a fixed `x-request-id`, then `grep` that id across `.devlogs/*.log`.
  - Expect lines from the gateway, enrollment (the enroll), the `EnrollmentCreated` consumers in course and notification, and their internal calls.
  - Run `grep -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' .devlogs/*.log`: only masked addresses or none.
  - Record the result in Progress.
- [x] 9. Docs: `docs/DEPLOYMENT.md` "Logs" section: the line format, `LOG_LEVEL`, following one request by `request_id` in Render's log search, and what is never logged.
- [ ] 10. Full gate:
  - `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`;
  - the CI e2e scripts and Playwright locally. The scripts read some log output: check that `e2e-smoke.mjs` and the others don't parse plain-text log lines; adjust them if they do.
- [ ] 11. Code review by ethio-reviewer; the user approves push and PR.

## Test plan
- **Unit:** the context (step 2), the logger (step 3), the gateway middleware (step 4), the PII guard and `maskEmail` (step 5), the TypeORM logger (step 6), the email provider guard (step 7).
- **Drill:** the request trace and the no-email grep (step 8).
- **Regression:** all api specs, the CI e2e scripts, Playwright.

## Rollout and ops
- **Before merge (the user, read-only):** confirm in the Render dashboard that the notification service has `SMTP_HOST` or `BREVO_API_KEY` set. Emails deliver today (PR #16), so it should, but the new guard would stop a deploy without it.
- **After deploy:** Render's log search for `"request_id":"<id>"` follows a request across services. Log volume grows by one access line per request; health probes aren't logged.
- **Env:** none required.

## Risks and open questions
- **Log volume on the free tier:** Render's free log retention is short, and one line per request is the standard trade.
- **The PII guard is a grep,** so it can miss an email in a non-obvious variable. The masking helper and the reviewed list cover the known sites. The guard stops the common regression, not every possible one.
- **The context store crosses async boundaries** that `AsyncLocalStorage` handles (promises, timers), but not callbacks from libraries that pool their own async resources. amqplib's consume callback is entered explicitly by 9a's dispatcher, which runs `requestContext.run` itself.

## Progress and deviations (implementer)

### Progress (2026-10-03)
- **Base:** `feat/observability` from 9c `2ff6677`, then `fix/outbox` merged (`b55f76e`, which carries 9a `6d082bb`). Since then `fix/outbox` (`0d39ec3`, the 9b early-read fixes) and `fix/calls-and-jobs` (`2f31a0d`, 9c steps 2, 4, 7, 8 and 10) are merged in.
- **Step 2** `10b8617`: `requestContext` in `common/src/context.ts`, with `currentEvent()` as a view onto it, `isUuid`/`requestIdFrom` and `requestContextMiddleware`, registered first in `bootstrapService`. Also the dispatcher (request id from `correlation_id`), the publish and outbox correlation defaults, and the internal client's `x-request-id`. Specs: `context.spec.ts`, the bus "request context (Phase 9d)" block, the outbox middleware-to-emit case and the internal client header.
- **Step 3** `9844180`: `JsonLogger` in `common/src/logging/json-logger.ts`, wired into `bootstrapService` and the gateway; `LOG_FORMAT` and `LOG_LEVEL` in `api/.env.example`.
- **Step 4** `0018ef6`:
  - `redactPath`, `maskEmail` and `redactEmails` in `common/src/logging/redact.ts`;
  - `gateway/src/request-log.ts` (the id, the access line, `accessNotes` for `user_id`, `upstream` and `error_code`) and `upstreamOf` in `routes.ts`;
  - smoke check of the built gateway with `LOG_FORMAT=json`: no `/health` 200 line, a 404 line, `checkout-1` replaced, an upper-case UUID kept lower-cased, `invite/[token]`, and a 502 with `error_code: ECONNREFUSED` and no upstream URL.
- **Step 5** `f22cee6`:
  - the listed lines (auth Google learner, sponsorship claim, payment fallback, notification dedupe skip and failure line);
  - the console provider's `To:`;
  - the Brevo and Resend failure bodies;
  - the bus's `errorText` (D2);
  - the internal client's failure logs (`redactPath`);
  - `no-pii-in-logs.spec.ts` (the PII guard on the TypeScript AST, plus the token-route guard).
- **Step 6** `64ae63d`:
  - `SafeTypeOrmLogger(schema, logging)` in `buildTypeOrmOptions`, and `(schema, false)` in `buildSchemaCheckOptions`;
  - `DB_LOGGING` refused in `productionConfigProblems`;
  - a unit spec, plus `safe-typeorm-logger.db.spec.ts` on real Postgres. That one passed locally on a scratch `el_verify_9d_logger` (dropped afterwards), and CI runs it in the existing scratch-DB step next to the resend-verification spec.
- **Step 7** `343516f`: `emailProductionRules` as the notification service's `productionRules`; `ConsoleEmailProvider` throws in production.
- **Step 9** `27a22dd`: the "Logs" section, appended to `docs/DEPLOYMENT.md`. When 11a's rewrite of that file reaches the branch, it moves into 11a's structure.
- **Merged head:** `pnpm -C api build`, `typecheck` and `test` all green: 79 suites, 1467 passed, 4 skipped (the opt-in Postgres specs).
- **Step 8** (drill, 2026-10-03, at `b6ef5ec`): run on a fresh `el_e2e_9d` with `LOG_FORMAT=json`, the `api/.env.example` env and mock Chapa, then `demo-seed.mjs`.
  - As learner@, `POST /api/v1/enrollments` for a free course not yet enrolled, with `x-request-id: 308f3735-0a2c-4280-852b-7b74dbb903f1`: 201, and the response echoed the id.
  - `grep` of that id across `.devlogs/*.log` found 7 lines:
    - gateway (4): the `POST /api/v1/enrollments 201` access line, plus the internal calls it caused (`internal/courses/<id>` from enrollment, and `internal/users/<id>` and `internal/educators/<id>` from notification's consumer);
    - enrollment (1): `published EnrollmentCreated`;
    - notification (2): the consumer's dev email (`To: l***@…`) and `published NotificationSent`, with `handler: notification:EnrollmentCreated:0`.
  - Course's `EnrollmentCreated` consumer logs nothing on success, so it has no line to find. Its internal calls would carry the id, like notification's do.
  - Email grep over every log line of the run (seed included): 23 addresses, all masked (`e***@…` 17, `l***@…` 6), and 0 unmasked.
  - Not a finding: a first try re-enrolled the course the seed had enrolled. That returned an idempotent 201 and published nothing, so the drill now skips enrolled courses.
  - Outbox rows: none yet. 9b step 4 hasn't converted the emit sites, so events still publish directly. Repeat this check after that merge.


### Deviations
1. **The PII guard skips names ending in `_id`/`Id`(s).** The plan's `/email|^to$|recipient/i` flags `recipient_user_id` (`enrollment.service.ts:550`), which is a user id, not an address.
2. **The guard uses the TypeScript AST,** not a paren scanner. It counts the value an argument interpolates (`user.email`, `message.to`, `{ email }`). It skips:
   - receivers (`this.email.name`);
   - callees (`maskEmail(…)` itself);
   - object keys and arrow parameters.
3. **Request ids are lower-cased.** Postgres stores `uuid` lower-case, so the outbox's `correlation_id`, the consumers' `request_id` and the gateway's line agree when grepped.
4. **The supervisor's context:** 9b's S2 fix (`3555c6f`) runs `kick()` under an `AsyncLocalStorage.snapshot()` taken when the bus is built, which covers `requestContext` too. My `requestContext.exit` in `kick()` was dropped in the merge (planner's note). The spec "connects outside the request whose publish started the connection" still passes.
5. **The bus's retry and park handling run inside the handler's context:** the dispatcher calls a new `runHandler()` inside `requestContext.run`. Those log lines carry the request id too.
6. **How the gateway forwards the id:** it sets `req.headers['x-request-id']`, which the proxy copies (the same way it sets `x-user-*`), instead of `proxyReq.setHeader`. It also runs `next` inside `requestContext`.
7. **The proxy error has no separate line any more.** The access line carries `error_code` and is logged at error level when `error_code` is set or the status is 5xx: one line per request.
8. **The internal client logs `redactPath(path)` on failures,** instead of 9c's "path length". The useful part of the path stays readable. A refused (invalid) path still logs only its length, since that value may be attacker-controlled.
9. **The console email provider masks `To:` in development too,** so the guard needs no exemption. The body, with its links, still prints.
10. **A bad `LOG_FORMAT` or `LOG_LEVEL` value fails the boot** and names the allowed values (the `envInt` style).
11. **A service's `user_id` in the context** comes from the gateway's `x-user-id`. Handlers only run after the internal-token check.

### In flight / next step (checkpoint 2026-10-03 ~23:00, ethio-impl [110afc]; work resumes Monday 2026-10-05 afternoon)
- **Head:** `feat/observability` in `../ethi0-9d`, local only, not pushed. It has merged `fix/outbox` `602ef8e` and `fix/calls-and-jobs` `2f31a0d`. On `604aaba`: api build and typecheck green, and `pnpm -C api test` passes (80 suites, 1468 passed, 4 skipped).
- **Done this session:**
  - the early read's N1 (`ffe1896`: the PII guard also scans `packages/*/src`);
  - the step 8 drill (see Progress).
- **Stack:** the drill backend is stopped (ports 4000 and 4101–4107 free) and `el_e2e_9d` is dropped. The docker compose containers (postgres, rabbitmq, redis, minio) are left up; they're shared. [688c71] (Phase 10) said it doesn't need the stack again unless its review asks for a re-run.
- **Waiting on peers.** Merge each when it lands, rerun the guard spec and the api tests, and check their new log lines against the guard:
  - 9b step 4 (converted emit sites). Then repeat the drill's outbox check: the row's `correlation_id` equals the request id;
  - 9c step 5 (job runners must start outside a request, through 9b's snapshot pattern or `requestContext.exit`).
- **Then:**
  - step 10, the full gate, on the final head once 9a, 9b and 9c are on `main` (`git merge origin/main`);
  - step 11, code review round 1 by ethio-reviewer [93b6fc]. Report to ethio-planner [31d0d2].
- **11a:** when it merges, move the "Logs" section into its `docs/DEPLOYMENT.md` structure, resolve `ci.yml` (keep the `safe-typeorm-logger.db.spec.ts` addition), and keep `pnpm -C api lint` under the baseline (the `_parameters` args in `SafeTypeOrmLogger`).
- **Rollout item:** the user's Render check for an email provider on the notification service is `USER-ACTIONS.md` "Start here" item 4 ("Phase 9d, confirm the notification service has an email provider"). It blocks 9d's merge. ethio-planner passes on the user's answer.
- **Drill script:** `node <scratch>/9d-trace.mjs` (session scratchpad, not in the repo). It logs in as learner@, skips enrolled courses, enrols with a fresh UUID `x-request-id`, and prints it.
