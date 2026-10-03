# Plan review: Phase 9d, observability

## Round 1 (2026-10-03) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)"), against the code at `2cdccf9` and the 9a, 9b and 9c plans it builds on.

Verified as the plan states:
- **Context through the body parser:** an `AsyncLocalStorage` context entered before Express's JSON body parser reaches the route handler. I tested this with the repo's express 4.22.1 and body-parser 1.20.4 on Node 22: a POST with a JSON body still sees the store. So registering the middleware first in `bootstrapService` works.
- **The email-provider guard can't block the production boot:** render.yaml's shared env group sets `SMTP_HOST` (`render.yaml:79-80`), and docker compose and CI run with `NODE_ENV=development` (`docker-compose.yml:10`, `api/.env.example`). No e2e script parses log text, so the JSON format can't break them.
- **Code references:** `typeorm.ts:56-58`, the provider selection (`email.provider.ts:203-208`) and the four email log sites are as described.

### Blockers
- **B1. The access log writes credentials and encoded emails from the path** at decision 2 ("path: no query string, with any segment that looks like an email replaced by `[email]`")
  - **Invite tokens:** `GET /api/v1/auth/invite/<token>` (`auth.controller.ts:66`) carries the 64-hex invite token. That token is a 7-day "set your own password" credential, stored in the same `resets` table as password resets (`auth.service.ts:259-265`).
    - Every invitee's browser calls this route when the invite link opens, so the raw token lands in Render's logs.
    - Anyone with log access can then set that account's password before the invitee does.
    - That is the account-takeover link the Goal says production must never print.
  - **Pay-request tokens:** the token in `pay-requests/:token` (`growth.controller.ts:264,269`) is logged the same way.
  - **Encoded emails:** internal calls also go through the gateway. `users/by-email/` is built with `encodeURIComponent` (`sponsorship.service.ts:533`, `growth.service.ts:353`), so the segment reads `name%40domain`, and an `@`-based match misses it. The internal client's own path redaction has the same gap.

  Suggested:
  - log the matched route template;
  - or redact on decoded segments: email-shaped → `[email]`, and the segment after `auth/invite/` and `pay-requests/` → `[token]`. A generic rule works too: any non-UUID segment of 20 or more token characters.
  - Add spec cases for an invite path, a pay-request path and an encoded `by-email` path.

  Response: **fixed.** Decision 2 now uses one `redactPath()` in common for the access log and the internal client. It decodes each segment first (an undecodable one counts as a token), so `name%40domain` becomes `[email]`. The segment after `invite` and `pay-requests` becomes `[token]`, and any other non-UUID segment of 32+ hex characters does too, as a catch-all. I didn't use a route template: the gateway proxies by prefix and doesn't know the downstream templates. I didn't use the generic "20+ token characters" rule either: it would also hide course slugs. A token-route guard spec fails the build when a controller adds a `:token`/`:secret` param under a parent not in `TOKEN_PARENTS`. Step 4 has your three spec cases, plus a malformed-escape case.
- **B2. A non-UUID request id fails every outbox write** at decision 1 (gateway and service id rule, "`publish`/`publishConfirmed` default `correlationId` to `request_id`", "9b's `emit` stores the same correlation id")
  - **The mismatch:** the gateway accepts any `^[A-Za-z0-9-]{8,64}$` id, but 9b's `outbox.correlation_id` is a `uuid` column (9b `plan.md:79`).
  - **The trigger:** a client sends an id that passes the regex but isn't a UUID. Examples: nginx's 32-hex `$request_id`, a mobile SDK, a test tool sending `x-request-id: checkout-1`.
  - **What breaks:**
    - the emitting transaction's insert fails with 22P02 and rolls back (auth signup, enroll, a refund decision, a QO decision);
    - the request returns 400 although the client did nothing wrong;
    - an event published with plain `publish()` carries the bad id onward as `correlation_id`, so a consumer that emits through its own outbox fails, retries and parks.

  Suggested: accept an incoming id only when it's a UUID, otherwise generate one (at the gateway and in services), or make `correlation_id` `varchar(64)`. Add a spec: a non-UUID incoming id is replaced, and an emitting request still commits.

  Response: **fixed** (your first option). The gateway and services accept an incoming `x-request-id` only when it's a UUID, otherwise they generate one. The 9a dispatcher applies the same rule to an incoming `correlation_id` before using it as `request_id`. `correlation_id` stays `uuid`, since 9b's dedupe and indexes assume it. Step 2 specs: `checkout-1` and a 32-hex id are replaced, and a request that emits through the outbox still commits. A non-UUID `correlation_id` gets a fresh `request_id` in the consumer.

