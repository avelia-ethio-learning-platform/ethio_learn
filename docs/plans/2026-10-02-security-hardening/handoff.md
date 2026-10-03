# Handoff: Phase 6a, security hardening I (platform)

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 3, see [plan-review.md](plan-review.md))
Code review goes to: ethio-reviewer (size L)

## What to build
- **Internal paths:** every value put into an internal path is encoded, through a typed helper the compiler enforces. Every uuid route param gets a pipe.
- **Password change:** it needs the current password, except for Google-only accounts and first login. The caller stays signed in and all other sessions are revoked.
- **Email:** referral invites email only new invitations. Referrals, pay requests, gifts and institution invites get daily caps per account, and referrals and pay requests also get caps per recipient.
- **Coupons:** they can't be over-redeemed. Open checkouts within 60 minutes count as holds, under a coupon row lock, and there is an optional per-user limit.

## Read first, in order
1. `plan.md` decisions 1–14 and the migrations section, then `plan-review.md`:
   - round 1 B1 explains why `invited_at`: invite → cancel → re-invite reuses the membership row;
   - round 1 S1 covers the payer's own failed or abandoned checkout;
   - round 2 B2 covers why only the same purchase is returned or superseded, and why a different purchase stays a hold.
2. `api/packages/common/src/http/internal-client.ts` (36 lines), `bootstrap.ts:51`, and the gateway's `request-path.ts:19-23` and `main.ts:166-174`. The 74 call sites will show up as compiler errors once `get()` takes an `InternalPath`.
3. Auth:
   - `profiles.controller.ts:40-66,124-134`;
   - `auth.service.ts:244-250,286-315,345-353`, and the login session issuing code the password change must reuse;
   - `dto.ts:151-160`;
   - `gateway/src/rate-policy.ts:20-80`.
4. Financial:
   - `growth.controller.ts:76-131,203-207,237-261`;
   - `growth.service.ts:106-139,266-298`;
   - `sponsorship.service.ts:85-140,181-188,239-245`;
   - `payment.service.ts:147-215` (`createSession`; read the post-Phase-4 version, with its guarded fail path and `confirmPayment`);
   - `entities.ts:76-77,187-231`.
5. Auth membership code after Phase 3 (`addInstructor`, the `institution_instructors` entity) for `invited_at`.
6. Web: `(account)/account/password/page.tsx`, `teach/coupons/coupon-manager.tsx`, `courses/[id]/enroll-panel.tsx:79-91,136-188`.

## Decisions already made (don't relitigate)
- **`internalPath` and `get()`:** `internalPath` is a tagged template that returns a branded `InternalPath` and `encodeURIComponent`s each value. `get()` requires the `/api/v1/internal/` prefix and an unchanged WHATWG-normalized pathname, with no `\` or `#`.
- **`UuidParam`:** the decorator is `ParseUUIDPipe`, version `all`. Tokens, certificate uids and the knowledge `:title` get their own pipes or stay free text, per the plan's list.
- **Password change:** `current_password` is required when a hash exists and `must_change_password` is false. The response is login-shaped: a fresh session for the caller, after `revokeAllSessions`.
- **Profile and reset:** `GET /profiles/me` adds `has_password`. `confirmPasswordReset` clears `must_change_password`.
- **Rate limits:**
  - `PUT /profiles/password` and `DELETE /profiles/me` → `auth-strict`;
  - `GET /coupons/validate` → `community-write`.
- **Email caps:** counted from existing rows; over a per-account cap → 429. Referral per-recipient over-cap addresses are skipped silently. A re-invite within 24 h of `invited_at` sends nothing, whatever the row's status.
- **Coupon checkout, in one transaction:**
  1. `FOR UPDATE` on the coupon;
  2. handle the payer's own open checkout for the same purchase: return it for a same-amount Chapa retry, otherwise supersede it;
  3. `confirmed = GREATEST(uses, confirmed payments)`, plus holds;
  4. insert.

  Then:
  - Every failure after the insert goes through the guarded fail path, and these internal reasons send no failure notice.
  - A different purchase's open checkout is a hold. Its refusal message includes its `checkout_url`.
  - `uses + 1` stays at confirmation, as in Phase 4.

## Gotchas learned while planning
- **Branded type migration:** `InternalPath` turns all 74 call sites into compiler errors. Fix them in one commit per service so the reviewer can scan them. Tests that mock `internal.get` with `jest.fn` keep working.
- **The `@Param` sweep:** `origin/main` has 110, of which 103 are id-style. Verify that every param you pipe really is a uuid column. `multipart/:id` and `payments/:id` were spot-checked by the reviewer. The nil `PLATFORM_PAYEE_ID` must still pass.
- **Indexes:**
  - Referral and payer emails are lowercased on write, so the indexes are plain columns declared on the entities. A `lower()` index shows as `db:check` drift.
  - Pay requests: the requester is `recipient_user_id` (`sponsor_id` is null). Gifts use `sponsor_id`.
- **`PaymentFailed` consumers:** check them before skipping the publish for internal reasons (`superseded`, `wallet_insufficient`, `checkout_open_failed`).
- **The refresh cookie from `PUT /profiles/password`:** `api()` sends `credentials: 'include'`, so the browser stores the cookie, and a `Path=/api/v1/auth` cookie set from a `/profiles` response is valid. Mirror the login controller's cookie options exactly.
- **Secrets:** the secret-guard hook scans untracked files for `api/.env` values. Tests use obviously fake passwords and tokens; never paste dev defaults into docs or scripts.
- **Public repo:**
  - The plan folder is in `.git/info/exclude`. On your branch, remove its line and commit the folder, or use `git add -f` if editing the exclude file isn't allowed in your session; ask the user.
  - Push only when the user can merge and deploy the same day.
  - Don't put working exploit strings in commit messages; describe the class of issue.
- **Environment:**
  - the node PATH export and pnpm `--store-dir`;
  - Postgres on 55432;
  - restart the backend with `scripts/stop-backend.sh && scripts/start-backend.sh`, and web by killing the `next-server` PID.
- **Production is off-limits.** The post-deploy probe is for the user.

## How to run
- `pnpm -C api build && pnpm -C api test && pnpm -C api db:check`
- `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`
- Every e2e script, with the new `e2e-security.mjs` before `e2e-smoke.mjs`.
- Migrations: apply on a fresh and an existing local DB, and check that `migration:revert -t none` round-trips.

## Branch
First close Phase 5's two code-review should-fixes on `fix/web-p0` (fix or defer each, as `code-review.md` asks). Then create `fix/security-platform` from that `fix/web-p0` tip. The stack is linear: main ← `fix/access-control` (#20) ← `fix/payment-integrity` ← `fix/web-p0` ← `fix/security-platform`. Tell ethio-reviewer the base (`fix/web-p0`).
- Don't push and don't open a PR until #20, Phase 4 and Phase 5 have merged into main, and then only when the user can merge and deploy 6a the same day (security phase). Those merges and deploys are the user's.
- They merge as merge commits, so their SHAs stay the same. When they land, run `git merge origin/main` into `fix/security-platform` (no rebase). That also brings in Phase 3's `.gitleaks.toml` allowlist commit `9274e9f`.
- Stage explicit paths: several other plan folders in the working tree are untracked and belong to other phases.

## Definition of done
- The acceptance criteria are met, and the step 8 e2e checks pass, including the concurrent one-use coupon check and abandon-then-retry.
- The api build, tests and `db:check` pass; the web typecheck, tests and build pass; the images build.
- The plan checklist is ticked, with deviations logged.
- Then request code review from ethio-reviewer.
