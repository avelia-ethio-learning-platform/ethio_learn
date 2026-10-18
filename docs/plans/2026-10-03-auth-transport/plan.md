# Phase 11b: Auth transport and tests for the high-risk paths

Status: approved (round 2); drift check 2026-10-07 D1–D3 folded in (see Amendments)

## Amendments 2026-10-07 (planner, from the drift check; these override the text below)
- **D1 (gate):** the lint gate is `pnpm -C api build && node scripts/lint-check.mjs`, not `pnpm -C api lint` or `pnpm -C web lint`, which fail on a clean main since 11a's baseline. New code mustn't raise any rule's count.
- **D2 (rate-limit smoke):** in step 8, `e2e-smoke.mjs`'s brute-force loop runs `Number(process.env.RATE_LIMIT_AUTH_STRICT_PER_MIN ?? 10) + 5` attempts, and the CI step passes the same value that the e2e stack uses. Then `ci.yml`'s `sleep 60` before Playwright can go.
- **D3 (CSP fixture):** decision 7's `loggedInAs` extends `./test`'s `test` (Phase 10's `cspViolations` fixture), never `@playwright/test`'s `base`, so every spec, WebKit included, keeps failing on CSP violations.
- **Also:** leave `csp.mjs` as it is. Every non-auth call stays direct, so the API origin stays in `connect-src`, and Phase 10's "Phase 11 tightens connect-src" doesn't apply. Step 7 also updates `refresh-cookie.ts`'s `COOKIE_SAMESITE=none` comment and `render.yaml`'s `none`.
- **Next 15 (2026-10-07):** 11c now runs **before** 11b (security alerts on Next 14; see 11c's Amendments). Write the new route handlers in Next 15 style: `await` `params`, `cookies()` and `headers()`. Whichever of 11b and 11c merges second merges main and resolves. 11b's gate gains its auth Playwright specs in chromium **and** webkit on Next 15, and its Rollout gains a watch for 5xx on `/api/v1/auth/*` after the deploy. Both used to sit in 11c.
- **Base and start (2026-10-07):** an early start in `../ethi0-11b` on branch `fix/auth-transport`, from the 9d tip `feat/observability` (`c936e8c`). That tip carries 9c's typed client errors and 9d's request id. Work stays uncommitted until the day's commit budget allows. Merge the 9c, 9d and 11c tips as they move.

Size: L (sessions: 4 — ethio-impl implements, ethio-plan-review reviews the plan, ethio-reviewer reviews the code). Auth across web, gateway and the auth service, plus tests for login, payments, entitlements and the mesh.
Base branch: the tip of the stack when it starts, expected `chore/ci-gates` (11a), or `origin/main` if everything below has merged. This phase builds on:
- Phase 5's `api.ts`: single-flight refresh, `WakingError`, `wake.ts`, and the Playwright harness;
- 9c's typed client errors and the web's `service_waking` → `WakingError` mapping;
- 9d's request id, the gateway access log and `redactPath`;
- 11a's lint and required checks.

Feature branch: `fix/auth-transport`.
Roadmap: phase 11b (see 11a's "Roadmap change"). Findings: P1-07 and P1-29.

## Goal
A script injected into the page can't walk away with a session that outlives the tab, and Safari and Brave users stay signed in past the 15-minute access-token expiry. The flows that lose money or lock people out (login, refresh, reset, payment to entitlement, the gateway's auth) can't regress without a red build.

Acceptance criteria:
- **No token at rest in the browser (P1-07):**
  - the access token lives only in memory: nothing in `localStorage`, `sessionStorage` or a readable cookie holds it;
  - one non-secret hint (`el_session` in `localStorage`, holding only the public `user`, never a token) says "this browser had a session", so anonymous visitors make no auth call at all.
- **First-party refresh cookie (P1-07):**
  - every `/api/v1/auth/*` call, and `PUT /api/v1/profiles/password` (6a issues a fresh session there), goes to the web's own origin, through Next route handlers that forward it to the gateway;
  - the refresh cookie is set on the web host, `SameSite=Lax`, `HttpOnly`, `Secure` in production, `Path=/api/v1/auth`. Safari's and Brave's third-party cookie blocking no longer applies.
  - All other API calls still go straight to the gateway, with the in-memory bearer token and without cookies.
- **Sessions survive reloads, tabs, password changes and lost responses:**
  - a reload with the hint runs one refresh and the user stays signed in;
  - after a password change, a reload keeps the user signed in (6a's P1-05 fix holds);
  - two tabs refreshing at the same moment both stay signed in (refresh tokens are single-use, so refreshes are serialized across tabs);
  - a refresh whose response never arrived (a reload mid-refresh, a proxy timeout) doesn't sign the user out: the old cookie still works for 30 s and gets the same successor;
  - arriving from another site (Chapa's checkout, an email link) keeps the user signed in;
  - logging out in one tab logs out the others;
  - while the refresh can't reach auth (asleep), the page shows Phase 5's waking notice, never the login page;
  - a reload while offline keeps the user signed in on cached pages, with no waking notice, and refreshes when the connection returns.
- **Per-user rate limits still work through the proxy:** the gateway keys `auth-strict` and `auth` limits (and 9d's access-log `ip`) by the real client IP. It trusts that IP only from the web's route handler, proved by a shared secret. A client can't spoof it. Refresh is limited per refresh token, so a class behind one NAT address can boot at once.
- **Tests for the high-risk paths (P1-29):** each behaviour in decision 6's list has a test that fails if the behaviour breaks:
  - the gateway's auth middleware runs in specs, extracted from `bootstrap()`;
  - `e2e-smoke.mjs` covers refresh rotation;
  - `demo-seed.mjs` checks that its certificate really exists.
- **Coverage is measured:** `pnpm -C api test:coverage` prints per-package numbers. CI shows them in the job summary (not a gate). Progress records before and after for auth, gateway, financial, enrollment and outcomes.

## Non-goals
- **Proxying the whole API through Vercel.** Only `/api/v1/auth/*` and `PUT /api/v1/profiles/password` set or read the cookie (decision 1).
- **Refresh-token reuse detection or token families.** Rotation stays single-use: a used token is invalid, apart from the 30 s grace that hands back the same successor (decision 8). That grace is a retry window, not reuse detection.
- **Moving uploads, media or the wake pings.** They don't use cookies.
- **Carrying existing sessions over.** Today's refresh cookies live on the API host, so everyone signs in once more after this deploy (Rollout).
- **Coverage thresholds as a CI gate.** The tests block regressions; a threshold can follow once the numbers settle.
- **Next 15 and dependency upgrades** (11c).

## Current state
Line numbers at `62e29a1` (the Phase 5 branch); 6a, 7b and 9c–9e touch some of these files, so the implementer re-finds each site by its code.

- **Web token storage** (`web/src/lib/api.ts`):
  - `getAuth()`/`setAuth()` read and write `localStorage.el_auth` (`:22-39`), which holds the access token and the user;
  - `API_URL` comes from `NEXT_PUBLIC_API_URL` (`:7`);
  - every request uses `credentials: 'include'` (`:148-153`);
  - the refresh is single-flight within a tab (`:61-102`, Phase 5).
- **Readers of auth state:**
  - `lib/hooks.ts` `useAuth()` (`ready` turns true right after mount; cross-tab sync through the `storage` event);
  - `components/Providers.tsx:18` clears the service worker's API cache when `el_auth` is gone;
  - direct `getAuth()` reads in `account/password/page.tsx:32` and `help/page.tsx:114`;
  - `setAuth` after login, Google sign-in and invite acceptance (`login/page.tsx:31`, `GoogleSignInButton.tsx:65`, `accept-invite/page.tsx:46`), and on logout (`Header.tsx:67`, `account/page.tsx:149`).
- **The refresh cookie** (`api/services/auth/src/auth.controller.ts:92-124`): `el_refresh`, httpOnly, `path: '/api/v1/auth'`, no `domain`, `sameSite` from `COOKIE_SAMESITE` (`render.yaml` sets `none`), `secure` when `none` or in production. It's set on login, Google, refresh and accept-invite, and cleared on logout.
- **The password change** (after 6a decision 5): `PUT /profiles/password` revokes every session, then issues a fresh one like login does: the access token in the body and a new `el_refresh` cookie (`Path=/api/v1/auth`). It's the only cookie-setting route outside `/auth`; `auth.controller.ts` is the only place the cookie is set or cleared, so the implementer confirms 6a's controller wiring when re-finding it.
- **Refresh rotation** (`auth.service.ts:201-219`): single-use; the old token is deleted from Redis (`refresh:<token>`) and from the user's set (`refresh:user:<id>`), and a new one issued. A second use of the same token is a 401. `logout` (`:335-345`) deletes one token; `revokeAllSessions` (`:353-361`) deletes every token in the user's set.
- **Gateway** (`api/gateway/src/main.ts`):
  - `trust proxy 1` (`:72`);
  - CORS for `CORS_ORIGINS`/`WEB_URL` with credentials (`:78-92`);
  - limiters keyed by `req.ip` (`ipKey`, `:100-103`) for `auth-strict` (10/min) and `auth` (30/min, refresh), and by user id otherwise (`rate-policy.ts:24-36`); `general` (300/min, by user or IP) applies on top of every bucket;
  - the auth middleware is inline in `bootstrap()` (`:166-229`): it strips `x-user-*` and `x-internal-token`, stamps the internal token, checks internal routes and verifies the JWT. `verifyBearer` (`:50-58`) and `validInternalToken` (`:60-64`) aren't exported, and `bootstrap()` runs on import (`:236`), so none of it is testable.
- **SSR** (`web/src/lib/server-api.ts:5`) uses `GATEWAY_INTERNAL_URL ?? NEXT_PUBLIC_API_URL` for public reads only.
- **No route handlers or middleware** exist in `web/src/app` yet.
- **Playwright** (`web/e2e/`):
  - `auth.setup.ts` logs each role in once and saves `storageState`, which every other spec reuses;
  - `refresh.spec.ts` rewrites `el_auth` to fake an expired token and counts calls to `**/api/v1/auth/refresh`;
  - chromium only.
- **API tests:**
  - jest 30, one config (`api/jest.config.js`), no coverage settings;
  - auth has `auth.session.spec.ts` (logout and revoke only) and `membership.service.spec.ts`;
  - the gateway has route and rate-policy specs, but nothing for its middleware;
  - Phases 3, 4, 6a–6c and 9a–9e add specs for payments, refunds, payouts, sponsorships, certificates and enrollment, so step 2 re-measures before adding anything.
- **E2E scripts:** no script calls `/auth/refresh`. `scripts/demo-seed.mjs:345-352` prints "certificate issued" without checking.

## Design and key decisions
1. **Only the cookie routes go through the web origin, via route handlers:**
   - **Two thin route files share one helper**, `web/src/lib/gateway-proxy.ts` (`proxyToGateway(req)`):
     - `web/src/app/api/v1/auth/[...path]/route.ts` handles `GET`, `POST` and `DELETE`;
     - `web/src/app/api/v1/profiles/password/route.ts` handles `PUT` (B1: 6a's password change sets the fresh refresh cookie, so it has to land on the web host too).
     - Both: Node runtime, `dynamic = 'force-dynamic'`, `maxDuration = 30`.
   - **Path guard (N2):** the helper builds the upstream path from `req.nextUrl.pathname` and refuses with 404, before any fetch, unless it starts with `/api/v1/auth/` or equals `/api/v1/profiles/password`. That's a cheap guard against a future path-joining change sending the proxy secret somewhere else.
   - It forwards to `${GATEWAY_INTERNAL_URL ?? NEXT_PUBLIC_API_URL}<that path>` with:
     - the method, the query string and the raw body;
     - the request headers `content-type`, `authorization`, `accept-language`, `user-agent` and 9d's `x-request-id`, and from the cookie header only `el_refresh`;
     - and, only when `WEB_PROXY_SECRET` is set: `x-web-proxy-secret` and `x-web-client-ip` (decision 3).
   - **Response:** status and body as they are. Upstream headers are copied except hop-by-hop ones, `content-encoding` and `content-length` (fetch already decoded the body). Each `Set-Cookie` is copied separately (`headers.getSetCookie()`). `x-render-routing` passes through, so Phase 5's hibernation check still works.
   - **Failures:** a network error, or no answer within 20 s (`AbortSignal.timeout`, under `maxDuration`), returns 503 `{ code: 'service_waking' }`. The web already maps that to `WakingError` (9c). A Vercel 504 never reaches the client as a bare 504.
   - **The path comes from `req.nextUrl.pathname`,** not the `params` argument, which becomes a Promise in Next 15 (11c).
   - **Everything else stays direct.** Other calls go to `API_URL` with `Authorization: Bearer` and `credentials: 'omit'`; they never needed the cookie. So uploads, media and wake pings are untouched, and only auth traffic counts against Vercel's function budget.
   - **The `Path` attribute:** the password response's cookie carries `Path=/api/v1/auth`, as the controller sets it, so the browser stores it for the auth path even though it arrived on `/api/v1/profiles/password`. The next refresh sends it.
   - **Rejected:**
     - `rewrites()` in `next.config` (Vercel's edge proxy). It can't add the proof header, so the gateway would see Vercel's egress IPs and the per-IP login limits would be shared by every user.
     - Proxying the whole API. That puts every request and upload through a function: Vercel's body limit, an extra hop, and the function budget, for no cookie benefit.
2. **Access token in memory, with a session hint:**
   - `lib/auth-store.ts` holds `{ access_token, user } | null` in a module variable. `getAuth()` stays synchronous, so its callers keep working.
   - `setAuth()` updates memory and broadcasts the change to other tabs (decision 4). It also writes the hint `el_session = { user }` (the public user from the auth response: no token, nothing a server trusts), or clears it on logout or a rejected refresh.
   - **Boot** (in `Providers`): on load, the store removes any leftover `el_auth`. Then:
     - with no `el_session` hint, the user is anonymous at once, with no network call (no wake of auth, no Vercel function, for every anonymous visitor);
     - with the hint, the store takes the hint's `user` at once, with no token (S1), so the header shows the signed-in user before the round trip. Then it runs one refresh through the cross-tab lock;
     - `ok` → signed in;
     - `rejected` (401/403) → anonymous, hint cleared;
     - `waking` or a gateway 429 while online → stays "not ready". Phase 5's notice shows, and the refresh is retried on Phase 5's wake backoff. A protected page never redirects to login while not ready.
   - **Offline boot (S1):** when `navigator.onLine === false` at boot, or the boot refresh fails with a network error while offline:
     - `ready` turns true with the hint's `user` and no access token, and no waking notice shows;
     - reads go out without a bearer, fail, and the service worker serves its cached copy (it matches on the URL, `sw.js`); writes go to Phase 5's offline outbox, which stores no token;
     - on the `online` event, the store runs the refresh (through the lock) before the outbox flushes. A 401 from a call made before then goes through Phase 5's single-flight refresh, as today.
     - Rejected: retrying the refresh on the wake backoff while offline. It can't succeed, and the waking notice would be wrong.
   - **`useAuth()`** reports `ready: false` until boot settles (online), and exposes `user` as soon as the hint is read. It subscribes to the store instead of the `storage` event. `help/page.tsx` and `account/password/page.tsx` read through `useAuth()` or the store, not at render time before boot.
   - **`Providers`** clears the service worker's API cache when the store becomes empty (logout), not when `el_auth` is missing.
   - All `/auth/*` calls (login, signup, Google, accept-invite, reset, verify, resend-verification, logout, refresh) and `PUT /profiles/password` use the same-origin base and `credentials: 'same-origin'`. `api()` picks the base from the path (the `/auth/` prefix, or exactly `/profiles/password`), so the pages don't change. The password page then calls `setAuth` with the response, as 6a has it.
3. **The gateway trusts the client IP only from the web proxy:**
   - A new `clientIp` middleware runs before the limiters:
     - if `WEB_PROXY_SECRET` is set and `x-web-proxy-secret` matches it (timing-safe), and `x-web-client-ip` passes `net.isIP`, it sets `req.clientIp` from that header;
     - otherwise `req.clientIp = req.ip`, as today.
   - Then it **deletes both headers** in every case, so they never reach a service.
   - `ipKey` (and 9d's access-log `ip`) use `req.clientIp`. IPv6 /64 bucketing stays.
   - **Refresh gets its own bucket (S3):** `classifyRequest` maps `POST /api/v1/auth/refresh` to a new `auth-refresh` policy, 10/min (`RATE_LIMIT_AUTH_REFRESH_PER_MIN`), keyed by `rt:` plus the first 32 hex characters of the SHA-256 of the `el_refresh` cookie. Without the cookie it falls back to `ipKey`.
     - Why: refresh is anonymous, so the `auth` bucket keyed it by IP, and every page load now refreshes. A class of 30 behind one campus NAT address would get 429s on boot, and the Playwright suite would pass 30 page loads a minute.
     - The token can't be guessed (a UUID plus 32 random hex characters, `auth.service.ts:365`), so the IP key protected nothing here. The per-token cap bounds replays inside the grace (decision 8). `general` (300/min per IP for anonymous calls) stays on top as the per-IP backstop.
     - The gateway reads the cookie from the raw `cookie` header with a small parser; it never logs or stores the value.
   - **The route handler's client IP** is `x-real-ip`, falling back to the first `x-forwarded-for` entry. Vercel overwrites both with the connecting client's address, so a browser can't forge them. The handler never forwards a client-sent `x-web-*` header.
   - **Only Vercel gets the secret.** On a host that doesn't overwrite `x-forwarded-for` (the self-hosting `web/Dockerfile`), leave `WEB_PROXY_SECRET` unset; the gateway then keys by the proxy's IP, which is safe but coarse. `docs/DEPLOYMENT.md` says so.
   - **Rejected:** trusting `x-forwarded-for` with `trust proxy 2`. A direct caller to the onrender.com URL could then set any IP and dodge the login limits.
4. **Refreshes are serialized across tabs:**
   - **The lock:** the refresh runs inside `navigator.locks.request('el-auth-refresh', …)`. Inside the lock, it first checks whether another tab already delivered a newer token while this one waited (through the broadcast). If so, it uses that and skips the call. The single-flight within a tab (Phase 5) stays.
   - **One attempt per lock (N1):** the lock covers a single refresh call. Phase 5's wake backoff waits outside it and takes the lock again for each retry, so one waking tab never holds up another tab's refresh, or a login's broadcast, for the whole backoff.
   - **The broadcast:** a `BroadcastChannel('el-auth')` carries `session` (after a refresh or login) and `logout`. A tab that receives `session` adopts the token and user; one that receives `logout` clears memory.
   - **A rejected refresh** clears only its own tab, without a broadcast. With the lock it can only mean the session really ended, and a stray race in a browser without Web Locks shouldn't sign out every tab.
   - **Fallback:** without `navigator.locks` (very old browsers), it refreshes without the lock. The worst case is one tab signed out by a race, and a reload fixes it, since the cookie is still valid.
5. **Cookie and CORS settings:**
   - `render.yaml` sets `COOKIE_SAMESITE=lax` (from `none`). `secure` stays on in production.
     - Lax is enough: only `POST /auth/refresh` and `POST /auth/logout` read the cookie, Lax already withholds it from every cross-site POST, and the one GET under `/auth` (`invite/:token`) ignores it.
     - Rejected: `Strict` (S4). It adds nothing here, and learners arrive cross-site after Chapa's checkout and from every email link. A browser that withholds Strict cookies on the first requests after such an arrival would sign the learner out right after paying. A Playwright spec covers the cross-site arrival (decision 7).
   - CORS on the gateway is unchanged; old web tabs during the deploy still use it. Its `credentials: true` is harmless and can go in a later clean-up.
   - **The cookie's attributes don't change in code:** it has no `domain`, so it binds to whichever host the browser sees, which is now the web host. The auth service's one change is the refresh grace (decision 8).
6. **Tests for the high-risk paths (P1-29):**
   - **Measure first.** Step 2 adds `collectCoverageFrom` and a `test:coverage` script, runs it at the base, and records per-package numbers. Then, for each behaviour below, the implementer checks whether an existing spec already asserts it (Phases 3–9 added many) and adds only what's missing, logging which in Progress.
   - **auth** (in-memory repos and a Redis fake, as in `auth.session.spec.ts`):
     - login: wrong password, unverified, suspended → the right error, with no token issued;
     - refresh: rotation; the grace (decision 8, with a fake clock): the old token inside 30 s returns the same successor, after 30 s it's a 401, and once the successor is rotated, revoked by `revokeAllSessions` or logged out, the old token is a 401; `logout` with the old token inside the grace also revokes the successor; a suspended user's refresh fails;
     - reset: an expired token and a used token fail; a successful reset revokes every session;
     - Google: a new user is created as a learner; an existing email links; a bad ID token fails (verifier mocked);
     - invite: expired and already-used tokens fail.
   - **gateway:** extract `bootstrap()`'s middleware into `gateway/src/auth-middleware.ts`, and split app creation (`createGatewayApp()` in `app.ts`) from `main.ts`'s listen, so specs can build the app without a port. An integration spec runs the app on `listen(0)` against a stub upstream (no supertest; plain `fetch`):
     - client-sent `x-user-*` and `x-internal-token` are stripped;
     - a `jwt` route without a token, or with a bad or expired one, → 401, and with a valid one the upstream sees `x-user-id` and the role;
     - an `internal` route without the right token → refused;
     - `x-web-client-ip` is honoured only with the right secret; `x-web-proxy-secret` and `x-web-client-ip` never reach the upstream, whether the secret is right, wrong or absent (decision 3, N3);
     - `POST /auth/refresh` is limited per cookie: two different cookies from one IP get separate buckets (decision 3).
   - **common:** the service-side internal-token check in `bootstrap.ts`: refused without the token, passed with it.
   - **financial, enrollment and outcomes:** initiate pricing (coupon and wallet), grant and revoke idempotency, and `issue()`. These are most likely already covered by Phases 3, 4 and 9a; add only the gaps.
   - **E2E scripts:**
     - `e2e-smoke.mjs` logs in, refreshes with the cookie, then: the old cookie again inside the grace → 200 with the same successor cookie; the successor → 200 and a third token; the old cookie once more → 401 (its successor is gone). No step waits out the 30 s; the unit spec covers expiry;
     - `demo-seed.mjs` replaces its unchecked "certificate issued" with a `GET /me/certificates` that must contain the course, and `GET /verify/:uid` must say valid.
   - **CI:** the `api` job runs `test:coverage` instead of `test` and writes the summary table to the job summary. There is no threshold (Non-goals).

7. **Playwright under rotating refresh tokens:**
   - **`storageState` can't be shared any more.** Every page load now runs a refresh that rotates the cookie. So a saved state is valid for exactly one context: the next spec that loads it presents a used token and is signed out.
   - **The fix:** `auth.setup.ts` becomes a fixture, `loggedInAs(role)`. It logs in with `page.request.post('/api/v1/auth/login')` through the web origin, which stores the cookie in that test's context, and sets the `el_session` hint (with the response's `user`) with `addInitScript`. One login per test, with the `auth-strict` and `auth` limits raised for the e2e stack (Configuration).
   - **Specs:**
     - `refresh.spec.ts` is rewritten for memory tokens. It makes the first API calls 401 (by routing the gateway origin), then expects exactly one same-origin refresh and the user still signed in;
     - new: **reload** keeps the user signed in, and `localStorage` holds no access token (`el_auth` absent, no value matching the JWT);
     - new: **two tabs** in one context boot at once, both stay signed in, and the refreshes are serialized (two 200s, no 401);
     - new: **logout** in one tab signs out the other;
     - new: an **anonymous** visit to `/courses` makes no `/api/v1/auth/*` request;
     - new (B1): **password change** with the current password, then a reload: still signed in, and the next refresh is a 200;
     - new (S4): **cross-site arrival**: a page served from `127.0.0.1` links to `localhost:3000/dashboard` (different sites); after the click the user is still signed in. It stands in for returning from Chapa or an email link.
   - **A `webkit` project** runs these auth specs too. It's the closest CI check of Safari's cookie handling (the audit's open "not tested" item). CI installs WebKit with `npx playwright install --with-deps webkit chromium`.
   - The offline boot (S1) is covered by vitest (step 6), not Playwright: it depends on the service worker's cache, which makes a browser spec slow and flaky.

8. **A 30-second grace for a lost rotation response (S2):**
   - **The problem:** auth deletes the old token before the response reaches the browser. If the response never arrives (a reload or full navigation during the boot refresh, or the route handler's 20 s timeout after auth already rotated), the browser keeps a cookie whose token is gone, and the next load signs the user out. With a refresh on every hard load and every new tab, that window is hit far more often than once per 15 minutes.
   - **The grace:** on rotation, `refresh()` also writes `refresh:grace:<old>` → `<new>` with a 30 s TTL (`REFRESH_REUSE_GRACE_SECONDS`, a constant), in the same `MULTI` as the delete. When a presented token isn't found:
     - it looks up `refresh:grace:<token>`;
     - if that points to a successor that still exists (`refresh:<new>` is present, so it wasn't rotated, logged out or revoked), it runs the same user checks as a normal refresh (a suspended user is refused), then returns a fresh access token and **the same successor** as the refresh token, and the controller sets that cookie again;
     - otherwise it's a 401, as today.
   - **Why the same successor, not a new token** (the reviewer's `EXPIRE` alternative): a retry issues no second live session, so a lost response leaves no orphaned 30-day token behind. `revokeAllSessions` and logout keep working unchanged, because the grace only ever leads to a token that is still in the user's set.
   - **`logout` with an old token inside the grace** also revokes its successor, so a user who logs out right after a lost response leaves nothing live.
   - **Security:** a stolen old cookie used within 30 s gets the victim's current session. Without reuse detection (Non-goals), a stolen cookie already works if used before the victim's next refresh, so the grace doesn't widen what a thief can do; the per-token limit (decision 3) caps replays. The value stored is the successor token, which Redis already holds as a key, so nothing new is at rest.
   - **One hop only:** if the successor was itself rotated, the old token is a 401. Its holder is stale, and following chains would turn the grace into a long-lived token.

## Configuration
- **Web** (`web/.env.example`, server-only, never `NEXT_PUBLIC_`):
  - `WEB_PROXY_SECRET` (blank locally; set on Vercel only);
  - `GATEWAY_INTERNAL_URL` (already read by `server-api.ts`; documented now).
- **API** (`api/.env.example`): `WEB_PROXY_SECRET` (gateway only, blank locally).
- **API** (`api/.env.example`, documented with its default): `RATE_LIMIT_AUTH_REFRESH_PER_MIN` (10), read by `main.ts` like the other `RATE_LIMIT_*_PER_MIN`.
- **`render.yaml`:**
  - `COOKIE_SAMESITE: lax`;
  - `WEB_PROXY_SECRET` on the gateway service with `sync: false`, not in the shared group.
- **CI e2e:** Playwright logs in per test (decision 7), so the e2e stack sets `RATE_LIMIT_AUTH_STRICT_PER_MIN` and `RATE_LIMIT_AUTH_PER_MIN` high (both variables already exist) in `ci.yml` and in the local Playwright scripts. Refresh is per token, so it needs no change.

## API contract
| Endpoint | Change |
|---|---|
| `GET/POST/DELETE /api/v1/auth/*` and `PUT /api/v1/profiles/password` on the **web** origin (new route handlers) | Forward to the gateway as described in decision 1. 503 `{ code: 'service_waking' }` on an upstream network error or timeout; 404 for any other path. |
| Gateway, all routes | New trusted headers `x-web-proxy-secret` and `x-web-client-ip`: honoured only with the secret, stripped always. |
| Gateway, `POST /api/v1/auth/refresh` | Rate-limited per refresh token (`auth-refresh`, 10/min), no longer per IP. |
| `POST /api/v1/auth/refresh` | A token rotated in the last 30 s returns the same successor instead of a 401 (decision 8). Response shape unchanged. |
| `Set-Cookie: el_refresh` | Now `SameSite=Lax`, set on the web host. |

## Steps
- [ ] 1. Branch `fix/auth-transport` from the base above.
- [ ] 2. Coverage (decision 6): `collectCoverageFrom`, a `test:coverage` script, a run at the base. Record per-package statement and branch numbers in Progress.
- [ ] 3. Gateway extraction (decision 6): `app.ts` with `createGatewayApp()`, `auth-middleware.ts`, and `main.ts` as a thin starter. Behaviour unchanged. · Spec: the integration spec's strip, jwt and internal cases pass before any other change.
- [ ] 4. Trusted client IP and the refresh bucket (decision 3): the `clientIp` middleware, `ipKey` and 9d's access log on `req.clientIp`, the header stripping, and the `auth-refresh` policy keyed by the cookie hash. · Specs: honoured with the secret; ignored without it, with a wrong one, or with a non-IP value; never forwarded in any of those cases (N3); the limiter buckets by it; `rate-policy.spec.ts` maps refresh to `auth-refresh`; two cookies from one IP get separate refresh buckets.
- [ ] 4a. The refresh grace in the auth service (decision 8): the grace key in the rotation `MULTI`, the lookup on a missing token, logout revoking the successor. · The auth unit specs listed in decision 6 (grace, expiry with a fake clock, rotated/revoked/logged-out successor, suspended user).
- [ ] 5. The route handlers and `gateway-proxy.ts` (decision 1). · Vitest with `fetch` mocked:
  - method, query, body, `authorization` and only `el_refresh` are forwarded;
  - the secret and client IP are added only when configured, and client-sent `x-web-*` headers are dropped;
  - two `Set-Cookie` headers both come back;
  - `content-encoding` is dropped;
  - a timeout → 503 `service_waking`;
  - a hibernation 429 keeps `x-render-routing`;
  - `PUT /api/v1/profiles/password` is forwarded; any path outside the allowlist → 404 with no fetch (N2).
- [ ] 6. The memory store, the hint with `user`, boot (online and offline), the cross-tab lock (one attempt per acquisition) and broadcast, `useAuth()`, the base switch for `/auth/*` and `/profiles/password`, `credentials: 'omit'` elsewhere, and the `Providers` cache clear (decisions 2, 4). · Vitests:
  - no hint → no call and ready;
  - hint → `user` present before the refresh resolves;
  - hint plus 200 → signed in;
  - hint plus 401 → anonymous and hint cleared;
  - hint plus a network error while online → not ready and the waking notice;
  - hint while offline → ready, `user` present, no waking notice, no refresh; the `online` event → one refresh (S1);
  - the hint never contains the access token;
  - a `session` broadcast is adopted;
  - inside the lock, a newer token skips the call (`navigator.locks` mocked);
  - a waking retry releases the lock between attempts (N1);
  - logout broadcasts.
- [ ] 7. `render.yaml` (`COOKIE_SAMESITE: lax`, `WEB_PROXY_SECRET` on the gateway), both `.env.example` files, and `docs/DEPLOYMENT.md` ("Auth transport": what goes through the web origin and why, the secret and where it may be set, the one-time sign-in).
- [ ] 8. Playwright (decision 7): the `loggedInAs` fixture replacing shared `storageState`, the rewritten refresh spec, the six new specs (reload, two tabs, logout, anonymous, password change, cross-site arrival), the `webkit` project, and the raised `auth-strict` and `auth` limits in CI and local scripts. Run the whole suite in both projects.
- [ ] 9. P1-29 tests (decision 6): auth, gateway, common and the remaining financial, enrollment and outcomes gaps; the `e2e-smoke` refresh rotation; the `demo-seed` certificate check. Re-run `test:coverage` and record the after numbers next to the before ones.
- [ ] 10. Full gate:
  - `pnpm -C api build && pnpm -C api test:coverage && pnpm -C api typecheck && pnpm -C api db:check && pnpm -C api lint`;
  - `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build && pnpm -C web lint`;
  - the CI e2e scripts and the full Playwright suite (chromium and webkit) locally.
- [ ] 11. Code review by ethio-reviewer; the user approves push and PR, then does Rollout.

## Test plan
- **API unit and integration:** the gateway app on `listen(0)` (steps 3, 4), the refresh grace (step 4a) and the P1-29 behaviours (step 9).
- **Web vitest:** the route handlers and path guard (step 5); the store, boot (online and offline), lock and broadcast (step 6).
- **Playwright:** the auth specs in chromium and webkit, including password change and cross-site arrival (step 8), and the rest of the suite on the new fixture.
- **E2E scripts:** refresh rotation and the grace in `e2e-smoke`; the real certificate check in `demo-seed`.
- **Regression:** every api spec, every web vitest, every CI e2e script.

## Rollout and ops (the user)
1. **Before merge:**
   - generate one long random value for `WEB_PROXY_SECRET`;
   - set it on **Vercel** (Production, a plain server variable, not `NEXT_PUBLIC_`) and on the **Render gateway** service only;
   - check that Vercel has `GATEWAY_INTERNAL_URL` (or `NEXT_PUBLIC_API_URL`) pointing at the gateway.

   Vercel reads env at build time for the route handler's deployment, so set it before the merge triggers the build.
2. **The deploy skew (11a):** the web goes live up to about 45 minutes before the API.
   - New web against the old API works: the old gateway sets the cookie with `SameSite=None; Secure` on the web host, and it's sent same-origin.
   - Until the gateway deploys, though, it doesn't know the secret, so `/auth` rate limits key by Vercel's egress IP and are shared by everyone. That's acceptable before launch. Merge at a quiet time.
3. **After deploy:** everyone signs in once more, because old refresh cookies live on the API host. Say so in the release note.
4. **Optional check:** on a real iPhone, sign in, wait 16 minutes, and use the app; you should still be signed in.

## Risks and open questions
- **Vercel function cold starts** add latency to auth calls only (login and the boot refresh), usually well under a second.
- **A refresh on every hard load** costs one auth call per reload for signed-in users. Client-side navigation doesn't reload. The refresh limit is per token (10/min), and each load rotates the token, so normal use never meets it; `general` (300/min per IP) is the backstop.
- **Two refresh-cookie holders during the skew** (old web tabs using the API host, new web using its own host) are separate sessions. Both expire on their own. Old tabs are signed out at their next refresh once `SameSite=Lax` ships (Lax isn't sent on their cross-site fetch to the API host), so a reload picks up the new web.
- **The grace gives a stolen old cookie 30 s** to reach the current session (decision 8). Without reuse detection that isn't new exposure; reuse detection stays a Non-goal.
- **WebKit in Playwright isn't Safari.** ITP's heuristics aren't the same, so the real-device check stays in Rollout.

## Progress and deviations (implementer)
