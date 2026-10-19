# Phase 9d: code review (ethio-reviewer)

## Early read (before round 1, 2026-10-03)
ethio-planner asked for this. It isn't a review round and has no verdict, and round 1 still covers the whole diff after `git merge origin/main`.

**What I read:** 9d's own commits, `git log -p --no-merges feat/observability ^fix/outbox ^fix/calls-and-jobs`, up to `9b22e23`:
- `10b8617` request context;
- `9844180` JSON logger;
- `0018ef6` gateway access line and `redact.ts`;
- `f22cee6` PII lines and the guards;
- `64ae63d` `SafeTypeOrmLogger`;
- `343516f` email boot guard;
- `27a22dd` docs;
- the deviations 1–11 in `plan.md`.

`00f5e06` is docs only. The `fix/outbox` merge (`604aaba`) is 9b's.

**My gate, run in the review worktree `../ethi0-review-6a` detached at `9b22e23`, with common rebuilt:**
- jest on common `logging`, `context`, `events`, `http`, `config` and `safe-typeorm-logger.spec`, `gateway/src` and `services/notification`: 26 suites, 355 passed;
- the lockfile differs from my last install only by 9c's chapa-nestjs removal, which none of these specs touch.

**No blockers and no should-fixes.** The three focus areas:

### Redaction
- **`redactPath`:**
  - drops the query and the fragment, and decodes each segment before testing it;
  - `name%40domain` → `[email]`; an undecodable segment → `[token]`; `invite/:token` and `pay-requests/:token(/pay)` → `[token]`; other 32+-hex non-UUID segments → `[token]`.
  - I listed every parameterized route in services and the gateway. The only credential-bearing ones are those two, plus `users/by-email/:email`, which the `@` rule covers. Verify and reset tokens travel in the query string or the body, so they're never in a logged path.
- **The listed sites:**
  - auth Google sign-in now logs the user id;
  - the sponsorship claim logs the count and the user id;
  - the Chapa fallback logs the payment id;
  - notification's dedupe skip and failure lines use `maskEmail(to)` and `redactEmails(reason)`;
  - the Brevo and Resend bodies go through `redactEmails`;
  - the bus's `errorText`, which also feeds `x-last-error`, is redacted;
  - the internal client logs `redactPath`, and only the length of a refused path.
- **Other log lines:** I grepped every logger call for url, link, token, secret and password. None prints a value. Google's tokeninfo failure logs the `fetch` error message, which doesn't contain the URL with the `id_token`.
- **Query logger:** `SafeTypeOrmLogger` never prints parameters or a query error's `message`. `DB_LOGGING` is refused in production with the same `true`/`1` test that `envBool` uses. `DbErrorFilter`'s mapped codes log only the code and the table.
- **Guard (deviations 1 and 2):** the AST guard is better than the paren scanner the plan described, and skipping `*_id` names is right. `console.*` isn't scanned, but the only `console.warn` outside seeds and tests (`packages/ai`) prints a model name.

### Request id propagation
- **HTTP:** the gateway's `requestLog` is its first middleware. In the services, `requestContextMiddleware` runs before the token check and the body parser.
  - I checked the body parser with a real Nest 10 app on this lockfile's `@nestjs` packages. A POST handler still sees the context, both with and without `rawBody` (raw-body 2.5.3 binds its callbacks).
  - The gateway's `finish` handler also sees the right request when the proxy reuses a keep-alive upstream socket. I tested three sequential requests through `http-proxy-middleware` 3 with a `keepAlive` agent: Node's agent resets each reused socket's async context. So the access line's `request_id` is never a neighbour's.
- **Internal calls:** they carry `x-request-id` from the context, and the gateway keeps it because it's a UUID. A whole chain logs one id.
- **Events:**
  - published events default `correlation_id` to the request id, and Phase 4's explicit `payment.id` still wins;
  - `emit` stores the same id on the outbox row, and the relay re-sends it;
  - the dispatcher runs each handler (and its retry and park logging, deviation 5) under `request_id = requestIdFrom(correlation_id)`, computed once per message.
  - Every id is a lower-cased UUID (deviation 3), so the outbox `uuid` column can't reject one.
- **Supervisor (deviation 4):** 9b's `AsyncLocalStorage.snapshot()` in `kick()` replaces the `requestContext.exit`, and it covers every store. The relay's timer starts at bootstrap, outside any request.

### Boot guard
- **The rule:** `emailProductionRules` requires `BREVO_API_KEY`, `SMTP_HOST` or `RESEND_API_KEY` in production. Those are exactly the variables `emailProviderClass` selects on, so a boot that passes the rule never gets the console provider.
- **The backstop:** the console provider throws in its constructor in production. It's built eagerly through `useClass`, so a bypass of the rule still fails the boot and doesn't send.
- **Logging settings:** a bad `LOG_FORMAT` or `LOG_LEVEL` fails the boot and names the allowed values (deviation 10).
- **Rollout:** the user confirms the provider variable on Render (plan Rollout). That item isn't in `docs/plans/USER-ACTIONS.md` yet; ethio-planner should add it before the merge.

### Nit
- **N1. The PII guard scans `services/` and `gateway/` but not `packages/`.**
  - Today common's log lines are safe through redaction at known sites (the bus, the outbox, the internal client).
  - Adding `packages/*/src` to `scanned()` would catch a future slip there for free, if common passes as it is.
  - Optional.

### For round 1
- the step 8 trace drill;
- 9b step 4's converted sites and 9c step 5's job runners after the merges: their new log lines pass the guard, and the runners start outside a request;
- the full api gate on the merged head.
