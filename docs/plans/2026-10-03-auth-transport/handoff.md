# Handoff: Phase 11b, auth transport and tests for the high-risk paths

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 2, see [plan-review.md](plan-review.md))
Code review goes to: ethio-reviewer (size L)

## What to build
- **The access token lives in memory only.** `localStorage` keeps a non-secret hint, `el_session = { user }`, and never a token.
- **The refresh cookie becomes first-party.** `/api/v1/auth/*` and `PUT /api/v1/profiles/password` go through Next route handlers on the web origin, sharing one `gateway-proxy.ts`. The cookie is `SameSite=Lax` on the web host. Every other call stays direct, with a bearer token and no cookies.
- **Boot:**
  - no hint → anonymous, no call;
  - hint → the user is shown at once, then one refresh through a cross-tab Web Lock;
  - offline → signed in on cached pages, refreshing on `online`;
  - waking → Phase 5's notice.
- **Gateway:**
  - trusts `x-web-client-ip` only with `WEB_PROXY_SECRET`, and strips both headers always;
  - refresh gets its own `auth-refresh` bucket, keyed per refresh-token hash.
- **Auth service:** a 30 s grace pointer, `refresh:grace:<old>` → `<new>`, so a lost rotation response isn't a sign-out. It returns the same successor, one hop only.
- **P1-29 tests:**
  - coverage measured;
  - the gateway middleware extracted into `createGatewayApp()` and tested on `listen(0)`;
  - the auth, common, financial, enrollment and outcomes gaps;
  - `e2e-smoke`'s rotation and grace sequence;
  - `demo-seed`'s real certificate check.
- **Playwright:** per-test login, six new auth specs, and a `webkit` project.

## Read first, in order
1. `plan.md` decisions 1–8, then `plan-review.md`:
   - round 1: B1 (password change), S1 (offline), S2 (lost response), S3 (refresh limit) and S4 (Lax);
   - round 2: the walk-through of the grace sequences.
