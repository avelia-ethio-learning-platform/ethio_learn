# Phase 6a: Security hardening I, platform

Status: approved (round 3); amendment A1 (anonymous pay-link read, P0-19, 2026-10-03) approved in round 4, with N5–N7 folded in
Size: L (sessions: 4; ethio-impl implements, ethio-reviewer reviews the code)
Base branch: `fix/web-p0` (stacked: Phase 5's tip once its two code-review should-fixes are fixed or deferred). Merge `origin/main` back in once #20, Phase 4 and Phase 5 land; see `handoff.md` → Branch. This phase builds on Phase 4's guarded `confirmPayment` (coupon `uses + 1` exactly once) and on Phase 3's membership invites. · Feature branch: `fix/security-platform`
Roadmap: phase 6, split into 6a (this plan: P1-01, P1-05, P1-11, P1-13) and 6b (`2026-10-02-learning-integrity`: P1-04, P1-09, P1-10), because seven findings across every service would be one unreviewable PR. Amendment A1 adds P0-19, found by ethio-impl during Phase 5. It's a pre-existing auth bug on the same financial controller and route that step 3 already touches.

## Goal
Close four holes a signed-in user can exploit today:
- **P1-01:** a route parameter like `..%2Fusers%2F<uuid>` steers a service's internal call, which carries the mesh token, to another internal route. Confirmed live: a blind SSRF and a user-existence oracle.
- **P1-05:** changing the password needs neither the current password nor a confirmation, so anyone at an unlocked session can lock the owner out.
- **P1-11:** any signed-in user can make the platform send branded email to arbitrary addresses, with a 500-character message, at about 400 emails per minute per account.
- **P1-13:** coupon `max_uses` is checked when quoting but counted only after confirmation, so parallel checkouts redeem one-use and 100%-off codes past their limit.

Acceptance criteria:
- **Internal calls:** no route or query parameter can change which internal route a service calls. Every value put into an internal path is percent-encoded, and the client refuses a path outside `/api/v1/internal/` or one with dot segments. Every uuid route parameter returns 400 for a non-uuid before any service code runs.
- **Password change:**
  - It requires the current password, except in two cases: an account with no password yet (Google sign-up), and the `must_change_password` first-login path.
  - The web form asks for the new password twice.
  - The caller stays signed in, and every other session is revoked.
  - Wrong-password attempts are rate-limited like login.
- **Email caps:**
  - A referral invite emails only addresses that aren't already users and that this referrer hasn't invited before.
  - Referral invites, pay requests, gifts and institution invites each have a per-account daily cap. Referral invites and pay requests also have a per-recipient cap. Hitting a cap returns a clear 429.
- **Coupons:**
  - Concurrent checkouts can never take a coupon past `max_uses`. That counts confirmed uses plus checkouts still open within the hold window.
  - An optional per-user limit is enforced the same way.
  - Coupon code checks are rate-limited.
- **Pay links (A1, P0-19):**
  - A signed-out payer who opens `/pay/<token>` sees the request.
  - Anonymous `GET /pay-requests/:token` returns 200 with the public shape, and 404 for an unknown token.
  - Paying (`POST /pay-requests/:token/pay`) still requires sign-in.
  - Every other GrowthController route still requires sign-in.

## Non-goals
- Per-caller scoping of internal routes, since any holder of the mesh token can still call any `/internal` route. A path-normalizing guard in the gateway is also out: once the paths are encoded at the source, it would be redundant.
- A minimum account age for sending invites. The financial service sees only `{id, role, email}`, and password login already requires a verified email. The daily caps bound the damage.
- An expired status for abandoned checkouts (P2-01). Coupon holds simply lapse after the window; no status changes.
- Coupon refunds, and changes to coupon `uses` on refund. Refunds of coupon payments still go to support (`refund.service.ts:32-33`).
- Learning integrity: P1-04, P1-09 and P1-10 are Phase 6b.
- Anything Phase 3 already changed in institution membership, except the daily invite cap added here.

## Current state
- **Internal client** `api/packages/common/src/http/internal-client.ts:17-35`:
  - A single `get<T>(path)` does `fetch(\`${gatewayUrl}${path}\`)` with the `x-internal-token` header (`:22-23`). There is no encoding or validation.
  - The gateway routes on the raw path without decoding or resolving `..` (`gateway/src/request-path.ts:19-23`, `main.ts:169-174`) and forwards it unchanged.
  - Express decodes route params, so `lessonId` becomes `../users/<uuid>`. `fetch` then resolves the dot segment, and the call lands on `/api/v1/internal/users/<uuid>` (`routes.ts:35`). Decoded `%3F`, `%23` and `%26` can also inject a query string or cut the path short.
  - There are 74 call sites that interpolate a value into the path. These reach the internal call before any uuid-typed database lookup:
    - enrollment `enrollment.service.ts:214` (route param `lessonId`) and `:310,321` (query `course_ids`, comma-split, unvalidated);
    - financial `growth.service.ts:123` (query `course_id`);
    - notification `community.service.ts:60,68` (route param);
    - outcomes `assessment.service.ts:887` via `courseAttempts` / `pendingProjects` (route param);
    - quality `:593` (route param, into a query string).

    The rest use database rows, JWT ids or `@IsUUID` body fields. Two already use `encodeURIComponent` (`growth.service.ts:277`, `sponsorship.service.ts:504`). Every call targets `/api/v1/internal/…`.
  - Route params: the global `ValidationPipe` (`common/src/bootstrap.ts:51`) doesn't check `@Param('x') x: string`. `ParseUUIDPipe` is used at only 4 of 111 `@Param`s (`notification/controllers.ts:181`, `quality/controllers.ts:81,88,97`).
  - Non-uuid params:
    - `auth.controller.ts:67` `invite/:token` (64 hex chars);
    - auth `internal.controller.ts:24` `users/by-email/:email`;
    - `course.controller.ts:469` `courses/:id/knowledge/:title` (free text; `:title` only);
    - `growth.controller.ts:265,271` `pay-requests/:token`;
    - outcomes `controllers.ts:209,215` `certificates/:uid` and `verify/:uid` (a varchar column holding `randomUUID()`; treated as case-sensitive).

    Every primary key is `uuid`. There is no spec for `internal-client`.
- **Password change**:
  - `PUT /profiles/password` (`profiles.controller.ts:40-45`) takes `ChangePasswordDto { new_password }` (`dto.ts:151-154`). `changePassword` (`auth.service.ts:244-250`) hashes, clears `must_change_password`, then `revokeAllSessions` (`:345-353`), which also revokes the caller's refresh token. The comment promises a fresh session, but the method returns `{message}` only, so the caller is logged out at the next refresh.
  - `password_hash` is nullable and null for Google sign-ups (`entities.ts:19-22`, `auth.service.ts:179`). `GET /profiles/me` doesn't say whether a password exists (`profiles.controller.ts:124-134`).
  - `must_change_password` is set for admin-created staff and invited users (`admin.controller.ts:81-83`, `profiles.controller.ts:243-245`). The web sends those users to `/account/password?first=1` after password or Google login (`login/page.tsx:32`, `GoogleSignInButton.tsx:65`). `confirmPasswordReset` doesn't clear the flag (`auth.service.ts:315`).
  - Account deletion is the existing pattern: `bcrypt.compare` against the hash, then 401 "Password is incorrect.", or the Google-only message (`profiles.controller.ts:55-66`).
  - The page has a single field (`web/src/app/(account)/account/password/page.tsx:30,51`).
  - `auth-strict` covers only `/auth/*` credential routes (`gateway/src/rate-policy.ts:40-41,64-66`).
- **Email to arbitrary addresses**:
  - **Referral invite** `POST /referrals/invite` (`growth.controller.ts:76-90,237-241`; any role; up to 20 emails and a 500-char message). `GrowthService.invite` (`growth.service.ts:266-298`) stores a `referrals` row only for unknown, not-yet-invited addresses, but publishes `ReferralInviteSent` for **every** address on every call, existing users included.
  - **Pay request** `POST /pay-requests` (`growth.controller.ts:120-131,257-261`, learners). `createPayRequest` (`sponsorship.service.ts:104-140`) saves a new `sponsorships` row every time (`source='pay_request'`, payer email stored in `organization_name`) and publishes `PayRequestCreated`. There is no dedupe.
  - **Gift** `POST /gifts` (`growth.controller.ts:98-118`). It emails after confirmation, and a 100% coupon confirms instantly (`payment.service.ts:185-188`).
  - **Institution invite** (Phase 3): in the `INVITES` rate class, with no daily cap.
  - Notification renders all of these with the sender's name in the subject and the escaped message in the body (`notification.service.ts:294-306,55-72`).
  - The only limits are per minute and in memory: `community-write` at 20/min per user for `INVITES` (`rate-policy.ts:31,50,72`), and `payment-initiate` at 10/min for gifts.
- **Coupons**:
  - `Coupon` (`financial/src/entities.ts:187-231`) has `code` (unique), `max_uses`, `uses`, `expires_at`, `active` and `course_id`, with no per-user limit.
  - `createSession` (`payment.service.ts:147-204`) calls `growth.quote` (checks at `growth.service.ts:109-113`), then inserts the payment with `coupon_code`, with no lock between them. After Phase 4, `uses + 1` happens exactly once at confirmation, in a savepoint.
  - A 100% coupon settles in the same request (`:185-188`).
  - There is no redemption table: `payments.learner_id` + `coupon_code` + `status` is the only link. `coupon_code` isn't indexed (`entities.ts:76-77`). No payment ever expires (P2-01).
  - `GET /coupons/validate` is any role, on the general bucket (300/min), so codes can be enumerated (`growth.controller.ts:203-207`).
  - The coupon form is `teach/coupons/coupon-manager.tsx:16-31`.

## Design and key decisions
### A. Internal paths (P1-01)
1. **`internalPath` tagged template in `common/src/http/internal-client.ts`.**
   - It returns a branded `InternalPath` string, and `get(path: InternalPath)` accepts only that type. The compiler therefore forces all 74 call sites onto the helper, and a raw string can't slip in later.
   - The template `encodeURIComponent`s every interpolated value. Arrays become comma-joined encoded items, for `course_ids`.
   - Usage: `internalPath\`/api/v1/internal/lessons/${lessonId}\``. A value like `../users/x` becomes the single segment `..%2Fusers%2Fx`, which URL parsing leaves alone, and the receiving service rejects it.
   - Rejected: validating the finished string only. It can't tell an injected `?` from an intended one.
2. **`get()` checks the final path before fetching:**
   - it must start with `/api/v1/internal/`;
   - `new URL(path, gatewayUrl).pathname` must equal the path part of `path`. URL parsing resolves `.`, `..` and their `%2e` forms, so any dot segment shows up as a difference (round-1 N1);
   - no `\` and no `#`.

   On a violation it logs and throws, without fetching. This is defense in depth if a future helper misuse slips through.
3. **`UuidParam(name)` decorator in common** (`Param(name, new ParseUUIDPipe())`, version `all`, so fixed seed ids pass):
   - It is applied to every uuid route param in all services: 107 of 111 today, minus the non-uuid list above.
   - Uuid query params are validated in DTOs: `course_ids` (`@IsUUID('all', { each: true })`, max 25) and the growth `course_id`.
   - Non-uuid params get explicit pipes. `invite/:token` and `pay-requests/:token` get a regex pipe for their alphabet and length. `certificates/:uid` and `verify/:uid` get a uuid-shaped regex (case kept). `knowledge/:title` stays free text and goes through `internalPath` if it ever reaches an internal call.
   - The result is a clean 400 at the edge instead of a 22P02 deeper in.

### B. Password change (P1-05)
4. **`ChangePasswordDto { new_password; current_password?: string }`.** `changePassword(userId, dto)` loads the user:
   - if `password_hash` is set and `must_change_password` is false, `current_password` is required: 400 "Current password is required." when missing, 401 "Current password is incorrect." when wrong;
   - with no password yet (Google sign-up) or on the first-login path, it isn't required.
   - Rejected: requiring a current password from Google-only users. They have none, and the session is the proof, as with "set a password".
5. **Stay signed in here, sign out everywhere else:** after `revokeAllSessions`, issue a fresh session for the caller through the same code path login uses (access token in the body, refresh cookie set by the controller). The response shape matches login's, so the web just calls `setAuth`.
6. **`GET /profiles/me` adds `has_password: boolean`.** `confirmPasswordReset` clears `must_change_password`, since the user has just proven they own the email.
7. **Rate limit:** `PUT /profiles/password` and `DELETE /profiles/me` (which checks the password) join `auth-strict` (10/min per IP) through a new `PASSWORD_CHECK` regex in `rate-policy.ts`.
8. **Web:**
   - fields for current password (only when `has_password` and not `?first=1`), new password and confirm new password;
   - a client-side match check;
   - `autocomplete="current-password"` / `"new-password"`;
   - the server's 401 message shown inline.

### C. Email caps (P1-11)
9. **Referral invites email only new invitations.** `ReferralInviteSent` is published only when a new `referrals` row was inserted: the address isn't a user, and this referrer hasn't invited it before. The response becomes `{ invited: n }`, with no per-address detail, so the endpoint doesn't reveal who already has an account.
10. **Daily caps, counted from rows each service already stores** (no new tables):

    | Path | Per account, rolling 24 h (env override) | Per recipient |
    |---|---|---|
    | Referral invite | 20 new invitations (`REFERRAL_INVITES_PER_DAY`), from `referrals` by `referrer_id` | 1 referral email per address per 7 days across all referrers, from `referrals.referred_email`; over-cap addresses are skipped silently and not counted in `invited` |
    | Pay request | 5 (`PAY_REQUESTS_PER_DAY`), from `sponsorships` (`source='pay_request'`, by requester) | 3 per payer email per 24 h; an open request for the same (requester, course, payer email) is returned again without a new email |
    | Gift | 10 (`GIFTS_PER_DAY`), from `sponsorships` (`source='gift'`, by sponsor) | — (gifts cost money except through coupons, which section D bounds) |
    | Institution invite (auth) | 50 per institution (`INSTITUTION_INVITES_PER_DAY`), counted on a new `institution_instructors.invited_at`, set on **every** invite and re-invite (round-1 B1) | if this membership's `invited_at` is within the last 24 h, whatever its status, the re-invite updates the row but sends no email. The invite still shows on the user's `/account/invites` (Phase 3) |

    - Over the per-account cap, the endpoint returns 429 with the existing error envelope: "You've reached today's limit for <invites>. Try again tomorrow."
    - Counts run inside the request, backed by the indexes in the migrations section. A small race can let a burst exceed a cap by a few. That's acceptable for spam control, which is why there are no locks here.

### D. Coupons (P1-13)
11. **Hold at checkout, count at confirmation.** In `createSession`, when a coupon applies, one transaction does the following:
    1. `SELECT … FROM coupons WHERE code=$1 FOR UPDATE`, which serializes checkouts of the same coupon;
    2. re-checks `active` and `expires_at`;
    3. **handles the payer's own open checkout for the same purchase first (round-1 S1, round-2 B2).** It looks for a `pending` payment, within the window, by this payer with this coupon and the **same purchase**: `purpose = course` with the same course, where the payer is the learner; or, for gifts, pay requests and bulk orders, the same purpose-row id in `meta` (`sponsorship_id` or `bulk_purchase_id`). Then:
       - if this request is a Chapa checkout, that row has a `checkout_url`, and its amount equals the new quote, it returns that checkout (same `payment_id`, `tx_ref`, URL) without a new row;
       - otherwise it marks that row failed through Phase 4's guarded fail path with reason `superseded`, then continues. A late payment of it still confirms through verify (Phase 4 allows failed → confirmed).

       The payer's open checkout for a **different** purchase, such as a gift to another recipient or a new bulk order, is never returned and never superseded. It counts as a hold like anyone else's. Superseding it would let a payer open two checkouts, pay both, and redeem a one-use coupon twice. When the payer's own hold is what blocks them, the refusal says so: 400 "This coupon is held by another checkout you started. Finish paying it, or try again after <time>." The 400 body also carries that checkout's `checkout_url`, when it has one, so the message can link to it (round-3 N4). The web gift form sends no coupon today (`enroll-panel.tsx:185`), so this matters mainly for API callers.
    4. computes `confirmed = GREATEST(coupons.uses, count of this coupon's confirmed payments)` (round-1 N3: Phase 4's savepoint can roll back `uses + 1`) and `held` = this coupon's `pending` payments created within `COUPON_HOLD_MINUTES` (default 60);
    5. refuses with the existing 400 "This coupon has been fully used." when `max_uses` is set and `confirmed + held >= max_uses`;
    6. otherwise inserts the payment row (`pending`, `coupon_code`).

    Then:
    - The Chapa call stays outside the transaction.
    - `uses + 1` still happens once at confirmation (Phase 4).
    - A hold lapses on its own after the window. No cron and no new status.
    - **Every failure after the insert releases the hold:** a too-low wallet balance (after Phase 4 the debit rolls back inside the confirm transaction and leaves the row `pending`), a failed Chapa open, or any other throw before a checkout is returned. Each marks the payment failed through Phase 4's guarded fail path, then rethrows the readable error. Reasons are `wallet_insufficient`, `checkout_open_failed` and `error`.
    - **No failure notice for these internal reasons:** a `superseded`, `wallet_insufficient` or `checkout_open_failed` failure doesn't send the learner a "payment failed" notice, because the learner is mid-retry or has just seen the error. The guarded fail path takes the reason. The implementer checks `PaymentFailed`'s consumers: if only the notification uses it, skip the publish for these reasons; otherwise publish with `reason` and have the notification skip them.
    - Accepted: a payment confirmed after its hold lapsed still counts, even if that takes `uses` past `max_uses`. The learner paid, so honoring the discount is right.
    - Rejected: incrementing `uses` at checkout and decrementing on failure or abandonment. That needs an abandonment cron and release bookkeeping for every failure path.
12. **Per-user limit:** a nullable `coupons.max_uses_per_user` column, enforced under the same lock. It counts this payer's payments with this code that are `confirmed`, or `pending` within the hold window, after step 3 has handled their own open checkout. The coupon manager gets an optional "Uses per learner" field. Null means unlimited, which keeps existing coupons as they are.
13. **The 100% path** goes through the same transaction before `settleInstantly`, so instant settlement can't bypass the hold count.
14. **Enumeration:** `GET /coupons/validate` moves to the `community-write` bucket (20/min per user) through a GET rule like `AI_GET`.

### E. Anonymous pay-link read (A1, P0-19)
**The bug (pre-existing on main since `cadf91e`, 2026-09-13):** pay links have never worked.
- The gateway marks `GET /pay-requests/:token` public (`gateway/src/routes.ts:54`), and the web page calls it with `{ auth: false }`.
- But `GrowthController` has `@UseGuards(RolesGuard)` at class level (`growth.controller.ts:173-175`).
- `RolesGuard` throws 401 "Authentication required" whenever there's no user, even on a handler without `@Roles` (`packages/common/src/auth/roles.guard.ts:25`).
- Result: every payer sees "Request not found. This payment link is invalid or has expired."
- ethio-impl reproduced it on the e2e stack (anonymous → 401, Bearer → 200), and ethio-plan-review confirmed it in the code.

15. **Move the one public route into its own guard-less controller.**
    - `PayRequestPublicController` (`@Controller()`, no `@UseGuards`) holds only `GET pay-requests/:token` → `sponsorships.payRequestPublic(token)`. It goes in its own file in `services/financial/src/` and is registered in the financial module's `controllers`.
    - `payRequestPublic` is removed from `GrowthController`, which keeps its class-level `RolesGuard`, so all its other routes stay fail-closed. `POST pay-requests/:token/pay` stays there, still `@Roles()`.
    - The handler takes step 3's token pipe (the `randomCode(24)` alphabet and length), so a malformed token is a 400 before any query.
    - No change to the service method or its response shape: first name, course, price, message, status. The payer's email (`organization_name`) is not in it, and stays out.
    - No gateway change: GET is already public and POST is already `jwt`. No web change: `/pay/[token]` already calls with `{ auth: false }`, and Phase 5's S1 renders waking and not-found correctly.

    **Rejected alternatives:**
    - A `@Public()` flag honored by the shared `RolesGuard`. The guard lives in `packages/common` and every service uses it. A bypass flag is a new escape hatch, and one misplaced class-level `@Public()` silently opens a whole controller.
    - Method-level guards on all ~25 GrowthController routes. That's the course and enrollment controllers' style, but here one missed route would be unauthenticated at the service, with only the gateway's `jwt` rule left in front of it.

    **Enumeration:** tokens are 24 characters over a 32-character alphabet, about 120 bits, and the anonymous GET sits in the gateway's per-IP `general` bucket. Nothing more is needed.

## Data model and migrations
Phase 2 pattern; entities updated so `db:check` stays at 0.
- **Financial migration 1 (transactional):** `ALTER TABLE financial.coupons ADD COLUMN max_uses_per_user int NULL CHECK (max_uses_per_user IS NULL OR max_uses_per_user > 0)`.
- **Financial migration 2 (`transaction = false`, drop-if-exists first, one statement per query):**
  - `financial.payments (coupon_code, created_at) WHERE coupon_code IS NOT NULL AND status IN ('pending','confirmed')`: the hold and per-user counts;
  - `financial.referrals (referrer_id, created_at)` and `(referred_email, created_at)`;
  - `financial.sponsorships (source, sponsor_id, created_at)` for gifts, `(source, recipient_user_id, created_at)` for pay requests (the requester is `recipient_user_id`; `sponsor_id` is null), and `(organization_name, created_at) WHERE source='pay_request'` for the payer email.
  - Emails are already lowercased on write (`growth.service.ts:267`, `sponsorship.service.ts:107`), so plain-column indexes declared on the entities work. A `lower()` expression index would show as `db:check` drift (round-1 N2).
- **Auth migration 1 (transactional):** `ALTER TABLE auth.institution_instructors ADD COLUMN invited_at timestamptz NULL`; backfill `invited_at = created_at`; set default `now()`. Phase 3's `addInstructor` sets `invited_at = now()` on every invite and re-invite (round-1 B1).
- **Auth migration 2 (`transaction = false`):** `auth.institution_instructors (institution_id, invited_at)`.
- `down()` drops the indexes and the column (local only). No unique indexes, so no production duplicate check is needed.

## API contract
- **`PUT /profiles/password`:**
  - body `{ new_password, current_password? }`;
  - 200 with the login-shaped response (fresh access token, refresh cookie set);
  - 400 "Current password is required.", 401 "Current password is incorrect.";
  - in `auth-strict`.
- **`GET /profiles/me`:** adds `has_password`.
- **`DELETE /profiles/me`:** unchanged, but now in `auth-strict`.
- **`POST /referrals/invite`:** 201 `{ invited: n }`; 429 over the daily cap.
- **`POST /pay-requests`, `POST /gifts`, `POST /institutions/:iid/instructors`:** 429 over the daily cap. A re-invite within 24 h of the last one returns the usual 201 and sends no email. A pay request duplicating an open one returns the existing request (201, same shape).
- **Checkout (`/payments/initiate` and the other initiate routes):**
  - 400 "This coupon has been fully used." when holds and uses reach the limit;
  - 400 "This coupon is held by another checkout you started. Finish paying it, or try again after <time>." when the payer's own hold on a different purchase is what blocks them;
  - 400 "You've already used this coupon." over the per-user limit;
  - a Chapa retry of the same purchase may return the existing checkout.
- **Coupon create and update:** an optional `max_uses_per_user`.
- **Any uuid path param:** 400 for a non-uuid.
- **`GET /pay-requests/:token` (A1):** anonymous. 200 with the existing public shape, 404 for an unknown token ("Not found", from `byToken`) or a non-pay-request ("Request not found"), and 400 for a malformed token (step 3's pipe). It was 401 for everyone without a token. `POST /pay-requests/:token/pay` is unchanged: 401 without a token.

## Steps
- [x] 1. Branch per the base rule. Remove this folder's line from `.git/info/exclude` and commit the folder.
- [x] 2. `internalPath`, `InternalPath` brand and `get()` checks, plus `internal-client.spec.ts`:
  - `../`, `%2F`, `?`, `#` in values;
  - arrays;
  - rejected prefixes and dot segments.

  Then migrate all 74 call sites; the compiler lists them.
- [x] 3. `UuidParam` plus the token and uid pipes on every controller, and the DTOs for `course_ids` and `course_id`. Add a gateway or controller spec per service with a non-uuid param → 400. Re-run the P1-01 probe (`/progress/lessons/..%2Fusers%2F<uuid>/complete` → 400, no internal call in the logs).
- [x] 3a. (A1) `PayRequestPublicController`, decision 15, with its token pipe from step 3. Add a financial spec that reads Nest's guard metadata:
  - `PayRequestPublicController` has no guards on the class or on its handler;
  - `GrowthController` still has `RolesGuard` at class level;
  - `GrowthController` no longer has a `GET pay-requests/:token` handler.
- [x] 4. Password change, decisions 4–8, with auth unit tests and web vitest.
- [x] 5. Email caps, decisions 9–10, with unit tests per path.
- [x] 6. Financial and auth migrations. `db:check` at 0 on a fresh and an existing local DB. Revert round-trips with `-t none`.
- [x] 7. Coupon hold and per-user limit, decisions 11–14, with unit tests and a coupon-manager field.
- [x] 8. `scripts/e2e-security.mjs` (added to CI e2e before the smoke step):
  - the P1-01 probe → 400;
  - password change without the current password → 400, with it → 200 and still signed in;
  - referral invite to an existing user → `invited: 0`;
  - the 21st referral invite in a day → 429;
  - a one-use coupon with 5 concurrent 100% checkouts → exactly 1 succeeds;
  - a one-use coupon on a Chapa checkout that is abandoned, then retried → accepted;
  - (A1) a learner creates a pay request. Then, with no token:
    - `GET /api/v1/pay-requests/<token>` → 200 with `course_title` and `requester_name`, and the payer's email nowhere in the body;
    - a well-formed unknown token → 404;
    - a malformed token (wrong alphabet or length) → 400;
    - `POST /api/v1/pay-requests/<token>/pay` → 401.
- [x] 9. Full gate: api build, tests and `db:check`; web typecheck, tests and build; every e2e script; both image builds.
- [x] 10. Code review by ethio-reviewer: APPROVED in round 2 at `99bd653`. Push, PR and merge are next (same-day merge and deploy).

## Test plan
- **Unit tests** (codebase mock style; fakes from `course.service.spec.ts:20-133`):
  - `internalPath` encoding and the `get()` guards;
  - `UuidParam` → 400;
  - token, uid and title params still accepted;
  - `changePassword`: required / wrong / correct current password, Google-only, first-login, the fresh session returned, other sessions revoked;
  - `confirmPasswordReset` clears the flag;
  - `rate-policy.spec.ts`: the password and delete routes → `auth-strict`, `coupons/validate` → `community-write`;
  - referral `invite`: emails only new rows, per-recipient skip, cap → 429;
  - pay request: dedupe returns the existing request, both caps;
  - gift cap;
  - institution invite cap and no re-send within 24 h, including invite → cancel → re-invite within 24 h: no second email, and the re-invite counts toward the cap;
  - coupon: a hold blocks the last use, a lapsed hold frees it, the per-user limit, the 100% path counted;
  - coupon failure paths: a failed Chapa open releases the hold; a too-low wallet balance releases the hold, and switching to Chapa then works;
  - coupon retries:
    - abandon a course checkout and retry with Chapa → the same checkout is returned;
    - the same retry after a price change → superseded, with a new checkout;
    - retry with the wallet → the old row is superseded and the retry is accepted;
  - coupon, different purchases:
    - two gifts of one course to different recipients with a one-use coupon → the second is refused with the "held by another checkout you started" message, and the first is untouched;
    - a new bulk order while an earlier one is open → its own row, never the old checkout;
  - a rolled-back `uses + 1` still counts through the confirmed-payments count;
  - superseded and wallet-insufficient fails send no failure notice;
  - (A1) the guard-metadata spec from step 3a. The real behaviour, anonymous 200 through the gateway, is proved in `e2e-security.mjs`; the codebase has no HTTP-level controller harness, and A1 doesn't add one.
- **Web vitest:** password form validation (mismatch, current field shown or hidden), the coupon-manager field.
- **E2E:** `scripts/e2e-security.mjs` (step 8) in CI.
- **Commands:** `pnpm -C api build && pnpm -C api test && pnpm -C api db:check`; `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`; `node scripts/e2e-security.mjs` plus the existing scripts.

## Rollout and ops
Production steps belong to the user, or to a session only on the user's explicit request.
1. **Before merge (read-only):** no unique indexes, so no duplicate checks. Optionally count recent `ReferralInviteSent` volume in `notification_log` to see whether abuse already happened.
2. Push and open the PR only when it can be merged and deployed the same day; the repo is public and this plan describes live holes.
3. **After deploy:**
   - the P1-01 probe against production returns 400 (a harmless GET with an invalid id);
   - a password change on a test account asks for the current password;
   - the referral invite response is `{ invited: n }`;
   - (A1) signed out, open a pay link from a test learner's pay request. Use your own email as the payer, since creating a pay request sends an email. The page shows the course and the learner's first name, not "Request not found".
- The new caps are code defaults with env overrides. Render needs no change.
- **Logging:**
  - internal-path rejections log the caller and the offending value's length, not the value;
  - cap hits log the user id and the path.

## Risks and open questions
- **The `UuidParam` sweep touches every controller.** A param that is legitimately not a uuid and that I missed would start returning 400. The non-uuid list comes from a full `@Param` sweep, and the e2e scripts exercise the main routes. The reviewer should check the list against the diff.
- **Daily caps might bite a legitimate heavy user,** for example an institution onboarding 60 teachers. The env overrides allow raising a cap without a deploy of code.
- **Coupon hold window:** a learner who opens a Chapa checkout and pays after 60 minutes still gets the coupon. Only the counting is window-based.

## Progress and deviations (implementer)
Branch `fix/security-platform`, created from `fix/web-p0` @ `63d942d` (Phase 5 code review APPROVED in round 2). Not pushed.

Commits (step 2): `931a9a1` the `internalPath` helper, `InternalPath` brand, `get()` checks and `internal-client.spec.ts` (14 tests); then one commit per service: `34d2d2b` auth, `acb49af` course, `de0ce4d` enrollment, `196e29e` financial, `9db67d2` notification, `bf99fd5` outcomes, `239304e` quality. All 74 call sites use `internalPath`, and the two existing `encodeURIComponent` calls were dropped. `pnpm -C api build` and typecheck are clean; `pnpm -C api test` 44 suites, 849 tests.

Deviations:
- **Step 1:** the folder is committed with `git add -f` (the user approved it on 2026-10-03), so `.git/info/exclude` is unchanged. Phase 5's `docs/plans/2026-10-02-web-p0-fixes/code-review.md` is in the same docs commit.
- **Order:** step 6 (entities and migrations) runs before step 5, because step 5's institution cap reads `invited_at` and both 5 and 7 use the new indexes. Order only.
- **Step 2:** `931a9a1` on its own doesn't compile the services, because `get()` requires `InternalPath` from that commit on. The per-service commits follow, as the handoff asked, and the build is green from `239304e`.
- **Step 2:** the rejection log has the reason and the path's length, not a caller name. `InternalHttpClient` has no service name, and each service logs to its own stream.
- **Step 3 (`239304e..1ebe9bc`):** the common `UuidParam` and the token and uid pipes are in `4cf67ed`, and the guard helper in `2e73b56`. Then there is one commit per service, from `ec347e3` to `2f986de`, followed by the DTOs in `d707200` (`course_ids`) and `1ebe9bc` (coupon preview `course_id`). Of the 112 `@Param`s, 105 use `UuidParam`, 5 use token or uid pipes, and 2 are free text (`by-email/:email` and `knowledge/:title`).
- **Step 3's tests (ruling R7):** the api has no HTTP harness. Instead there are common pipe specs, and one `route-params.spec.ts` per service that reads Nest's route-arg metadata for every controller in the module and fails on any unpiped `@Param`. The gateway-level P1-01 probe runs in step 8's e2e.
- **Step 3, other uuid query params (ruling R8):** enrollment `status`, internal `entitlement`, and outcomes `list` and `myAttempts` take `course_id`/`learner_id` query params, which stay unvalidated. The plan names only the two DTOs. `internalPath` already stops any query value from steering an internal call.
- **Step 3, `GET /coupons/validate` without `course_id`:** this now returns 400 at the edge, where it used to be a downstream 404. The only web caller always sends it.
- **Step 3a (`48da8e5`):** the guard-less `PayRequestPublicController` is in. A guard-metadata spec checks it.
- **Step 4 (`9ff4f29`, `39ed343`, `4addd8f`):** the `PASSWORD_CHECK` rule, then the api, then the web form. `startSession(user)` is extracted from `login`, and `refresh-cookie.ts` is shared by the auth and profiles controllers, so the cookie options are identical. Other sessions' access tokens stay valid until they expire (15 min); only refresh tokens are revoked, as the plan says.
- **Step 6 (`dfe8079`, `7de9b90`):** `db:check` is 0 on a fresh DB and on a copy of the dev DB. The `-t none` revert round-trips. The check constraint is named `CHK_coupons_max_uses_per_user` and declared with `@Check`, so there's no drift.
- **Step 5 (`27b7b39`, `b9e7921`, `ff56ebe`):**
  - Ruling R9: a referral invite fills up to the remaining daily allowance and returns 429 only when the allowance is already 0.
  - Ruling R10: a pay request goes dedupe, then the per-account cap, then the per-recipient cap. The per-recipient 429 says "You've reached today's limit for pay requests to this email. Try again tomorrow."
  - Ruling R11: every institution invite and re-invite is checked against the cap and stamps `invited_at`.
  - The web dashboard reads `{ invited }`. The 4 cap env vars are added to `api/.env.example`, commented out. The per-recipient limits are constants.
- **Step 7, ruling R12:** in the "held by another checkout you started" message, `<time>` is `HH:MM` in Africa/Addis_Ababa.
- **Briefs:** the controller corrected the step 5 and step 7 briefs, whose test-plan, logging and risk lines had been quoted off by one.

- **Step 7 (`f8800bc`, `9de4954`, `23d5bdc`, `a1fb767`, then fix round 1 `c4d2c85`, `e3f7234`, `c17ade9`):**
  - The coupon transaction is as planned: lock the coupon; re-check it; handle the payer's same-purchase rows; count `GREATEST(uses, confirmed)` plus holds; check the per-user limit; insert. The 100% path goes through the same transaction. `GET /coupons/validate` is in `community-write`. The coupon manager has an optional "Uses per learner" field.
  - Only the notification service consumes `PaymentFailed`, so a fail with reason `superseded`, `wallet_insufficient` or `checkout_open_failed` publishes nothing.
  - Decisions beyond the plan. The task review and ethio-reviewer's early read 2 both judged them sound:
    - **D1:** an instant settlement (wallet or 100%) claims only a `pending` row. The loser of a same-purchase double submit gets 409 "A newer checkout for this purchase replaced this one." (ruling R16). Gateway sources still confirm failed rows.
    - **D2:** `confirmPayment` takes the coupon lock, in a savepoint, before it claims the payment. Checkout and confirmation then both lock coupon → payment, so they can't deadlock.
    - **D3:** the checkout URL is written with a targeted `update`, not `save`.
    - **D4:** every failure after the insert fails the row, coupon or not.
    - **D5:** when the payer's own open holds put them at the per-user limit, the refusal is the "held by another checkout you started" message (ruling R17).
  - **Fix round 1 (ruling R15):** the task review found that a superseded checkout someone pays could be confirmed only by the webhook. Two changes:
    - The URL write is guarded on `status = pending`. When it matches 0 rows, the request gets the same 409, and the URL isn't handed out.
    - `reconcile` also verifies a `failed` row that has a `chapa_checkout_url`.

    The failed-row sweep stays in 6c amendment A2 (P1-62). ethio-planner agreed, and A2 builds on this reconcile branch.
  - **Ruling R18:** the payer's own-holds lookup takes `FOR UPDATE` after the coupon lock, so a double-click leaves exactly one live checkout.
  - **Ruling R12:** `<time>` is `HH:MM` in Africa/Addis_Ababa.
  - ethio-reviewer's N2 is fixed: a supersede is logged only after the checkout transaction commits.
  - Pre-existing issues step 7 found went to 6c amendment A: the nudge cron's lost update (P1-61), the sweep skipping failed rows (P1-62), orphan sponsorship rows (P2-46).
- **ethio-reviewer's early read (`d76e28f`, `0740870`, `4a3701f`, `412fc8f`):**
  - B1: `changePassword` runs `assertActive` before anything else.
  - S1: `/teach/analytics` sends at most 25 course ids (ruling R14).
  - S2: the password form shows the current-password field when the server asks for it.
  - N1: the referral daily cap is checked before any account lookup.
  - S3 is deferred to Phase 9c (ruling R13). ethio-planner added it to 9c decision 2 and step 3.
- **Merge:** `origin/main` is merged in as `8d3bccc`. It brings #17–#22, the Groq model fix and `.gitleaks.toml` `9274e9f`, with no conflicts. After the merge, api typecheck is clean with 61 suites and 997 tests passing, and web typecheck is clean with 30 files and 377 tests passing. The code review base is now `origin/main`.

- **Step 8 (`c76f5e6`, `ebc9e61`, `7c4678f`):**
  - `scripts/e2e-security.mjs` makes 27 checks covering every line of step 8. The CI step "Security hardening (internal paths, password change, email caps, coupons, pay links)" runs it after "Exactly-once payments" and before "Build web".
  - Accounts, coupon codes and invitee addresses (`@example.test`) are unique per run, so the script re-runs on the same DB. It ran 3 times on one DB.
  - The 429 retry covers `/auth/` and `/profiles/password`, but never the call whose 429 is being asserted. The daily-cap 429 is matched by its message, so a 429 from the per-minute limiter can't pass for it.
  - Two checks were added after the task review:
    - Before the password change, session B must hold a refresh cookie and must refresh with a 200.
    - The post-change 401 then uses B's rotated cookie. Without this, a missing cookie could have produced the 401.
- **Step 9 gate (2026-10-03, at `7c4678f`, merged with `origin/main`):**
  - **API:** typecheck is clean; 61 suites and 997 tests pass.
  - **Web:** typecheck is clean; 30 files and 377 tests pass. The build, run in a clean env with the stack up, passes.
  - **Stack and migrations:** a fresh `el_e2e` stack has no `db:check` drift.
  - **E2E, in CI order, all passing:** `demo-seed`, `e2e-revisions`, `e2e-institution`, `e2e-payments`, `e2e-security` (27/27), Playwright (27 passed) and `e2e-smoke` (with `E2E_CHECK_RATE_LIMIT=1`).
  - **Images:** all 8 api images (CI's `docker-api` matrix) and the web image build. The financial image ships `CouponPerUserLimit` and `CapIndexes`; the auth image ships `InvitedAt` and `InvitedAtIndex`.
- **Deferred minors for the code review to triage.** These come from the per-task reviews. None of them blocked a task.
  - **Internal paths:**
    - The spec doesn't assert the rejection log's content (reason and length, never the value).
    - There's no spec case for a single-dot value.
  - **Route params:**
    - The guard spec checks only that a `ParseUUIDPipe` instance is present. It doesn't cover uuid `@Query` values or an unnamed `@Param()` (ruling R8).
    - The test-only `unpipedRouteParams` is exported from the runtime `common` entry.
    - `params.spec.ts` runs expects inside a describe-time IIFE.
    - `pay-request-public.spec.ts` has duplicate imports.
  - **Password:**
    - `?first=1` hides the current-password field for any signed-in user. It's UX only; the server still enforces the rule, and S2 now reveals the field on the server's 400.
    - `auth.password.spec.ts` sets `JWT_SECRET` globally without restoring it.
  - **Migrations:**
    - The coupon `CHECK` validates under ACCESS EXCLUSIVE. The table is small and the new column all NULL.
    - The `invited_at` backfill is one unbatched `UPDATE`.
    - The migration specs only assert statement order.
  - **Email caps:**
    - The dashboard says "Sent 0 invitations." when every address was skipped.
    - The referral 24 h allowance also counts `signed_up` rows that `claim()` creates.
    - The institution cap check runs before the 409 already-active check.
  - **Coupons:**
    - No test shows that a refusal after a supersede rolls the supersede back.
    - `COUPON_HOLD_MINUTES` is parsed on every checkout. A malformed value makes every coupon checkout a 500, and 0 turns holds off.
    - The nudge cron can revert a supersede if the window is over 60 minutes. That's fixed by 6c A1; until then, keep the window at 60 minutes or less.
    - `payment.service.ts` grew to 1013 lines.
    - The `couponUnavailable` type narrowing is awkward.
    - The return page stops polling once a row shows `failed`.
    - `reconcile` re-verifies a mismatched failed row, with its error log, on every call.
    - A Chapa double-click without a coupon still opens two pending checkouts. This is pre-existing.
  - **E2E:**
    - The two malformed-token cases share one check.
    - `coupons.uses` is read right after the confirmed-payment poll.
    - The `/profiles/password` retry also wraps the wrong-password call.
- **Method:** subagent-driven development, with a task review per step and a scoped re-review per fix round. Every ruling (R3–R18) is in this section or in the step notes above.

- **Code review round 1 (CHANGES REQUESTED, one blocker):**
  - B2 `b3db839`: CI's gitleaks matched three made-up test values. `.gitleaks.toml` allowlists them by exact value. CI's scan command now reports 0 leaks, and the previous config still reports 3.
  - N3 `0c876de`: `invited: 0` explains why nothing was sent.
  - Both fixes are in the controller, not a subagent dispatch: one config line pair and one string. Neither touches the api or the e2e scripts, so the e2e was not rerun. The web typecheck is clean, and the web tests pass (30 files, 377 tests).

### Status (2026-10-03)
Steps 1–10 are done. Code review is APPROVED (round 2, at `99bd653`, see `code-review.md`). Not pushed yet. Push, PR and merge happen on the same day as the deploy.

### In flight / next step (checkpoint 4, 2026-10-03)
- **Next for 6a:** the user's go-ahead to push, after the auto-mode flag on the push and merge note (see the Phase 6a conversation). Then push `fix/security-platform`, open the PR, and send ethio-reviewer the PR number; it merges with `--merge` once CI is green. The post-deploy checks are `USER-ACTIONS.md` item 5 and `prod-rollout.sh verify 6a`.
- **Cleanup after the merge:** delete the SDD workspace `.superpowers/sdd/plan/`. Its ledger holds rulings R3–R18, and all of them are recorded in this section. Restore the dev stack (`ethiopialearn` DB) only once 7a and 6c no longer need `el_e2e`.
- **Runners:** in the previous session's scratchpad, `/tmp/claude-1000/-home-kal-Documents-code-ethi0-learning-platform/87145e98-2ae1-4654-aee6-31e251d3e4d8/scratchpad/`: `e2e-up.sh`, `e2e-run.sh <script…>`, `gate.sh`, `images.sh`. `demo-seed.mjs` must run after `e2e-up.sh` and before the other scripts.
- **Environment:** `export PATH="/home/kal/.local/opt/node22/bin:$PATH"`. Stage explicit paths. Production is off-limits.
