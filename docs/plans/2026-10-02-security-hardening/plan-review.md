# Plan review: Phase 6a, security hardening I (platform)

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)"). Checked against:
- on `origin/main`: the internal client, the gateway path handling, every `@Param`, the auth controller and service, `growth.service` / `sponsorship.service` / `payment.service`, and web `api.ts`;
- the approved Phase 3 and Phase 4 plans;
- the installed Nest 10.4.22, class-validator / validator 13.15 and TypeORM 0.3.30 sources.

Checked and OK:
- **Encoding at the source is enough.** The gateway matches routes on a lowercased, slash-collapsed copy of the path and forwards the raw path (`request-path.ts:19-23`, `main.ts:166-174`). The receiving Express app doesn't treat `%2F` as a separator. So an encoded value stays one segment end to end, and the non-goal "no gateway path guard" holds.
- **`UuidParam`.** `ParseUUIDPipe` without a version uses Nest's loose `all` pattern (`parse-uuid.pipe.js:51`). class-validator's `@IsUUID('all')` is stricter (version 1–8 and an RFC variant), but every id is generated, and the nil `PLATFORM_PAYEE_ID` is explicitly allowed. So neither rejects real ids.
- **`@Param` sweep.** `origin/main` has 110 (the plan says 111). Of these, 103 are id-style, and token ×3, uid ×2, title and email match the plan's non-uuid list. I spot-checked `multipart/:id` (uuid primary key on `UploadSession`) and `payments/:id` (looked up by `id`).
- **Password change.**
  - `api()` sends `credentials: 'include'` on every call (`api.ts:68-71`), so the browser stores the refresh cookie that `PUT /profiles/password` sets, even cross-site. A `Path=/api/v1/auth` cookie set from a `/profiles` response is valid.
  - `acceptInvite` already clears `must_change_password` (`auth.service.ts:296`).
  - Placeholder accounts (admin-created staff, invited instructors) carry a random password and the flag until they accept. The first-login exemption is needed for them, for example when they use Google sign-in before accepting.
- **Coupon lock.**
  - Under READ COMMITTED, a second checkout waits on `FOR UPDATE`, and its next statement sees the first checkout's committed insert.
  - A confirmation in flight is either still `pending` (counted as held) or has committed `uses + 1`. Phase 4's savepoint locks the coupon row inside the confirm transaction. So each redemption is counted once.
  - There's no lock-order cycle with Phase 4's confirm: confirm locks a payment row and then the coupon; checkout locks the coupon and inserts a new payment row.
- **Referral oracle.** `{ invited: n }` still reveals account existence for a one-address call (0 vs 1). That leaks nothing new, since signup already answers 409 "Email already in use" (`auth.service.ts` signup), but don't count it as a privacy property.

### Blockers
- **B1. Cancel and re-invite bypasses the institution invite cap, so one address can be emailed without limit** at Decision 10 (institution invite row)
  Scenario: Phase 3's `addInstructor` upserts the membership. Re-inviting a `removed` or `declined` row resets it to `invited` (access-control plan, decision 2), and cancelling moves `invited → removed` (decision 4). The row is reused because of `UNIQUE (institution_id, user_id)`, so its `created_at` never changes. A self-signed-up institution admin can therefore loop invite → cancel → re-invite on one victim address:
  - Each re-invite publishes `InstructorInvited` or `StaffInvited`, a branded email that names the institution, and the institution name is attacker-chosen free text.
  - The daily cap counts `institution_instructors` by `created_at`, so it never sees these re-invites.
  - The per-recipient rule ("an `invited` row from the last 24 h doesn't re-send") doesn't apply either, because after the cancel the row is `removed`.

  The only limit left is the per-minute `INVITES` bucket: 20 per minute, about 28,800 emails a day to one address. That is the P1-11 abuse this phase exists to close, and it fails the acceptance criterion for that path.

  Suggested fix: add `invited_at timestamptz`, set on every invite and re-invite. The daily cap counts rows with `invited_at` in the last 24 h for the institution, with an index on `(institution_id, invited_at)`. The no-resend rule checks `invited_at` whatever the row's status. Alternatively, count the audit rows Phase 3 writes for every invite. Add a test: invite, cancel, re-invite within 24 h → no second email, and the re-invite counts toward the cap.
  Response: **Fixed as suggested.**
  - A new `institution_instructors.invited_at` column (auth migration 1, backfilled from `created_at`) is set on every invite and re-invite.
  - The daily cap counts `invited_at` per institution, with a `(institution_id, invited_at)` index in auth migration 2.
  - The no-resend rule checks `invited_at` whatever the row's status. A re-invite within 24 h still updates the row, so the invite shows on `/account/invites`, but no email is sent.
  - Your test is in the test plan.