2. Web:
   - `web/src/lib/api.ts` (token storage, `API_URL`, `credentials`, Phase 5's single-flight refresh and `WakingError`) and `lib/hooks.ts` (`useAuth`);
   - `components/Providers.tsx`, `lib/offline-queue.ts` and `public/sw.js` (the offline path S1 relies on);
   - every `setAuth`/`getAuth` caller listed in the plan's Current state.
3. Auth:
   - `auth.controller.ts` (cookie options, login, refresh and logout);
   - `auth.service.ts`: `refresh`, `logout`, `revokeAllSessions` and `issueRefreshToken`;
   - 6a's password change in `profiles.controller.ts` and `auth.service.ts` (the fresh session it issues).
4. Gateway: `main.ts` (trust proxy, CORS, `ipKey`/`userKey`, the inline auth middleware, `bootstrap()` running on import) and `rate-policy.ts`.
5. Tests:
   - `api/jest.config.js` and `auth.session.spec.ts` (the Redis fake);
   - `web/e2e/` (`auth.setup.ts`, `refresh.spec.ts`, `playwright.config.ts`);
   - `scripts/e2e-smoke.mjs` and `scripts/demo-seed.mjs`.

## Decisions already made (don't relitigate)
- **Proxy scope:** two route files (`auth/[...path]` GET/POST/DELETE, `profiles/password` PUT) on one helper.
  - The path comes from `req.nextUrl.pathname`, and any path outside the allowlist → 404 with no fetch.
  - A timeout (20 s) or network error → 503 `service_waking`.
  - `x-render-routing` passes through; each `Set-Cookie` is copied separately.
  - Rejected: `rewrites()` (it can't add the proof header) and proxying the whole API.
- **Client IP:** `x-real-ip`, then the first `x-forwarded-for` entry. The secret is set on Vercel and the Render gateway only, never on the self-hosted Dockerfile.
- **Refresh bucket:** `auth-refresh`, 10/min, keyed by `rt:` plus the first 32 hex characters of SHA-256(`el_refresh`), falling back to the IP. `general` is the per-IP backstop; there's no extra IP limiter.
- **Grace:**
  - the pointer is written in the same `MULTI` as the delete, with a 30 s constant;
  - it leads only to a successor that still exists, after the usual user checks;
  - logout with an old token revokes the successor;
  - rejected: `EXPIRE` on the old key.
- **Cross-tab:** Web Locks with one attempt per acquisition (the backoff waits outside the lock), plus a BroadcastChannel for `session` and `logout`. A rejected refresh clears only its own tab.
- **Cookie:** `COOKIE_SAMESITE=lax`; the cookie attributes don't change in code. Rejected: Strict.
- **Playwright:** a `loggedInAs(role)` fixture instead of shared `storageState`, because rotation makes a saved state single-use. Offline boot is tested in vitest, not Playwright.
- **Coverage:** measured and shown in the CI job summary, with no threshold.

## Gotchas learned while planning
- **Base-branch drift:** line numbers in the plan are at `62e29a1`. 6a, 7b and 9c–9e change `api.ts`, `main.ts`, `auth.service.ts` and the access log, so re-find each site by its code.
  - 9c's typed client errors and 9d's `redactPath` and request id are the ones to build on.
- **Playwright environment** (memory `playwright-clean-env`):
  - never export `api/.env.example` into the shell that runs Playwright: `NODE_ENV=development` breaks `next start`'s ISR fallback;
  - per-test login multiplies auth calls, so raise `RATE_LIMIT_AUTH_STRICT_PER_MIN` and `RATE_LIMIT_AUTH_PER_MIN` in the local scripts as in CI before the first full run.
- **WebKit locally:** `npx playwright install webkit` may need system libraries. If `--with-deps` asks for sudo, give the user the command (`! sudo npx playwright install-deps webkit`) instead of working around it.
- **The cross-site spec:** `127.0.0.1` and `localhost` are different sites. Serve the link page from a tiny static server on `127.0.0.1`, or from `page.route` on a `127.0.0.1` URL.
- **Redis fake and TTL:** the grace expiry needs a fake clock. Extend the fake's `set … EX` handling, or use jest's modern timers, whichever the existing fake supports cleanly.
- **Secrets:**
  - the secret-guard hook scans untracked files for `api/.env` values;
  - tests use obviously fake values; reuse the allowlisted fake password from `.gitleaks.toml` (`9274e9f`) for any new test password;
  - `WEB_PROXY_SECRET` is blank locally; tests set a fake one.
- **The plan folder isn't in `.git/info/exclude`.** Commit it on your branch, staging paths explicitly (several other plan folders are untracked).
- **Environment:**
  - the node PATH export (`/home/kal/.local/opt/node22/bin`);
  - pnpm's `--store-dir /home/kal/snap/code/current/.local/share/pnpm/store/v3`;
  - Postgres on 55432; e2e on `.env.example` values only;
  - restart web by killing the `next-server` PID, never with a `pkill -f` pattern that matches your own shell.
- **Production is off-limits.** Rollout is the user's.

## How to run
- **API:** `pnpm -C api build && pnpm -C api test:coverage && pnpm -C api typecheck && pnpm -C api db:check && pnpm -C api lint`
- **Web:** `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build && pnpm -C web lint`
- **E2E:** every CI e2e script, `e2e-smoke` with the new refresh sequence, and `demo-seed` with the certificate check.
- **Playwright:** the full suite in chromium and webkit, on a clean env.

## Branch
Create `fix/auth-transport` from the tip of the stack when it starts (expected `chore/ci-gates`, 11a). Tell ethio-reviewer the base.
- Don't push and don't open a PR until everything below has merged into main. Then run `git merge origin/main` (no rebase).

## Rollout notes for the PR description (the user does these)
1. **Before merge:**
   - generate one long random `WEB_PROXY_SECRET`;
   - set it on Vercel (Production, server-only, not `NEXT_PUBLIC_`) and on the Render gateway only;
   - check that Vercel has `GATEWAY_INTERNAL_URL` (or `NEXT_PUBLIC_API_URL`) pointing at the gateway.
2. **Merge at a quiet time.** Until the gateway deploys, `/auth` limits key by Vercel's egress IP.
3. **After deploy:** everyone signs in once more. Say so in the release note.
4. **Optional:** on a real iPhone, sign in, wait 16 minutes, and use the app.

## Definition of done
- The acceptance criteria are met.
- Every check in "How to run" passes, and the coverage before and after numbers are in Progress.
- The checklist is ticked, with deviations logged.
- Then request code review from ethio-reviewer.
