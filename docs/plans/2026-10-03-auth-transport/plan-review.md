# Plan review: Phase 11b, auth transport and tests for the high-risk paths

## Round 1 (2026-10-03) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)"), against the code at `62e29a1` (`fix/web-p0`) and the 6a, 7b and 9d plans it builds on.

Verified as the plan states:
- **Cookie:** `el_refresh` is set and cleared only in `auth.controller.ts` (`:92-124`), with `path: '/api/v1/auth'` and no `domain`. So it binds to whichever host the browser sees, and no auth-service change is needed for the move.
- **Routes:** every route under `/api/v1/auth/` is a GET or a POST (`auth.controller.ts:14-86`). The handler's GET/POST/DELETE covers them.
- **Limiter keys:** `userKey` falls back to `ipKey` (`main.ts:104-107`). Moving `ipKey` to `req.clientIp` therefore also fixes the anonymous `general` bucket (login and refresh carry no bearer), not just `auth` and `auth-strict`.
- **Service worker:** it ignores non-GET requests, and its `isApiRead` list has no `/auth` path (`sw.js:37-44`). So moving auth to the web origin puts no auth response into Cache Storage.

### Answers to the planner's questions
1. **Only `/auth/*` through a route handler:** agreed. It's the right boundary, but one cookie-setting route lives outside `/auth` (B1).
2. **The secret-gated client IP:** agreed, including the `rewrites()` rejection and stripping in every case. On Vercel, taking `x-real-ip` (then the first `x-forwarded-for` entry) is sound.
3. **Web Locks plus BroadcastChannel:** agreed.
   - **Why it holds:** correctness comes from the lock plus the shared cookie jar. Tab B's refresh starts only after tab A's `Set-Cookie` has landed, so it presents the new cookie even if tab A's broadcast hasn't arrived yet. The "newer token" check saves a call; it isn't needed for safety.
   - See N1 on how long the lock is held.
4. **Dropping shared `storageState`:** agreed. A saved state is single-use once every load rotates the cookie. Per-test login also needs the `auth` limit raised, not only `auth-strict` (S3).
5. **The deploy-skew note:** agreed as written. Merging at a quiet time is enough before launch.

### Blockers
- **B1. A password change signs the user out at the next reload** at decision 2 ("All `/auth/*` calls (…, password change, …) use the same-origin base") and decision 1 (only `/api/v1/auth/*` is proxied)
  - **6a's flow:** 6a decision 5 makes `PUT /profiles/password` revoke every session, the caller's too, and issue a fresh one in the response: an access token in the body and a new refresh cookie. That route is under `/profiles`, not `/auth`.
  - **With this plan:** `api()` sends it direct to the gateway with `credentials: 'omit'`, so the browser drops the new `Set-Cookie`. It would bind to the gateway host anyway.
  - **What breaks:** the web-host cookie still holds the revoked token. The next hard load's boot refresh gets a 401, the plan clears the hint, and the user is signed out. That is P1-05's "logged out after changing the password", which 6a fixed. Every reload now refreshes, so it happens at the very next one.

  Suggested:
  - send `PUT /api/v1/profiles/password` through the web origin as well. Either add a second route handler, or give the one handler a short allowlist of cookie-setting paths with PUT added.
  - The cookie's `Path=/api/v1/auth` attribute is stored as is from that response, so the next refresh sends it.
  - Add a Playwright spec: change the password, reload, still signed in.

  Response: Fixed. Decision 1 now has two thin route files sharing `lib/gateway-proxy.ts`: `auth/[...path]` (GET/POST/DELETE) and `profiles/password` (PUT). `api()` picks the same-origin base for the `/auth/` prefix or exactly `/profiles/password`. Decision 1 notes that the cookie's `Path=/api/v1/auth` is stored as is. The Playwright list (decision 7, step 8) gains "change the password, reload, still signed in, the next refresh is a 200". Current state records 6a's flow.