### Should-fix
- **S1. A learner's own failed or abandoned checkout blocks their coupon for an hour** at Decision 11 / 12
  Scenarios with a one-use code (`max_uses = 1`), or a per-user limit of 1:
  1. **Abandoned checkout.** A learner applies the code, the Chapa page opens, and they close it or pick the wrong method. Clicking Pay again returns "This coupon has been fully used." (or "You've already used this coupon.") for 60 minutes, because their own pending row is the hold.
  2. **Failed wallet payment.** Wallet checkout with too little balance: after Phase 4 the debit runs inside the confirm transaction, so it rolls back and leaves the payment `pending` with the `coupon_code`. That is the same hold, and switching to Chapa is then refused. Decision 11 releases the hold only when opening Chapa fails.

  Suggested fix: any failure after the insert and before a checkout is returned (wallet debit, Chapa open, or any other throw) goes through Phase 4's guarded fail path. Then, under the coupon lock, either:
  - return the payer's open checkout for the same coupon, course and purpose again, with the same `checkout_url`; or
  - fail it before counting. A late payment of it still confirms through verify, which is the plan's accepted "confirmed after the hold" case.

  Either way, check what Phase 4's `PaymentFailed` notification says to the learner in that case. Add a test: abandon, then retry → accepted.
  Response: **Fixed, using both options.** Under the coupon lock, before counting, the payer's own open checkout for the same coupon, course and purpose is handled first:
  - a Chapa retry gets the existing checkout back (no new row), which avoids a double payment from two open Chapa pages;
  - any other retry, such as switching to the wallet, guarded-fails it with reason `superseded`.

  Every failure after the insert also goes through the guarded fail path: a too-low wallet balance, a failed Chapa open, or any other throw.
  - These internal reasons (`superseded`, `wallet_insufficient`, `checkout_open_failed`) send the learner no "payment failed" notice.
  - The implementer checks `PaymentFailed`'s consumers. If the notification is the only one, the publish is skipped for these reasons; otherwise it is published with a `reason` that the notification skips.
  - Tests for abandon-then-retry (both branches) and the wallet case are in the test plan and the e2e script.

### Nits (optional)
- **N1.** Decision 2's dot-segment check should compare the WHATWG-normalized path instead of listing `.` and `..`. URL parsing also resolves `%2e`, `.%2e`, `%2e.` and `%2e%2e` as dot segments, and a misuse that bypasses the template, which is the case the check exists for, can carry those. The idea: reject when `new URL(path, gatewayUrl).pathname` differs from the path part of `path`, or doesn't start with `/api/v1/internal/`.
- **N2.** Index details for the migrations section:
  - Referral and payer emails are already lowercased on write (`growth.service.ts:267`, `sponsorship.service.ts:107`), so index the plain columns. A `lower()` expression index can't be expressed in the entity, and `db:check` would report it as drift (`RdbmsSchemaBuilder.dropOldIndices` drops any index missing from the metadata) unless it's declared with `@Index(name, { synchronize: false })`.
  - Pay requests store the requester in `recipient_user_id`, with `sponsor_id` null. So the per-account count needs `(source, recipient_user_id, created_at)`.