### Should-fix
- **S1. `SafeTypeOrmLogger` would start logging every failed query, with input values in the message** at decision 5
  - **Today:** `logging: ['schema']` (`typeorm.ts:56`) keeps TypeORM's default logger from printing query errors at all.
  - **What changes:** a custom `Logger` is called for every `logQueryError`, whatever `logging` says, so decision 5 begins logging at error level:
    - unique violations that callers expect and handle (`membership.service.ts:87-90,151-153,215-217`, plus 9c's race guards);
    - Postgres messages that quote the input, such as `invalid input syntax for type uuid: "<value>"`. `GET /api/v1/courses/<an email>` reaches it, because `course.controller.ts:169` has no UUID pipe, so the email ends up in the log.

  Suggested: honour `logging` inside the logger, so query errors stay off as today. 9c's `DbErrorFilter` and Nest's exception handler already report failures, by code and table. When `DB_LOGGING=true`, print the SQLSTATE code and constraint name, not `message`. Add the 22P02 case to step 6's spec.

  Response: **fixed.** `logQueryError` honours `logging`, so with today's `['schema']` it logs nothing, and expected 23505s don't become error lines. With `DB_LOGGING=true` (dev only; refused in production) it prints the SQLSTATE code, the constraint name and the truncated SQL, never `message` or parameters. The acceptance criterion now says query errors stay unlogged by TypeORM. Step 6 adds the 23505 and 22P02 cases, both with and without `DB_LOGGING`.

  Nits: N1 taken (decision 4, provider failure bodies). N2 taken (the guard scans whole multi-line calls, case-insensitive `email|^to$|recipient`, with fixtures in step 5). N3 taken (decision 1: the bus supervisor and 9c's job runners start under `requestContext.exit`).

### Nits (optional, max 3)
- **N1.** The Brevo and Resend failure logs print the provider's body verbatim (`email.provider.ts:60,90`). Run them through the same email redaction as the notification reason.
- **N2.** Make the guard spec case-insensitive (`customerEmail`, `recipient_email`) and have it scan a whole multi-line `logger.*(` call. Otherwise the shape of `payment.service.ts:260` and the multi-line call at `email.provider.ts:105` slip past it.
- **N3.** Start 9a's connection supervisor outside any request context (`requestContext.exit(…)`). Otherwise a reconnect set off by a `publish()` inside a request stamps that request's id on every later connection log and channel callback outside the dispatcher.

## Round 2 (2026-10-03) · Verdict: APPROVED (checks the round-1 fixes only)
Reviewed: `plan.md` (status "in review (round 2)").

- **B1 resolved.**
  - **Path:** the gateway middleware is mounted at the root (`main.ts:164-165`), so `req.path` at `finish` still holds the full `/api/v1/…` path. `redactPath` sees what the client sent.
  - **Token routes:** every token- or email-bearing route param in the services today is covered:
    - `auth/invite/:token` is 64 hex;
    - `pay-requests/:token` is `randomCode(24)` (`sponsorship.service.ts:80,123`), not hex, so the `TOKEN_PARENTS` rule is what catches it;
    - `users/by-email/:email` is caught as `[email]` after decoding.
  - **Other params:** the remaining route params are UUIDs, the public certificate `uid`s and a knowledge `:title`, which carry no credential.
  - **Guard:** the token-route guard stops a new `:token` route from slipping past.
- **B2 resolved.** The gateway, the services and the dispatcher apply one UUID-only rule. `correlation_id` stays `uuid`, Phase 4's explicit `payment.id` is a UUID, and step 2 has the specs.
- **S1 resolved.** `logQueryError` honours `logging`. `DB_LOGGING` prints the code, the constraint and the SQL, never `message` or parameters, and step 6 tests 23505 and 22P02 both ways.
- **N1–N3:** taken as suggested.

### Nits (optional)
- **N1.** Decision 5's `new SafeTypeOrmLogger(schema)` also needs the `logging` value (`typeorm.ts:56`) to honour it. Pass it to the constructor, and drive step 6's two cases through that argument rather than through `process.env`.

## Drift check vs 9a (2026-10-03)
Not a review round: the plan stays APPROVED. This is a read-only check against 9a as built (`fix/event-delivery` @ `fa06f83`, with its deviations). 9d builds on 9a's event context, dispatcher, supervisor and notification `deliver()`.

### Mismatches
- **D1. 9a added an email-bearing log line that decision 4's list doesn't name.** `deliver()`'s dedupe skip, `notification.service.ts:690`, logs `` `${eventType} to ${to} already sent for event ${eventId}` ``. The failed-email line the plan lists as `:663` is now `:698`. The PII guard matches `to` (`/^to$/`), so step 5's guard would fail the build on `:690` until it's fixed. **Fold in:** add `:690` to the "listed lines change" list (log the masked recipient or the user id) and correct `:663` to `:698`.
- **D2. 9a's retry and park logs and headers print raw error text, which can carry an email address.** A failed send now throws out of `deliver()` (9a), and the bus logs `errorText(err)`:
  - on retry, at warn;
  - on park, at error;
  - in the parked message's `x-last-error` header (`event-bus.service.ts:393,413,441`; `errorText` is at `:492`).

  The provider errors include the provider's text (`email.provider.ts:61` Brevo, `:91` Resend), and SMTP rejections typically quote the address ("550 5.1.1 <a@b.com>: Recipient address rejected"). Decision 4 redacts the reason only in notification's own `:698` line, so the same address would still reach Render's logs through the bus's line. The guard can't catch it, because no identifier is named like an email.
  **Fold in:** run the bus's `errorText(…)` through the same email-substring redaction (decision 4) for its log lines and `x-last-error`. Alternatively, redact in the email providers' thrown messages, which covers both routes. Add one spec: a handler throwing "…<a@b.com>…" logs `[email]`.
- **D3. 9a's context type has a field that 9d's store doesn't list (decision 1).** 9a's store is `eventContext` in `common/src/events/event-context.ts`, shaped `{ event_id, event_type, correlation_id, handler }`. `handler` is the subscribed handler's name, set per handler in the dispatcher (`event-bus.service.ts:401`). Nothing reads it yet, but it's the field a log line needs to name which handler of a multi-handler event it came from. **Fold in:** add `handler?` to `requestContext`'s shape and put it on JSON lines when set, so `currentEvent()` stays a full view.

### Confirmed as the plan assumes
- The dispatcher enters the context per handler with `eventContext.run(context, () => handler.fn(…))` (`event-bus.service.ts:399-402`), the one place step 2 changes. The supervisor loop (`kick()` → `setImmediate`, `:157-170`) is the background start that decision 1 wraps in `requestContext.exit`.
- `publish(type, payload, correlationId?)` and `publishConfirmed(type, payload, { correlationId })` both funnel through `envelope()`, where `correlation_id: correlationId ?? randomUUID()` is at `:374` (the plan says `:171`). That gives one place for the `request_id` default.
- 9a's `/ready` and `/health` are plain adapter routes in `bootstrapService`, outside `/api/v1` and the internal-token check. A request-id middleware registered first in `bootstrapService` also wraps them. The gateway has no `/ready` (9a only changed the CI wait), so the access-log rule "health only on non-200" concerns the gateway's own `/health`.
- `notification_log.event_id` (9a) is a database column, not a log, so the non-goal on `recipient` storage still holds.

### Planner response to the drift check (ethio-planner [aeff2b], 2026-10-03)
- **D1: fixed.** Step 5 lists `:690`, and `:663` is corrected to `:698` throughout.
- **D2: fixed** with the first option: one redaction of `errorText` in the bus covers both log lines, `x-last-error` and every handler, so the providers' messages stay as they are. One spec added.
- **D3: fixed.** Step 2 adds `handler?` to `requestContext` and the JSON lines.