### Should-fix
- **S1. An offline reload shows the waking notice and a signed-out header instead of the cached course** at decision 2 (boot: "hint plus a network error → not ready and the waking notice")
  - **Today:** offline learning is a shipped feature. The service worker serves cached reads (`sw.js:3-13`), and the learn page queues writes and says "You're offline — your progress is saved on this device" (`learn/[courseId]/page.tsx:226`). It works after a reload because `el_auth` gives the user synchronously.
  - **With the plan:** a learner reopens a cached lesson with no signal, or a mobile browser restores a discarded tab while offline. The boot refresh fails with a network error and the page stays "not ready" with the waking notice. `user` is null, so the header and the watermark lose the user, and the boot keeps retrying a refresh that can't succeed.

  Suggested:
  - keep the non-secret `user` next to the hint (`el_session = { user }`, no token), so the UI renders as signed in at once;
  - when the boot refresh fails while `navigator.onLine === false`, stay signed in offline: reads come from the service-worker cache and writes go to the offline queue. Refresh on the `online` event, and show the waking notice only when online;
  - vitest: hint plus offline → user present, no waking notice, a refresh on `online`.
  - This also lets signed-in users see their header before the boot round trip (Vercel function, gateway, auth) completes.

  Response: Fixed as suggested. The hint is now `el_session = { user }` (public user, never a token; a vitest asserts that). Boot takes the hint's `user` at once. Offline (at boot, or a network error while `navigator.onLine === false`) → `ready` with the user and no token, no waking notice, no backoff; the `online` event runs the refresh before the outbox flushes. I checked that the outbox (`offline-queue.ts`) stores no token and the service worker matches on the URL, so bearer-less reads hit its cache. Step 6 adds the vitests. Offline stays out of Playwright (SW cache makes it flaky).
- **S2. Every hard load now rotates the refresh token, so a lost rotation response becomes a regular sign-out** at decision 2 (boot) and Non-goals (rotation unchanged)
  - **The window:** auth deletes the old token before the response reaches the browser (`auth.service.ts:201-219`). If the browser never receives the response, it keeps a cookie whose token no longer exists. Two everyday triggers:
    - the user reloads, or the page does a full navigation, while the boot refresh is in flight;
    - the route handler's 20 s timeout fires after auth has already rotated (for example a Neon cold start behind a slow auth).
  - **What breaks:** the next load's refresh gets a 401, the hint is cleared and the user is signed out.
  - **Why it's new:** today the same window exists once per 15-minute access token. With a refresh on every hard load and every new tab, it's hit far more often.

  Suggested:
  - a short reuse grace in `refresh()`: on rotation, `EXPIRE` the old key for about 30 s instead of `DEL`, so a retry with the old cookie still gets a token. This is the usual "reuse interval". It isn't reuse detection, so the Non-goals hold.
  - Cover the grace and its expiry in the auth unit spec with a fake clock. `e2e-smoke` then checks that the old cookie works inside the grace, and drops its "old cookie → 401" step.
  - Or keep strict rotation, and say in Risks that an interrupted boot refresh signs the user out.

  Response: Fixed, with one change to the mechanism: a grace pointer instead of `EXPIRE` (new decision 8). On rotation, `refresh:grace:<old>` → `<new>` (30 s, same `MULTI`). A missing token whose pointer leads to a successor that still exists gets a fresh access token and **the same successor**, after the usual user checks. Why not `EXPIRE`: a retry would mint a second live 30-day session, the lost one stays orphaned, and the old key would either stay in or leave the user's set (stale members, or a 30 s window that `revokeAllSessions` misses). The pointer only leads to a token still in the set, so revoke-all and logout are untouched, and logout with an old token inside the grace also revokes its successor. One hop only. Unit specs with a fake clock (step 4a); `e2e-smoke` checks old-inside-grace → same successor, then successor rotated → old is 401. Non-goals and Risks updated.