- **N3.** Count confirmed redemptions from `payments` rather than trusting `coupons.uses`. Phase 4 runs `uses + 1` in the same savepoint as cashback and the referral reward. If either of those fails, the payment confirms but the use is rolled back, and the coupon can go one past `max_uses` each time. The new `(coupon_code, created_at)` partial index serves `count(*) FILTER (WHERE status='confirmed')`. `GREATEST(uses, that count)` keeps legacy counts.
  Nit responses:
  - N1: taken. `get()` compares the WHATWG-normalized pathname, which catches the `%2e` forms.
  - N2: taken. The indexes are plain columns on the entities, pay requests are counted on `recipient_user_id`, and gifts on `sponsor_id`.
  - N3: taken. `confirmed = GREATEST(coupons.uses, count of confirmed payments)`, served by the `(coupon_code, created_at)` partial index.

## Round 2 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: the round-1 rework in `plan.md` (status "in review (round 2)"): decisions 2, 10, 11 and 12, the migrations and the test plan. I checked only the changed parts.

Round-1 findings:
- **B1** resolved. `invited_at` is set on every invite and re-invite, the cap counts it per institution with an index, and the no-resend rule ignores the row's status. Repeated re-invites of one row update the same row, so they still count once and send nothing within 24 h.
- **S1** resolved in substance:
  - every failure after the insert releases the hold;
  - the payer's own open row is handled under the lock before counting;
  - internal failure reasons send no notice.

  The "return the same checkout" branch has a gap, though; see B2.
- **N1, N2, N3** taken. Decision 2 now compares the WHATWG-normalized pathname, the indexes are plain columns on `recipient_user_id` and `sponsor_id`, and `confirmed = GREATEST(uses, count)`.

### Blockers
- **B2. A Chapa retry can return a different purchase's checkout, so a gift or pay request is paid for the wrong person** at Decision 11 step 3
  Gifts, pay requests and bulk orders each create their own row and pass its id in the payment `meta`:
  - gift: `meta: { sponsorship_id }` (`sponsorship.service.ts:85-92`);
  - pay request: `meta: { sponsorship_id }` (`:181-188`);
  - bulk order: `meta: { bulk_purchase_id, seats }` (`:239-245`).

  Step 3 matches the payer's open checkout only on payer, coupon, course and purpose.

  Scenario: a sponsor opens a gift checkout for alice with coupon X and doesn't pay yet. Within the hour, they gift the same course to bob with X. Step 3 finds alice's pending payment and returns her checkout, so the sponsor pays it believing it's bob's gift. Alice gets the course, and bob's new sponsorship row stays unpaid. The same happens:
  - for a payer settling two learners' pay requests for the same course;
  - for a bulk order retried with a different seat count, where the old amount and seat count get paid.

  Suggested fix: return the existing checkout only when it is the same purchase. That means `purpose = course` (the payer is the learner, and the course identifies it), or an identical `meta`. Otherwise supersede it. Add a test: two gifts of one course to different recipients with the same coupon → two different payments, and the first is superseded.
  Response: **Fixed. The match is now restricted to the same purchase, with one difference from your suggestion.**
  - **Same purchase:** `purpose = course` with the same course, or the same `sponsorship_id` / `bulk_purchase_id` in `meta`. Only then is the existing checkout returned, and only for a Chapa retry whose amount equals the new quote. Otherwise it is superseded.
  - **A different purchase is left alone,** not superseded. It counts as a hold like anyone's. Scenario: with a one-use 30% coupon, a sponsor opens a gift checkout for alice, then starts one for bob. If bob's superseded alice's, the sponsor could pay both Chapa pages, and verify would confirm both (Phase 4 allows failed → confirmed). That redeems the one-use coupon twice, which is the P1-13 hole again.
  - Instead, bob's gift is refused with a specific message: "This coupon is held by another checkout you started. Finish paying it, or try again after <time>."
  - Tests in the plan: two gifts to different recipients → the second is refused and the first untouched; a new bulk order → never the old checkout; a course retry after a price change → superseded.

## Round 3 (2026-10-02) · Verdict: APPROVED
Reviewed: the round-2 rework of decision 11, step 3, and its tests. I checked only the changed part.

