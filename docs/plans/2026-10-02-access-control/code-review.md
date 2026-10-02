# Code review: Phase 3, access control and exploitable web holes

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: branch `fix/access-control` (6 commits, 3de83c3), base `feat/schema-migrations` (9769a3f), against the approved plan (round 2) and the logged deviations.
Checks run (read-only; the working tree and the running stack untouched):
- `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check` → 12/12 built, 37 suites / 736 tests pass, typecheck clean, no drift on the dev DB.
- `pnpm -C web typecheck && pnpm -C web test` → clean, 18 files / 295 tests pass. I skipped `pnpm -C web build`, because it would replace the `.next/` that the running `next start` on :3000 serves; the implementer's run and CI cover it.
- Auth migrations on a throwaway DB (`el_review_p3`, dropped afterwards), via the service CLI:
  - Fresh DB: all 4 migrations apply.
  - Revert ×2: the new columns go, 2 migrations recorded.
  - With 2 old-shape rows inserted, a rerun backfills them `active` with `accepted_at` set, and a new row defaults to `invited`.
  - Each constraint rejects its case: a second active membership for one user (`IDX_institution_instructors_active_user_id`), a duplicate (institution, user) pair, and a bad status (`CHK_institution_instructors_status`).
  - 0 INVALID indexes, and `db:check` reports auth `ok`.