- **S3. The per-IP `auth` limit (30/min) now meets one refresh per page load** at decision 3 and Configuration (CI raises only `RATE_LIMIT_AUTH_STRICT_PER_MIN`)
  - **CI (certain):** locally and in CI there's no secret, so every refresh is keyed by the Next server's address. The Playwright suite now refreshes on every page load in every spec, so any minute with more than 30 page loads gets 429s. The boot then stays "not ready", and specs time out.
  - **Production (shared IPs):** the gateway's own comment says learners share campus and carrier NAT IPs (`main.ts:96-99`). That's why user traffic is keyed by user id. Refresh is anonymous, so it stays IP-keyed: an institution class of 30+ opening the site in the same minute gets 429s, and the waking notice, on boot.
  - **What the IP key protects:** nothing for refresh. The token is a UUID plus 32 random hex characters (`auth.service.ts:365`), so it can't be guessed.

  Suggested:
  - key `POST /auth/refresh` by a hash of the `el_refresh` cookie (for example 10/min per token), with the per-IP cap kept only as a high backstop;
  - raise `RATE_LIMIT_AUTH_PER_MIN` in the e2e stack along with the strict limit.

  Response: Fixed as suggested. New `auth-refresh` bucket for `POST /auth/refresh`: 10/min (`RATE_LIMIT_AUTH_REFRESH_PER_MIN`), keyed by `rt:` plus a SHA-256 prefix of `el_refresh`, IP when there's no cookie. `general` (300/min per IP) is the backstop that already sits on top of every bucket, so no extra per-IP limiter. CI and the local scripts raise both `RATE_LIMIT_AUTH_STRICT_PER_MIN` and `RATE_LIMIT_AUTH_PER_MIN`. Gateway spec: two cookies from one IP get separate buckets.
- **S4. `SameSite=Strict` adds nothing over `Lax` here, and risks a sign-out on cross-site arrivals** at decision 5
  - **Lax already covers it:**
    - the cookie is only read by `POST /auth/refresh` and `POST /auth/logout`;
    - Lax already withholds cookies from every cross-site POST, top-level or subresource;
    - the one GET under `/auth` (`invite/:token`) ignores the cookie.
  - **Strict's extra rule:** it only affects cross-site arrivals, and learners arrive cross-site after Chapa's checkout and from every email link (verify, invite, reset).
  - **The failure:** suppose a browser withholds Strict cookies on the first requests after such an arrival. WebKit has behaved this way, and I couldn't confirm its current behaviour. The boot refresh then gets a 401, and the plan clears the hint, signing the learner out right after they pay.

  Suggested: `COOKIE_SAMESITE=lax`, plus a Playwright spec in both projects that arrives from another site and stays signed in. For example, a link on a page served from `127.0.0.1` to `localhost:3000`; those are different sites. If you keep Strict, that spec is what proves it.

  Response: Fixed. `COOKIE_SAMESITE=lax`, with Strict listed as rejected and why (decision 5). Decision 7 adds the cross-site arrival spec (a page on `127.0.0.1` links to `localhost:3000/dashboard`) in both projects. Acceptance criteria, API contract, Configuration and the skew risk now say Lax.

### Nits (optional, max 3)
- **N1.** Don't hold the cross-tab lock across Phase 5's wake backoff. Make one attempt per lock acquisition and release the lock between retries. Otherwise one waking tab blocks every other tab's refresh, and a login's broadcast, for the whole backoff.
- **N2.** The route handler attaches the proxy secret. Have it refuse (404) any request whose upstream path doesn't start with `/api/v1/auth/` once built, as a cheap guard against a future path-joining change.
- **N3.** Decision 6's gateway spec should also assert that `x-web-proxy-secret` and `x-web-client-ip` are stripped when the secret is wrong, not only when it's right.

  Nit responses: N1 taken (decision 4: one attempt per lock acquisition, the backoff waits outside it; step 6 vitest). N2 taken (decision 1: path guard, 404 before any fetch; step 5 vitest). N3 taken (decision 6 and step 4: stripped whether the secret is right, wrong or absent).

## Round 2 (2026-10-03) · Verdict: APPROVED (checks the round-1 fixes only)
Reviewed: `plan.md` (status "in review (round 2)").

- **B1 resolved.**
  - **Routing:** `PUT /api/v1/profiles/password` gets its own thin handler on the shared `gateway-proxy.ts`, and `api()` routes exactly that path same-origin.
  - **The cookie:** browsers store a `Set-Cookie` whose `Path` differs from the request path (RFC 6265 puts no prefix rule on it), so the `Path=/api/v1/auth` cookie from the password response lands where the next refresh sends it.
  - **The spec:** the Playwright case (change the password, reload, refresh 200) is the right one.
- **S1 resolved.** The hint carries the public `user`, and the offline boot is `ready` with the user and no token, with no notice and no backoff. The refresh runs on `online` before the outbox flushes. Reads without a bearer still hit the service worker, which matches on the URL.
- **S2 resolved, and the pointer is better than my `EXPIRE` suggestion.** It issues no second session, and since it only leads to a successor still in the user's set, `revokeAllSessions` and logout need no change. I walked through the sequences:
  - **Lost response:** the old token inside 30 s gets the same successor.
  - **Two tabs without Web Locks:** the second tab gets the first tab's successor instead of a 401.
  - **`e2e-smoke`:** T0→T1, then T0→T1 again, then T1→T2, then T0 → 401 because T1 is gone. That matches the decision.
  - **One hop and suspension:** the user checks still run, and logout with the old token revokes the successor.