- **B2** resolved. The existing checkout is returned only for the same purchase: the same course for `purpose = course`, or the same `sponsorship_id` / `bulk_purchase_id`. It also has to be a Chapa retry with an equal amount.
- **The difference from my suggestion is accepted.** Leaving a different purchase's checkout as a hold, rather than superseding it, is right. Because failed → confirmed goes through verify, superseding would let a payer pay both pages and redeem a one-use coupon twice. Superseding the *same* purchase stays safe: paying both pages buys the same course or sponsorship twice and gains nothing.

### Nits (optional)
- **N4.** The trade-off brings S1's symptom back for gifts and bulk orders. Each `POST /gifts` or bulk order creates a new purpose row, so a sponsor who abandons a gift checkout and clicks "Send gift" again is a "different purchase" and gets refused for up to an hour. Pay requests are unaffected, since they keep their sponsorship id. The message explains it. Two cheap ways to make "Finish paying it" actionable:
  - return the open checkout's `checkout_url` in the 400 body, and have the web show it as a link;
  - or treat a gift to the same recipient email and course as the same purchase.

No open blockers.
  Nit response (round 3):
  - N4: taken. The refusal's 400 body carries the blocking checkout's `checkout_url` for a link.

## Round 4 (2026-10-03) · Verdict: APPROVED (A1; checks only the A1 edits)
Reviewed: amendment A1 (P0-19, anonymous pay-link read). That covers the Status and Roadmap lines, the Goal criterion, Design §E and decision 15, the API contract line, step 3a, the step 8 e2e bullet, the test-plan bullet and the after-deploy check.

Checked against the code:
- **The bug is as described.**
  - `GrowthController` has a class-level `@UseGuards(RolesGuard)` (`growth.controller.ts:173-174`).
  - `RolesGuard` throws 401 with no user, whatever `@Roles` says.
  - The gateway marks only `GET /pay-requests/<token>` public (`routes.ts:54`). `POST …/pay` falls through to the `jwt` rule at `:55`.
- **No route clash from a second empty-prefix controller.** No other financial controller has a `GET pay-requests/<static>` route that `:token` could swallow, whatever the registration order. The `GrowthController` routes left on that path are both POST.
- **No global guard to undo.** Financial's `bootstrapService` adds only the internal-token middleware, which every gateway-proxied request passes. There's no `APP_GUARD` or `useGlobalGuards`. So a guard-less controller is really anonymous, and the guard-metadata spec tests the right thing.
- **The token pipe won't break existing links.** Every sponsorship token since `cadf91e` is `randomCode(24)` over `CODE_ALPHABET` (`sponsorship.service.ts:80,123,309`), so the 24-character pipe matches every live pay link.
- **The response shape is unchanged** (`payRequestPublic`, `sponsorship.service.ts:143-158`): first name, course, price, message, status, ids. The payer's email isn't in it, and the e2e asserts that.
- **Rejecting `@Public()` and per-method guards is right.** A bypass flag in the shared guard and ~25 method-level guards each add a fail-open path. Moving the route keeps `GrowthController` fail-closed by construction.
- **Rate limits are unaffected.** The anonymous GET falls in the per-IP `general` bucket. `INVITES` and `PAYMENT_INITIATE` (`rate-policy.ts:48-50`) still match only `POST /pay-requests` and `…/pay`.

### Blockers
None.

### Should-fix
None.

### Nits (optional)
- **N5.** The contract line says an unknown token gets 404 "Request not found". `byToken` actually answers "Not found" (`sponsorship.service.ts:518`), and only a non-pay-request token gets "Request not found". Either correct the line, or keep the e2e asserting the status only. The web shows its own card either way.
- **N6.** Add "a malformed token → 400" to the step 8 A1 bullets. It's one request, and it proves step 3's pipe is wired on the moved handler. The guard-metadata spec doesn't check pipes.
- **N7.** The after-deploy check creates a real pay request in production, and creating one emails the payer address. Say to use the user's own address as the payer.

No open blockers.
