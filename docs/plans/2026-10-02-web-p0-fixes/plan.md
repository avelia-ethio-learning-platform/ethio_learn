# Phase 5: Web P0 fixes and a browser E2E harness

Status: approved (round 2); amendment A1 (wake from outside Render) approved in round 4
Size: M (sessions: 3 — ethio-impl implements, ethio-plan-review reviews plan and code)
Base branch: `fix/payment-integrity` (stacked, so impl isn't idle while #19, Phase 3 and Phase 4 wait on the user's production steps; it already has Phase 3's changes to the login, accept-invite and institution pages this phase also touches). Merge `origin/main` back in once those three land; see `handoff.md` → Branch. · Feature branch: `fix/web-p0`
Roadmap: phase 5 · Findings: P0-09 (code part), P0-11, P0-12, P0-13, P0-14, P0-15, P0-16, P0-17, P0-18, P1-30; also P1-58 (same CSS line as P0-14) and a minimal 404/error page needed by P0-09 (the branded versions are P1-32, Phase 7)

## Goal
Fix the user-visible breakage a first visitor or a new customer hits, make the free-tier cold start understandable instead of broken, and add a browser E2E suite so these regressions can't come back unnoticed.

Acceptance criteria:
- **Cold start (P0-09, free tier by decision):**
  - Server-side fetches time out after 8 s instead of hanging.
  - A genuinely missing course or certificate still shows 404 or "not valid". An unreachable or slow API shows a "We're waking up the server" state with a Retry, never a false 404 or a false "invalid certificate". This holds under `next start` and on Vercel, not only in `next dev`.
  - The home page is statically generated and revalidated (ISR), so it never waits on the API. A failed revalidation keeps the last good page.
  - In the browser, an API call still pending after 4 s shows a small "Waking up the server, this can take up to a minute on the first visit" notice until it settles. Known-slow calls (AI generation, tutor chat, uploads) opt out.
  - **(A1)** In production, the waking-up states actually wake the services: a page that hits a sleeping service recovers on Retry within about a minute, with no one hitting the services by hand.
- **Build independence:** `pnpm -C web build` passes with no backend reachable. This covers the CI `web` job, the web Docker build and a Vercel build while Render sleeps.
- **P0-11:** after login, Google sign-in or accepting an invite, every role lands on a page it can use (institution admins on `/institution`). Back links on shared teach pages are role-aware. No role sees a create-course form that the API will refuse.
- **P0-12:** an expired access token with several requests in flight triggers exactly one refresh; the user stays signed in when the refresh succeeds.
- **P0-13:** no page renders content under the fixed header, at any width.
- **P0-14 / P1-58:** no page scrolls or clips horizontally at 375 px; `position: sticky` works again.
- **P0-15:** the mobile menu panel is opaque.
- **P0-16 / P0-17:** no literal `&apos;`; no developer copy on the signup success screen.
- **P0-18:** `/verify` has a certificate-ID form that routes to `/verify/<id>`; the footer and Help links point to it.
- **P1-30:** a Playwright smoke suite runs in CI against the e2e stack and covers each fix above; web unit coverage is measurable.

## Non-goals
- The branded 404/error/loading design, dead-end auth cards and `?next=` on RequireRole (P1-32, P1-33; Phase 7). This phase adds a plain, on-brand-enough root `not-found.tsx` and `error.tsx` built from the existing `PageShell`, because P0-09 needs somewhere honest to land.
- Visual polish of the touched pages (Phase 7), the confirm-dialog component (Phase 8), i18n.
- Keeping free-tier services warm or moving crons (Phase 11). Waking a sleeping service from another service's internal call (Render to Render, e.g. financial → auth) is Phase 9 (P1-18) and Phase 11; A1 covers only traffic that starts in a browser.
- Anything in Phase 3's scope (`safeNext`, institution membership UI), which this phase builds on.

## Current state
- **Server fetch** `web/src/lib/server-api.ts:4-14`: `fetch` with no timeout or signal. Any failure (404, 5xx, network) returns `null`. Callers:
  - **Prerendered at build** (in `.next/prerender-manifest.json`): `/educators` (`educators/page.tsx:25`, `revalidate = 120`) and `/sitemap.xml` (`sitemap.ts:10`). The home page joins them in this phase.
  - **Dynamic (`ƒ`):**
    - home `web/src/app/(public)/page.tsx:28` (today);
    - course `courses/[id]/page.tsx:37,53-55`, where `null` → `notFound()`;
    - catalog `courses/page.tsx:31`;
    - educator profile `educators/[id]/page.tsx:23,35`;
    - certificate `web/src/app/(verify)/verify/[uid]/page.tsx:23`, where `null` → `{ valid: false }`.
- **Production error sanitizing:** Next 14 replaces the message of an error thrown in a Server Component with a generic one plus a `digest` in production. So `error.tsx` can't tell a cold start from a bug, and the state has to be rendered by the page.
- **Home is dynamic** (`ƒ /`, `Cache-Control: private, no-store`) because it reads `searchParams` (`page.tsx:15-24`) to forward catalog filters.
- **Measured cold start** (audit, 2026-10-02): homepage 44 s cold vs 1.1 s warm; gateway `/health` timed out at 120 s cold.
- **Role landing:**
  - `login/page.tsx:37`, `GoogleSignInButton.tsx:70` and `accept-invite/page.tsx:47` send every role other than learner, QO and admin to `/teach`, which only allows educators (`teach/page.tsx:155`).
  - `teach/new/page.tsx:120` allows institution admins, but the API refuses to create a course for them (`course.service.ts:319-322`). The editor it redirects to (`:40`) doesn't allow them either (`teach/courses/[id]/page.tsx:495`), although `canAuthor` lets them edit their institution's courses (`course.service.ts:1429-1436`).
  - Back links on `/teach/new`, `/teach/analytics` and `/teach/coupons` point to `/teach`.
- **Refresh race** `web/src/lib/api.ts:44-55` (`tryRefresh`, no single-flight) and `:76-80` (each failed request calls `setAuth(null)`); refresh tokens are single-use (`api/services/auth/src/auth.service.ts:208-211`). Audit reproduced 5 × 401 → 2 refresh successes, 3 failures, session cleared.
- **Header overlap:** header is `fixed top-0` (`components/Header.tsx:72-73`); pages without `PageShell` (`.page-shell` = `pt-28 px-4`, `globals.css:148-150`) or `AuthShell` render under it: `help/page.tsx:181`, `educators/page.tsx:28`, `educators/[id]/page.tsx:39`, `(learn)/messages/page.tsx:121`, `(account)/notifications/preferences/page.tsx:97`, `learn/[courseId]/exam/[assessmentId]/page.tsx:222,276,365`.
- **375 px clipping:** grid items without `min-w-0` at `courses/[id]/page.tsx:92-93`, `learn/[courseId]/page.tsx:229-230`, `CoursePreviewPlayer.tsx:90`; `overflow-x: hidden` on html/body (`globals.css:116,121`) hides it and breaks `position: sticky` everywhere (verified in the audit).
- **Mobile menu:** `.glass` panel at 85% white (`Header.tsx:184`) with `backdrop-filter: none` at ≤768 px (`globals.css:396-403`).
- **Copy:** `&apos;` in JS strings at `help/page.tsx:33,37,45,58,86`; signup success always shows the "Local dev without an email key…" line (`signup/page.tsx:66`).
- **Verify:** footer links `/verify/example` (`Footer.tsx:19`, always "invalid"), Help links `/verify` (`help/page.tsx:53`, 404); only `(verify)/verify/[uid]/page.tsx` exists.
- **Tests:** vitest + Testing Library, 12 files, 5 of them for one editor page; no browser E2E; no coverage provider. CI e2e job runs the backend + API scripts only.

## Design and key decisions
1. **`serverApi` returns a result, not `null`:** `{ ok: true, data } | { ok: false, status: 404 } | { ok: false, status: 'unavailable' }`, with `AbortSignal.timeout(8000)`. 5xx responses, network errors and timeouts count as `unavailable`. Each kind of page then handles `unavailable` differently. It is never thrown to `error.tsx`, because Next 14 sanitizes Server Component errors in production (round-1 B1).
   - **Dynamic pages render the state themselves.** The course, catalog, educator profile and certificate pages work like this:
     - a real 404 → `notFound()`, or "not a valid certificate";
     - `unavailable` → render `<WakingUp />`, a small client component in `components/` that says "We're waking up the server. This can take up to a minute after a quiet period." Its Retry button calls `router.refresh()`, and it sets `role="status"`.
     - `generateMetadata` falls back to a generic title on `unavailable` and never throws.
   - **Prerendered pages** (home, `/educators`, sitemap) use `staticFallback(result, empty)` from `server-api.ts`:
     - the API answered → the data;
     - `unavailable` during `next build` (`process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD`, from `next/constants`) → `empty`, marked `unavailable: true`, so the build passes without a backend;
     - `unavailable` at runtime → throw. That fails the background revalidation, and Next keeps serving the last good page.
   - **Root files:** root `error.tsx` (generic "Something went wrong" with Retry) and `not-found.tsx` stay for real bugs and real 404s.
   - Rejected: retrying inside the server fetch, which would only hold the response open longer on a cold start.
2. **Home becomes ISR:** move the filter forwarding (`/?q=…` → `/courses?q=…`) to `next.config.mjs` `redirects()` with `has: [{ type: 'query', key: … }]`, which preserves query strings. Drop `searchParams` from the page and set `export const revalidate = 60`. The home page is then served from the cache and never waits on a sleeping gateway. Through `staticFallback` (decision 1), a failed revalidation keeps the last good page.
   - **Build without data:** if the build itself couldn't reach the API (a Vercel build while Render sleeps), `HomeClient` gets `coursesUnavailable`. The grid then shows a "Browse the catalog →" link to `/courses` instead of the "no courses" card (`home-client.tsx:291-305`), until the first successful revalidation fills it.
3. **Client "waking up" notice:**
   - In `web/src/lib/api.ts`, a request still pending after 4 s increments a small global counter (a tiny store, or a React context already used by `Providers`). A `WakingUpNotice` component (fixed, `aria-live="polite"`) shows while the counter is above zero. No retries are added; requests already wait.
   - **Opt-out for known-slow calls (round-1 S3):** `api(path, { slow: true })` never arms the timer. It is set on:
     - outline generation (`structure-generator.tsx:177`);
     - assessment generation (`teach/courses/[id]/page.tsx:370`);
     - tutor chat send (`tutor-panel.tsx:46`);
     - the study coach, `GET /attempts/:id/study-plan` (exam page `:455`);
     - the `upload.ts` calls.
   - Rejected: "show only until the first success". Each Render free service sleeps on its own, and an idle tab that comes back after 15 minutes is a real cold start.
4. **Role landing helper:** `homeForRole(role)` in `web/src/lib/` (learner → `/dashboard`, educator → `/teach`, institution_admin → `/institution`, quality_officer → `/qa`, platform_admin → `/admin`), used by login, Google sign-in, accept-invite, and as `safeNext`'s fallback (Phase 3). Back links on shared teach pages use it. Guards (round-1 S1):
   - `/teach/new` allows educators only, since the API refuses institution admins (`course.service.ts:319-322`).
   - The course editor allows educators and institution admins, matching `canAuthor` (`course.service.ts:1429-1436`).
   - `/institution` gets no "new course" action.
5. **Single-flight refresh:** one module-level `refreshPromise`; every 401 awaits it; only when that one refresh fails does the client call `setAuth(null)`; after success each request retries once with the new token.
6. **Header spacing in one place:** the root layout gives `<main>` the header's height as top padding (`pt-28` moved from `.page-shell` to the layout's content wrapper, keeping `.page-shell` for horizontal padding and width), so no page can render under the header again. The six pages also get `PageShell` for their horizontal container, and the home hero drops its own `pt-24 md:pt-28` (`home-client.tsx:65`) so it isn't padded twice. Rejected: only wrapping the six pages (the next new page would repeat the bug).
7. **Overflow:** add `min-w-0` to the grid columns (and `grid-cols-1 lg:grid-cols-3`), and change `overflow-x: hidden` on html/body to `overflow-x: clip`, which still prevents sideways scroll from decorative blobs but doesn't create a scroll container, so `sticky` works and real overflow shows up in QA.
8. **Opaque mobile menu:** the panel uses `bg-background` (solid, theme-aware) with a dimmed backdrop that closes the menu on tap.
9. **Copy:** plain `'` in the FAQ strings; delete the dev-only signup line (the "Resend email" link is P1-34, Phase 6/7).
10. **`/verify` page:** `web/src/app/(verify)/verify/page.tsx`, a labelled certificate-ID input that trims the value and routes to `/verify/<id>`; footer and Help link to `/verify`.
11. **Browser E2E (P1-30):** add `@playwright/test` to `web` devDependencies; it is the standard tool, and nothing lighter checks real browser layout.
    - **Config:** `web/playwright.config.ts`, Chromium only, base URL from env, traces on failure, `workers: 1` in CI. It sets `serviceWorkers: 'block'`, because `sw.js` (registered in `Providers.tsx:13`) would otherwise hide API reads from `page.route` and `page.on('request')`. Specs live in `web/e2e/*.spec.ts`.
    - **Logins (round-1 S2):** a setup project, `auth.setup.ts`, logs in through the login form once per seeded role and saves `e2e/.auth/<role>.json` (git-ignored). The other specs reuse that storage. Only the refresh spec logs in on its own. With the signup spec, the run makes 7 `auth-strict` calls in total, under the limit of 10. A comment in `playwright.config.ts` records this budget, so the next login-type spec doesn't silently push the count over. The CI limit is not raised, because `e2e-smoke.mjs` checks for the 429 at the default limit.
    - **CI e2e job, in order:**
      1. the existing API scripts, except the smoke script;
      2. build web with the e2e env (over a minute, which lets the per-IP bucket refill);
      3. `next start` on :3000;
      4. `pnpm -C web exec playwright install --with-deps chromium`, with `~/.cache/ms-playwright` cached and keyed on the locked `@playwright/test` version;
      5. run the suite;
      6. `e2e-smoke.mjs` last, because it deliberately exhausts the login bucket;
      7. upload the HTML report on failure.
    - **Specs:**
      - `auth.setup.ts`: each seeded role → lands on that role's home (P0-11); an institution admin on `/teach/new` gets no create form
      - expired token with parallel requests → one refresh call, still signed in (P0-12, by intercepting `/auth/refresh` and forcing the stored token to expire)
      - the six previously overlapped pages: the `h1` top is below the header's bottom (P0-13)
      - course page, lesson page, catalog and home at 375 px: `scrollWidth <= clientWidth` (P0-14); the enroll card is sticky at 1440 px (P1-58)
      - mobile menu open: the panel's computed background alpha is 1 (P0-15)
      - help page contains no `&apos;`; signup success contains no "notification service logs" (P0-16/17)
      - `/verify` form → certificate page shows valid for the seeded certificate, invalid for a bogus id (P0-18)
      - admin: Suspend → dismiss prompt → no `/status` request (Phase 3's P0-10 fix, now guarded)
      - server unavailable, using a second `next start` with `GATEWAY_INTERNAL_URL` pointed at a closed port (P0-09):
        - a course page shows the waking-up state, not a 404;
        - a certificate page shows the waking-up state, not "invalid";
        - the home page still renders the seeded course cards from the prerendered page.
    - **Coverage:** add `@vitest/coverage-v8` and a `test:coverage` script, reported in CI with no threshold yet.

12. **(A1, amendment after approval) Wake the services from the browser.**
   - **Production finding (2026-10-02, ethio-impl, read-only GETs):** with the services asleep, the gateway's calls to them got an immediate plain-text `429 Too Many Requests` with `x-render-routing: hibernate-rate-limited`, and retries over a minute stayed 429. The gateway calls the services' public `onrender.com` URLs (`render.yaml:155-175`), so this isn't the private network. Hitting each service's own `https://ethiopialearn-<svc>.onrender.com/health` from outside Render woke it (about 24 s each), and then the same request answered 200. Render doesn't document the header. Seen once; the design below works whether the cause is where the call comes from or a wake cooldown.
   - **Consequence for this plan:** `<WakingUp />` and its Retry (decision 1) would never recover on their own, and the 429 arrives at once, so the 4 s client notice (decision 3) never shows either.
   - **Classification: `isHibernation(res)`** (round-3 B1).
     - A `429` is *hibernation*, not throttling, when it carries `x-render-routing: hibernate-rate-limited` **or** its body isn't the gateway limiter's JSON (`{ statusCode: 429, … }`).
     - The browser calls the gateway cross-origin, and the gateway exposes no extra headers, so in the browser the body test is what decides. On the server (`serverApi`, no CORS) the header is readable too.
     - This stays web-only, with no gateway deploy. Rejected: adding `exposedHeaders` on the gateway, which couples this phase to a Render deploy and still needs the body test for older gateways.
   - **What each path does:**
     - `serverApi` counts hibernation as `unavailable` (with 5xx, network errors and timeouts).
     - Client `api()`: on hibernation, or when `fetch` itself rejects (network error), it calls `wakeServices()` and throws a typed `WakingError` ("The server is waking up. Try again in a minute.").
     - A JSON 429 from the gateway's own limiter is unchanged.
   - **Token refresh (round-3 B2).** After 15 idle minutes the access token has expired *and* auth is asleep, so the refresh is what meets the hibernation 429.
     - `tryRefresh` returns three outcomes, not a boolean: `ok`; `rejected` (401 or 403 from `/auth/refresh`); `waking` (hibernation 429, 5xx or network error).
     - Only `rejected` clears the session (decision 5's single logout).
     - `waking` calls `wakeServices()`, keeps the stored auth and throws `WakingError` to every waiter of the single-flight promise, so GET queries retry under the policy below. The next attempt starts a new refresh.
     - Retrying is safe: a hibernated request never reached auth, so the single-use refresh token wasn't consumed.
   - **`web/src/lib/wake.ts` → `wakeServices()`:**
     - one `fetch(url, { mode: 'no-cors', cache: 'no-store' })` per URL in `NEXT_PUBLIC_WAKE_URLS` (comma-separated public `/health` URLs: the gateway and the seven services);
     - fire-and-forget, errors swallowed, at most once per 60 s per tab (module-level timestamp);
     - unset (local, CI) → a no-op.
   - **Callers:**
     - `<WakingUp />` on mount;
     - `WakingUpNotice` when its counter first goes above zero;
     - `api()` on a hibernation 429.
   - **Client retries, GET queries only:** the `Providers` `QueryClient` retries a query that failed with `WakingError` every 10 s for up to 90 s. Other errors keep today's `retry: 1`. While such a retry is pending, `WakingUpNotice` shows. Mutations are not retried: they surface the `WakingError` message and still wake the services.
   - **Why the browser:** the observation shows a request from outside Render wakes a service, and the browser is outside Render by definition. Rejected:
     - waking from the Next server on Vercel: a serverless function's background work ends with the response, and it would add a server route for no gain;
     - having the gateway wake the services: it is inside Render, which is exactly what didn't work.
   - **Exposure:** these URLs are already public in `render.yaml` in a public repo. `/health` is unauthenticated and cheap, and every other route still needs `INTERNAL_API_TOKEN`. `no-cors` gives an opaque response, which is enough to wake a service, and needs no CORS change on the services. **Phase 10 note:** its CSP `connect-src` must include these hosts.
   - **Config:** add `NEXT_PUBLIC_WAKE_URLS=` (empty) with a comment to `web/.env.example`. List it in DEPLOYMENT.md's Vercel variables with the eight URLs from `render.yaml`. It is inlined at build time, so a Vercel redeploy follows setting it.

## Steps
- [x] 1. Branch from `origin/main` after Phase 3 merges.
- [x] 2. `serverApi` result type, `WakingUp`, `staticFallback` and every caller; root `error.tsx` and `not-found.tsx` (decision 1). Home ISR plus redirects and `coursesUnavailable` (decision 2).
  - vitest for `serverApi`: 404 vs 5xx vs timeout.
  - vitest for `staticFallback`: build phase returns empty, runtime throws.
  - `next build` shows `/` as ISR (`○` with revalidate), not `ƒ`.
  - `GATEWAY_INTERNAL_URL=http://127.0.0.1:9 pnpm -C web build` passes. This build replaces the `.next` that the running :3000 server serves, so follow the build order in step 9 (round-2 S4).
- [x] 3. `WakingUpNotice` (decision 3). · vitest with fake timers.
- [x] 3a. (A1) `wake.ts`, the hibernation 429 in `serverApi` and `api()`, `WakingError` retries in `Providers`, callers in `WakingUp` and `WakingUpNotice`; `.env.example` and DEPLOYMENT.md (decision 12).
  - vitest:
    - `wakeServices`: no calls when unset, one `no-cors` fetch per URL, none on a second call within 60 s.
    - `serverApi`: a hibernation 429 is `unavailable`; the gateway limiter's JSON 429 is as before.
    - `api()`, modelling the browser (a 429 with a plain-text body and **no readable** `x-render-routing`): it throws `WakingError` and wakes. A network rejection does the same. A JSON 429 doesn't.
    - Refresh: a hibernation 429 on `/auth/refresh` keeps auth, wakes and throws `WakingError` to all parallel waiters; a 401 logs out exactly once.
    - Queries retry on `WakingError` and stop after 90 s; a mutation doesn't retry.
- [x] 4. `homeForRole` + call sites + guards (decision 4). · vitest.
- [x] 5. Single-flight refresh (decision 5). · vitest: 5 parallel 401s → 1 refresh, no logout; failed refresh → logout once.
- [x] 6. Layout header spacing + `PageShell` on the six pages; `min-w-0`, `overflow-x: clip`; opaque menu; copy fixes; `/verify` page (decisions 6–10).
- [x] 7. Playwright config, specs, CI wiring; coverage script (decision 11).
- [x] 8. Before/after screenshots of every touched page at 375/768/1440 into `docs/plans/2026-10-02-refinement-audit/screenshots/after-phase5/` (ignored by git) for the user.
- [ ] 9. Full gate:
  - web typecheck, vitest and build;
  - local build order (round-2 S4):
    1. the no-backend build from step 2, as a check;
    2. a normal build with the stack up, so the prerendered home page has the seeded courses;
    3. restart `next start` on :3000 by killing the `next-server` PID, never with a `pkill -f` pattern;
    4. Playwright.

    In a separate worktree (for example, if a second web implementer runs this phase), use another port and the same order;
  - the Playwright suite locally against the running stack;
  - api untouched (`pnpm -C api test` still green);
  - on the PR, CI's `web` job (no backend) and `e2e` job both pass.
- [ ] 10. Code review by ethio-plan-review; user approves push/PR.

## Test plan
- vitest: `serverApi` outcomes (including the hibernation 429, A1); `wakeServices` and `WakingError` retries (A1); `staticFallback` build vs runtime; `WakingUp` Retry; `homeForRole`; single-flight refresh (parallel 401s, failure path); `WakingUpNotice` threshold and the `slow` opt-out; `/verify` form routing; copy regressions (no `&apos;` in FAQ data).
- Playwright smoke (decision 11), locally and in CI.
- Commands: `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`; `pnpm -C web exec playwright test` (stack running, web on :3000).

## Rollout and ops
- Vercel builds the new static home page; nothing needs configuring, and the redirects ship in `next.config.mjs`. A build that runs while Render sleeps waits up to 8 s per prerendered fetch, then succeeds with empty data. The home page shows the "Browse the catalog" link until the first successful revalidation, usually within a minute or two of the first visit.
- CI gains ~3–4 minutes for the web build and Playwright (Chromium install is cached by the runner image only partially).
- **(A1)** Before the deploy, the user sets `NEXT_PUBLIC_WAKE_URLS` on Vercel (Production) to the eight public `/health` URLs. After it, a read-only check: leave the site idle for 20+ minutes, open a course page, and expect the waking-up page. The browser's network panel shows the eight `/health` requests, and Retry after about a minute shows the course. Expect up to eight `ERR_BLOCKED_BY_RESPONSE` console errors per wake: Helmet's `Cross-Origin-Resource-Policy: same-origin` blocks the opaque responses, but the requests still reach Render and wake the services (round-3 N1). Then sign in, wait 20+ minutes, and click into the dashboard: expect "waking up" and then the page, still signed in (B2).

## Risks and open questions
- **Cold-start time is unchanged on the API side** (free tier by decision); this phase makes it honest and keeps the home page instant. Pages that need live data (course, certificate, dashboards) still wait up to the timeout and then show the waking-up page.
- **8 s server timeout vs a 45 s cold start:** the first visitor to a course page after idle sees the waking-up page and a Retry; the retry after ~30–60 s succeeds, *because the page's `wakeServices()` woke the services (A1)*. Accepted as the honest outcome on the free tier.
- **(A1) If browser pings don't wake a service either** (e.g. the cause turns out to be a cooldown), the rollout check shows it; then the fallback is Phase 11's external scheduler, which pings `/health` from outside Render before the busy hours.
- **Fetch caching with a signal:** in step 2, confirm that fetches with `AbortSignal.timeout` still use Next's data cache (watch the build log, and `x-nextjs-cache` under `next start`). React's request memoization skips signalled fetches, so `generateMetadata` and the page each fetch the course. That is acceptable if the data cache holds.
- **Playwright in CI flakiness:** specs wait on network idle and specific elements, never fixed sleeps; traces are kept on failure.

## Progress and deviations (implementer)
Branch `fix/web-p0`, stacked on `fix/payment-integrity` @ `2cdccf9` (handoff → Branch). Commits: `ca0d9fd` plan folder, `f802460` step 2, `3d4c4cd` steps 3/3a/5, `31e1d65` step 4, `3e84bdd` step 6, `62e29a1` step 7, `fe8ce18` the /teach overflow found in step 8.

Deviations (none changes a decision):
- **Step 1:** branched from `fix/payment-integrity`, not `origin/main`, as the handoff says (merge `origin/main` in once #19, Phase 3 and Phase 4 land).
- **Step 4:** `homeForRole` is Phase 3's existing `roleHome` (`lib/safe-next.ts`), extended (institution_admin → `/institution`, unknown → `/`), plus `roleHomeLabel` and `RoleHomeBackButton` (`components/BackButton.tsx`) for the shared teach pages. The editor guard keeps `platform_admin`, because `canAuthor` allows it.
- **Step 2:** `serverApi` maps a malformed id (400) and the gateway limiter's JSON 429 to `404`, as before. `generateMetadata` on `unavailable` also sets `robots: noindex`. `/educators` says "The ranking is loading" when the build had no data.
- **Steps 3a/5:** offline (`navigator.onLine === false`), a network error stays a network error rather than a `WakingError`. The limiter's JSON 429 on `/auth/refresh` keeps the session and throws `ApiError(429)`. The single logout happens inside the single-flight refresh, so `refreshSession()` (invites) now also logs out on a rejected refresh. The offline outbox treats `WakingError` as a network error and queues the write.
- **Step 6:** the six pages get the `.page-shell` class on their existing outer div (the same container `PageShell` renders, without the glow). The exam's sticky bar moved to `top-24`, below the fixed header. The mobile-menu backdrop is a sibling of the nav, because the nav's transform would contain a fixed child. The header nav has `aria-label="Main"`.
- **Step 7:** Playwright's `webServer` starts both servers (`:3000`, reused if it's already up, and the cold twin on `:3100`), so CI has no separate `next start` step. Both servers pin `NODE_ENV=production`: locally, `api/.env.example` (`NODE_ENV=development`) exported into the shell made `next start` drop the stale-page fallback, and the cold home page returned 500. Two corrections to what the plan assumed: the cold server does write `.next` (a failed revalidation re-saves the page it had, with a 30 s retry, which is harmless), and the CI action versions are `actions/cache@v6` and `actions/upload-artifact@v7`.
- **Step 8 (P0-14, beyond the plan's list):** `/teach` was 414 px wide at 375 (it was 409 before this phase too). `PageHeader`'s actions now wrap. A 375 px sweep of 35 routes across all roles is clean, and the layout spec covers `/teach`.

Verified so far: web typecheck; vitest 26 files and 354 tests, with coverage (46.9% statements); the no-backend build (`GATEWAY_INTERNAL_URL=http://127.0.0.1:9`) passes, with `/` as `○` revalidating every 60 s and the "Browse the catalog" fallback; signalled fetches write the data cache; the full Playwright suite passed (26/26, 4 workers, clean env) on the `el_e2e` stack. Screenshots: 96 in `screenshots/after-phase5/`, the same names as `before/`, plus new `course-waking-*`, `verify-cert-waking-*` and `home-cold-1440`.

### In flight / next step (checkpoint 2026-10-03)
- Nothing half-done; everything is committed. Not pushed.
- **Local stack right now:** the backend runs on the throwaway `el_e2e` DB with `.env.example` values (started by `e2e-up.sh`), and `:3000` is `next start` from this tree's e2e build. The dev stack is **not** running.
- **Next, step 9 (full gate):**
  1. the no-backend build;
  2. a normal build against `el_e2e`;
  3. restart `:3000` (kill the `next-server` PID only);
  4. the full Playwright suite in a clean env (`env -i HOME=$HOME PATH=<node22>:/usr/bin:/bin ./node_modules/.bin/playwright test`; never with `api/.env.example` exported; at most one run a minute, since setup uses 5 of the 10 auth-strict calls);
  5. `pnpm -C api test`.
- Spot-check a few after screenshots by eye (`course-free-375`, `home-375-menu-open`, `course-waking-375`).
- Then restore the dev stack: `scripts/stop-backend.sh`; drop `el_e2e`; `env -i HOME=$HOME PATH=… bash -c 'cd <repo> && bash scripts/start-backend.sh'`; rebuild web against it and restart `:3000`.
- Then ask ethio-plan-review for code review: branch `fix/web-p0`, base `fix/payment-integrity`.
- **Runners** (this session's scratchpad, `/tmp/claude-1000/-home-kal-Documents-code-ethi0-learning-platform/0d010fd6-606b-45cf-bdfb-30c0c3784a74/scratchpad/`): `e2e-up.sh`, `e2e-env.sh` (source it only for API scripts, never for Playwright), `shots.cjs` (after screenshots), `sweep.cjs` (375 px overflow sweep).
- **Environment:** `export PATH="/home/kal/.local/opt/node22/bin:$PATH"`. Stage explicit paths; other plan folders in the tree belong to other sessions. Never `pkill -f` a pattern that's also in your own command line (it kills your shell). Production is off-limits.