- **S3 resolved.**
  - **Refresh:** it has its own bucket keyed per token, and the hash prefix keeps the cookie out of the limiter's keys.
  - **CI limits:** both e2e limits are raised.
  - **Backstop:** `general` stays the per-IP backstop. Random cookies can't buy extra attempts at a token that can't be guessed anyway.
- **S4 resolved.**
  - **Lax:** the cookie is Lax, and Strict is recorded as rejected with the reason.
  - **The spec:** `127.0.0.1` and `localhost` are different sites, so the arrival spec really is cross-site. With Lax it passes in both browsers, and it guards later changes.
- **N1–N3:** taken.

No new findings.

## Drift check 2026-10-07 (vs origin/main b4666f2) · Verdict: DRIFT: D1–D3
Not a review round: the plan stays APPROVED. This is a read-only check of what 11b relies on against main after 6b, 6d, 8a, 8b, 11a (#32) and Phase 10 (#37). I read, in `../ethi0-drift-main`:
- `web/src/lib/api.ts`, `hooks.ts`, `Providers.tsx`, `sw.js`, `csp.mjs`, `e2e/test.ts` and the `getAuth`/`setAuth` callers;
- auth's `refresh-cookie.ts`, `auth.controller.ts`, `profiles.controller.ts` and `auth.service.ts`;
- the gateway's `main.ts` and `rate-policy.ts`;
- `ci.yml`, `rulesets/main.json`, `lint-baseline.json`, both `eslint.config.mjs`, `e2e-smoke.mjs` and `demo-seed.mjs`.

### Mismatches (fold in before or during the step named)
- **D1. Step 10's lint commands fail on main whatever 11b does.**
  - **What main does now:** `pnpm -C api lint` and `pnpm -C web lint` are bare `eslint .`. Since 11a, the existing problems are baselined rather than fixed: `no-floating-promises` is `'error'` (`api/eslint.config.mjs:13`), with 55 in `.github/lint-baseline.json`. So eslint exits 1 on a clean main.
  - **What CI requires:** the `lint` context runs `node scripts/lint-check.mjs` after the api build (`ci.yml:195-214`).
  - **Fold in:** replace the two lint commands in the gate with `pnpm -C api build && node scripts/lint-check.mjs`. New code mustn't raise any rule's count. A new `any` in the extracted gateway middleware, or a floating promise in `auth-store.ts`, turns the required `lint` check red.
- **D2. Raising `auth-strict` for the e2e stack makes CI's smoke step fail.**
  - **The conflict:** the Configuration sets `RATE_LIMIT_AUTH_STRICT_PER_MIN` "high" for the whole e2e stack. The gateway reads it once at boot. `ci.yml:176` then runs `E2E_CHECK_RATE_LIMIT=1 node scripts/e2e-smoke.mjs`, whose loop makes 15 failed logins and requires a 429 (`e2e-smoke.mjs:121-130`).
  - **The result:** with the limit above 15, the check "login brute force hits 429" fails, and `e2e`, a required context, goes red. The step has been in CI since July, so this isn't drift from the merges, but it's a certain red build.
  - **Fold in (step 8):** the smoke loop runs `Number(process.env.RATE_LIMIT_AUTH_STRICT_PER_MIN ?? 10) + 5` attempts, and the CI step passes the same value. `ci.yml`'s `sleep 60` before Playwright (`:172`) can then go.
- **D3. Phase 10's CSP fixture has to stay on every spec (step 8).**
  - **What main does now:** every spec imports `test` from `web/e2e/test.ts`. Its automatic `cspViolations` fixture fails a test on any CSP violation (Phase 10).
  - **The risk:** if `loggedInAs` is built with `base.extend` on `@playwright/test`, every spec moved to it, the new WebKit project included, silently stops checking the policy.
  - **Fold in:** in decision 7, say that `loggedInAs` extends `./test`'s `test`.

### Confirmed as the plan assumes (line drift noted)
- **Phase 10's CSP needs no change, and `csp.mjs` must stay as it is.**
  - The new same-origin `/api/v1/auth/*` and `/api/v1/profiles/password` routes are covered by `connect-src 'self'`.
  - Every other call stays direct (Non-goals), so the API origin must stay in `connect-src`. Phase 10's plan Non-goal ("Phase 11 tightens `connect-src` to `'self'`") is wrong for 11b's design. Followed, it would block every non-auth call, in CI first and in production after `CSP_ENFORCE=true`. Leave `csp.mjs` alone.
  - `/api/csp-report` is a route handler now, so "no route handlers exist" in Current state is stale. The two don't overlap.
- **The service worker:** `isApiRead` (`sw.js:38-41`) doesn't match `/auth`, so the proxied auth calls are never cached. Its logout hook still keys on `el_auth` (`Providers.tsx:21`), which decision 2 replaces.
- **The refresh cookie:**
  - its attributes now live in one helper, `refresh-cookie.ts`, shared by `auth.controller.ts:99-100` and `profiles.controller.ts:51` (6a). "The cookie's attributes don't change in code" still holds.
  - The helper's comment tells operators to set `COOKIE_SAMESITE=none` for the Vercel and Render split. After 11b that advice is wrong, so step 7 should update the comment along with `render.yaml:124-125` (still `none`).
- **Rotation:** `auth.service.ts:254-271` still does a separate `del`, then `srem`, then `issueRefreshToken`. There's no `MULTI` yet, so step 4a creates it.
  - Tokens are still a UUID plus 32 hex characters (`:445`), so S3's "can't be guessed" holds.
  - `logout` is at `:408` and `revokeAllSessions` at `:423`.
- **Gateway:**
  - `trust proxy 1` is at `:72`, `ipKey` at `:100`, and the inline middleware at `:183-214`;
  - `verifyBearer` and `validInternalToken` are still unexported (`:50`, `:60`), and `bootstrap()` still runs on import (`:236`);
  - `classifyRequest` still maps refresh to `auth` (`rate-policy.ts:72`).
- **Web callers:**
  - `help/page.tsx:122` still reads `getAuth()` at render;
  - `account/password/page.tsx` now reads `useAuth()` (`:15`), and `setAuth` is at `:62`;
  - the other `setAuth` callers are login `:36`, Google `:66`, accept-invite `:53`, `account/page.tsx:175` and `Header.tsx:107`.
- **11a's CI:**
  - the required contexts are `api`, `web`, `e2e`, `secret-scan` and `lint` (`rulesets/main.json:30-34`). Running the api job's `test:coverage` and putting WebKit inside `e2e` adds no new context.
  - The web job already runs `test:coverage` (`ci.yml:78`), but api still runs `pnpm test` (`:56`), and api has no `test:coverage` script yet, so step 2 stands.
  - The Playwright install is `ci.yml:164` (`--with-deps chromium`, cached by version), so add `webkit` there.
  - `e2e` has a 40-minute timeout (`:85`) against about 13 minutes today, which leaves room.
- **Phase 10's i18n:** 11b adds no user-facing string to the translated pages. If one appears (for example a "signed out in another tab" line), it goes in both `i18n-en.ts` and `i18n-am.ts` (the parity test), and in `docs/i18n/am-review.md`.
- **Base:** `chore/ci-gates` has merged. 9c's `service_waking` → `WakingError` mapping and 9d's request id and access log aren't on main yet (`api.ts` has no `service_waking`). So 11b starts from the 9e tip, or from main once 9c–9e have merged, as the plan's base rule already says.
- **Not 11b's, for 11c:** Dependabot #41 (express-rate-limit 7 → 8) and #43 (http-proxy-middleware 3 → 4) touch the gateway file that step 3 splits up. Whichever lands second rebases.
- `demo-seed.mjs:374` still prints "certificate issued" without checking, and `e2e-smoke.mjs` has no refresh call, so P1-29's script gaps stand. `auth.session.spec.ts` is still the base for the auth specs.

### Planner response to the drift check 2026-10-07 (ethio-planner [5b0124])
- D1–D3: all taken as you worded them (plan "Amendments 2026-10-07"). The `csp.mjs` and refresh-cookie notes are folded in too.
- Order change: 11c now goes before 11b (Next 14 security alerts), so 11b writes its route handlers Next 15 style.
- The plan stays APPROVED.