- A direct probe of `safeNext` (Node) and of Next 14.2.35's `router.push` for off-origin targets (B1).
- Not rerun: the fresh-stack e2e (it needs the dev stack's ports, and the dev stack runs on real SMTP credentials). I rely on the implementer's run, and CI will run `e2e-institution.mjs` on the PR.

Against the plan, decisions 1–13 are implemented as written. The membership rules are enforced in SQL, not just in code:
- Accept is a conditional `UPDATE … WHERE user_id = me AND status = 'invited'` inside a transaction.
- The partial unique index makes a second active membership a 409, and serialises concurrent accepts.
- Admin status changes are conditional on the current status.
- Nothing writes `users.status`, `users.role` or sessions except the user's own accept.

Enumeration (plan-review S3) is closed:
- Every address gets the same 201.
- Staff and owners get the row but no email.
- Name and role appear only after acceptance.

Plan-review B1 holds: `acceptInvite` only sets the password, now behind `assertActive`, and staff onboarding is tested. Submit notifications follow `course.institution_id` (S1), and both submit paths take institution review only when that is set. The migrations follow Phase 2's pattern (S2).

The production fail-fast:
- Runs before Nest builds the app, so no migration runs on a bad config.
- Names variables, never values.
- Refuses `REQUIRE_INTERNAL_TOKEN` off.
- Is a no-op outside production.

`CERT_SIGNING_SECRET` is set in `.env.example`, compose and `render.yaml`, so removing the literal fallback breaks nothing. The deviations are sound and stay in scope:
- The SHA-256 denylist, with a spec that keeps it in step with `.env.example`.
- The membership-id status route.
- The `accepted_at` backfill.
- 401 from `assertActive`.
- `roleHome`.

The tests cover the plan's test list.

### Blockers
- **B1. `safeNext` can be bypassed with a dot segment, so the post-login open redirect (P0-02) is still exploitable** at `web/src/lib/safe-next.ts:19-29`
  Scenario: an attacker sends `https://<site>/login?next=/.//evil.com`. The raw string passes every check: it starts with a single `/`, has no backslash and no control characters. Then `new URL('/.//evil.com', BASE)` resolves the `.` segment, and the function returns the rebuilt path `//evil.com`. After the user signs in, `router.push('//evil.com')` resolves to `https://evil.com`. In Next 14.2.35 the app router's `isExternalURL` (`next/dist/client/components/app-router.js:95`) then hands it to `handleExternalUrl` (`router-reducer/reducers/navigate-reducer.js:103`), which does a full navigation off the site. `/a/..//evil.com`, `/..//evil.com` and `/%2e//evil.com` do the same; I checked all four in Node. The Google button (login and signup) uses the same helper. Acceptance criterion 3 ("only same-origin relative paths are followed") is unmet, and the phishing hole this phase exists to close stays open.
  Suggested fix: check the normalised result as well as the input, for example:
  ```ts
  const path = `${url.pathname}${url.search}${url.hash}`;
  // The parser resolves dot segments, so "/.//evil.com" comes out as "//evil.com".
  return path.startsWith('//') ? fallback : path;
  ```
  Then add `/.//evil.com`, `/a/..//evil.com`, `/..//evil.com` and `/%2e//evil.com` to the "falls back" cases in `safe-next.test.ts`.
  Response: **Fixed** as suggested: `safeNext` now also falls back when the normalised path starts with `//`. Your four payloads plus `/%2e%2e//evil.com` are in the "falls back" cases. All five failed before the fix (each returned `//evil.com`) and pass after it. Both sinks (login page, Google button) go through the helper; grep finds no other `next` sink. Live check on the local stack: a headless browser logged in as the seeded learner through `/login?next=…` with `/.//evil.com`, `/a/..//evil.com`, `/%2e//evil.com` and `//evil.com` and landed on `/dashboard` each time, with no request to evil.com; `next=/courses` still landed on `/courses`.

### Should-fix
None.

### Nits (optional)
- **N1.** Rollout step 1(b) in plan.md lists the secrets and `REQUIRE_INTERNAL_TOKEN` to confirm in Render, but the fail-fast now also refuses to boot every service, gateway included, when `WEB_URL` or `GATEWAY_PUBLIC_URL` is unset or points at localhost. Both are hand-set (`sync: false`) in the shared env group. They are almost certainly set today, since financial's Chapa callback already reads `GATEWAY_PUBLIC_URL`, so this is only for completeness. Add both to step 1(b), so the same-day deploy that rollout step 2 depends on can't stall on them.
  Response: **Done.** Rollout step 1(b) in plan.md now lists both, set and not localhost.

### Process note (not a code finding)
This plan folder is still listed in `.git/info/exclude`, so `plan.md`, `handoff.md`, `plan-review.md` and this file are in no commit. The implementer's permission mode blocked removing that line. Editing `.git/info/exclude` and committing the folder is left to the user (or a session the user explicitly asks). The handoff wants the folder committed on this branch before the PR.

## Round 2 (2026-10-02) · Verdict: APPROVED
Reviewed: `fix/access-control` at b31bb51 (one commit since round 1, touching only `web/src/lib/safe-next.ts` and its test; the API is unchanged), base `feat/schema-migrations` (9769a3f).
Checks run (read-only):
- `pnpm -C web typecheck && pnpm -C web test` → clean, 18 files / 300 tests pass (the 5 new dot-segment cases included).
- I transpiled the real `safe-next.ts` and fed it 23 payloads. All of them resolve to the site's own origin:
  - The round-1 four and `/%2e%2e//evil.com`.
  - Mixed case and chained dots: `/%2E/%2E//evil.com`, `/././/evil.com`, `/a/b/../..//evil.com`, `/./%2e//evil.com`, `/a/%2e%2e//evil.com`, `/.//evil.com?x=1#y`.
  - Encoded separators: `/.%2f/evil.com`, `/%2f/evil.com`, `/%5c/evil.com`, `/%09/evil.com`.
  - Lookalikes: `/@evil.com`, `/;//evil.com`, `/.;//evil.com`, and full-width space and dot.
  - The same-origin paths `/teach` and `/courses/c1?tab=reviews#top` still pass through unchanged.

Earlier findings:
- **B1: resolved.** The normalised result is checked as well as the input, so every dot-segment form that resolved to `//host` now falls back. Both sinks go through the helper. The tests pin all five forms, and the implementer's headless-browser check landed on `/dashboard` for each, with no request to the other host.
- **N1: taken.** Rollout step 1(b) lists `WEB_URL` and `GATEWAY_PUBLIC_URL`.

No new findings. The process note still stands: the plan folder is git-excluded and uncommitted, which is the user's to change before the PR.
