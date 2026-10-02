# Plan review: Phase 5, web P0 fixes and browser E2E

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)"), against `origin/main` web (`server-api.ts`, the home page and hero, root layout, `globals.css`), the course service's create and author guards, and the gateway rate policy.

Checked and OK:
- `serverApi` turns every failure into `null` (`server-api.ts:4-14`), and the home page is dynamic only because it reads `searchParams` (`(public)/page.tsx:14-27`), so decisions 1 and 2 target the right causes. `serverApi` already uses `next: { revalidate }`, so the home page can become ISR once `searchParams` is gone.
- The `redirects()` `has: query` rules pass the query string through to `/courses`, so the legacy filter URLs keep working.
- The two devDependencies are justified: Playwright is the standard browser runner and nothing lighter checks real layout, and coverage-v8 is vitest's own provider.

### Blockers
- **B1. "Throw on `unavailable`" breaks the build and can't show the waking-up page in production** at Decisions 1 and 2
  Two scenarios:
  1. **Build.** Once `/` is ISR, `next build` pre-renders it, calling `serverApi('/search…')` at build time. Every build without a reachable gateway then throws `ServiceUnavailableError` during static generation, and the build fails:
     - the CI `web` job (no backend; `localhost:4000` refuses at once)
     - the web Docker image build
     - every Vercel production build while the free Render gateway is asleep (the 44 s cold start exceeds the 8 s timeout)

     Today the home page is dynamic, so the build never fetches.
  2. **Runtime.** Next 14 sanitizes errors thrown in Server Components in production. `error.tsx` receives a generic `message` plus a `digest`, never the class or name. So the error boundary can't tell `ServiceUnavailableError` from a real bug. Either every server error shows "We're waking up the server" (which hides real bugs), or none does, and P0-09's acceptance criterion fails under `next start` and on Vercel. It only appears to work in `next dev`.

  Suggested fix:
  - Dynamic pages (course, certificate) render a `WakingUp` component directly when `serverApi` returns `unavailable`, with a client Retry that calls `router.refresh()`. Keep `error.tsx` generic.
  - The ISR home page throws on `unavailable` only during runtime revalidation, so Next keeps serving the last good page. During the build phase (`process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD` from `next/constants`), it renders with an empty course list so the build passes; the first successful revalidation fills it.
  - The P0-09 Playwright spec already runs against `next start`, so it will prove the production behavior. Also add a check that `pnpm -C web build` passes with no backend running.
  Response: **Fixed (accepted both scenarios).** Checked the current build: `/educators` and `/sitemap.xml` are already prerendered at build time (`.next/prerender-manifest.json`), so they share the problem, while the course, catalog, educator profile and certificate pages are dynamic (`ƒ`). Decisions 1 and 2 are rewritten as follows:
  - **Dynamic pages render the state themselves.** The course, `/courses`, educator profile and certificate pages render a `WakingUp` component on `unavailable`. It is a client component with Retry calling `router.refresh()`. `generateMetadata` falls back to a generic title and never throws. `error.tsx` stays generic, for real bugs.
  - **Prerendered pages use one helper, `staticFallback(result, empty)`, in `server-api.ts`.** The home page, `/educators` and the sitemap call it. When the API answered, it returns the data. When the API is unavailable during `next build` (`NEXT_PHASE === PHASE_PRODUCTION_BUILD`), it returns `empty` plus `unavailable: true`. When the API is unavailable at runtime, it throws, so the revalidation fails and Next keeps the last good page.
  - **The home page knows when its course list is empty only because the build couldn't reach the API.** In that case the grid shows "Browse the catalog" instead of the "no courses" card. This happens after a Vercel build while Render sleeps, until the first successful revalidation.
  - **New acceptance criterion and check:** the web build passes with no backend. The CI `web` job already builds without one, which proves it. Locally the check is `GATEWAY_INTERNAL_URL=http://127.0.0.1:9 pnpm -C web build`, so the shared stack can keep running.
  - **The P0-09 Playwright spec now also checks the home page.** With the gateway pointed at a closed port, the home page still renders seeded course cards from the prerendered page.

### Should-fix
- **S1. `/teach/new` shouldn't allow institution admins, because the API refuses them** at Decision 4. `CourseService.create` throws 403 "Institutions do not create courses directly" for `INSTITUTION_ADMIN` (`course.service.ts:319-322`). `canAuthor` (`:1429-1436`) only lets them edit their institution's existing courses. Opening both guards to institution admins means a form that always fails on submit, which is the kind of dead end P0-11 is meant to remove. Suggested: the editor guard allows institution admins (matching `canAuthor`), `/teach/new` doesn't, and their role home `/institution` offers no "new course" action.
  Response: **Fixed.** `/teach/new` allows educators only. The editor guard allows educators and institution admins, matching `canAuthor`. Phase 5 adds no "new course" action to `/institution`. Decision 4 is updated.
- **S2. The Playwright suite will hit the login rate limit** at Decision 11. `auth-strict` allows 10 per minute per IP (`rate-policy.ts:26-28`), and every CI login comes from 127.0.0.1. Five role logins, plus the refresh, overlap, admin and exam specs, running in parallel workers, easily exceed 10 in a minute, especially right after `e2e-smoke.mjs` deliberately exhausts that bucket. Specs then fail with 429 at random. Suggested: log in once per role in a Playwright global setup and reuse it through `storageState`, run the suite before the smoke step (as `e2e-revisions` already is), and/or set `RATE_LIMIT_AUTH_STRICT_PER_MIN` higher in the CI e2e env (`main.ts` already reads the override).
  Response: **Fixed (storageState plus ordering; no limit override).** Raising `RATE_LIMIT_AUTH_STRICT_PER_MIN` in the e2e env would break `e2e-smoke.mjs`'s 429 check, which counts on the default limit. Instead:
  - **One setup project logs in each role once.** `auth.setup.ts` logs in through the real login form as each of the 5 seeded roles, asserts the landing page (this is the P0-11 spec) and saves `e2e/.auth/<role>.json`. Every other spec reuses that storage.
  - **The refresh spec logs in on its own,** because rotating a single-use refresh token would invalidate the shared learner state. That makes 6 `auth-strict` calls in total, under the limit of 10.
  - **CI order:** API scripts → web build (over a minute, so the bucket refills) → Playwright → `e2e-smoke.mjs` last. Workers are 1 in CI.
- **S3. The 4 s "waking up" notice will fire on requests that are just slow** at Decision 3. AI outline generation, assessment generation, the study coach, chat and video chunk uploads routinely take longer than 4 s on a warm server. Every educator who clicks "Generate with AI" would see "Waking up the server, this can take up to a minute". Suggested: let known-slow calls opt out (`api(path, { slow: true })`, or exclude the AI and upload paths), or show the notice only until the session's first successful API response, since a cold start only affects the first calls.
  Response: **Fixed (opt-out).** `api(path, { slow: true })` skips the 4 s notice. It is set on outline generation (`structure-generator.tsx:177`), assessment generation (`teach/courses/[id]/page.tsx:370`), tutor chat send (`tutor-panel.tsx:46`) and the upload calls in `upload.ts`. I chose an opt-out over "only until the first success" because each Render free service sleeps on its own. A warm gateway says nothing about whether the course service is awake, and an idle tab that comes back after 15 minutes is a real cold start.

### Nits (optional)
- **N1.** Moving `pt-28` to the layout's `<main>` double-pads the home hero, which has its own `pt-24 md:pt-28` (`home-client.tsx:65`, the only other header offset in `web/src`). Remove it in the same change.
- **N2.** In CI, use `pnpm -C web exec playwright install --with-deps chromium` (not `npx`) so the browser build matches the locked `@playwright/test`, and cache `~/.cache/ms-playwright` keyed on that version to keep the cost of decision 11 down.
  Nit responses:
  - N1: taken. Decision 6 removes the home hero's own `pt-24 md:pt-28`.
  - N2: taken. Decision 11 uses `pnpm -C web exec playwright install --with-deps chromium` and caches `~/.cache/ms-playwright` keyed on the locked version.

## Round 2 (2026-10-02) · Verdict: APPROVED (one should-fix to fold in before handoff)
Reviewed: the round-1 rework in `plan.md` (status "in review (round 2)"): decisions 1–4 and 11, the acceptance criteria, steps 2 and 9, the test plan and rollout. Checked against the installed Next 14.2.35 sources, `origin/main` web and the gateway rate policy.

Round-1 findings:
- **B1** resolved. Verified in Next's sources:
  - `next build` sets `NEXT_PHASE` in the parent process (`build/index.js:1054`) before it spawns the static workers (`:1090`), which inherit the environment. So `staticFallback` sees the build phase where the pages are actually prerendered.
  - A failed background revalidation keeps the stale entry, re-sets it to retry within 30 s, and only logs the error (`server/response-cache/index.js:127-140`). So "throw at runtime, keep the last good page" holds under `next start`.
  - The fetch's `revalidate` is recorded before the request is made (`server/lib/patch-fetch.js:381-387`). So the sitemap stays ISR (3600 s) even when its build-time fetch fails, instead of being frozen empty until the next deploy.
  - Answering part of the "Fetch caching with a signal" risk: Next drops the `signal` when it re-fetches a stale data-cache entry (`patch-fetch.js:415-435`, used at `:592-620`). So the 8 s timeout doesn't apply to background revalidations of the home page, `/educators` or the sitemap. That's harmless: they run behind a served stale page, and a fetch with no cache entry still gets the timeout.
- **S1** resolved: `/teach/new` is educators-only, the editor matches `canAuthor`, and the spec checks the institution admin.
- **S2** resolved. `auth-strict` covers only login, signup, verify-email, accept-invite and reset-password (`rate-policy.ts:41-42`); refresh is in the 30/min `auth` bucket. Tokens live in `localStorage` (`api.ts:23-33`), which `storageState` captures. See N4 for the count.
- **S3** resolved, except one call (N3).
- **N1, N2** taken.

### Should-fix (new, in a changed part)
- **S4. The local no-backend build replaces the build that the running :3000 server serves** at Step 2 / Step 9
  The web on :3000 is `next start` from this working tree's `web/.next` (a production build; `BUILD_ID` present). `next build` first deletes everything in `.next` except `cache/` (`build/index.js:694`), then writes a new build. Running step 2's `GATEWAY_INTERNAL_URL=http://127.0.0.1:9 pnpm -C web build` "so the shared stack can keep running" therefore pulls the files out from under the running server: chunks and server modules it hasn't loaded yet disappear or no longer match its in-memory manifests, so pages on :3000 break until it is restarted. It also leaves the empty "Browse the catalog" home page as the prerendered one, so step 9's local Playwright run fails the new P0-09 check that the home page renders the seeded courses.
  Suggested: run the branch's web builds and the Playwright suite from a separate `git worktree` with its own `next start` on another port (decision 11's base URL comes from env). Build with no backend first, then build with the backend reachable last, before Playwright. CI isn't affected, because the `web` and `e2e` jobs build separately.
  Response: **Fixed, with build order instead of a worktree.** Step 9 now fixes the local build order:
  1. the no-backend build, as a check;
  2. a normal build with the stack up;
  3. restart :3000 by killing the `next-server` PID;
  4. Playwright.

  The implementer owns this tree, and restarting :3000 after a web build is already in every handoff. A second worktree would need its own `pnpm install` and stack wiring for a check that runs a couple of times. If this phase does run in a worktree (the optional second web implementer), the plan says to use another port with the same order.

### Nits (optional)
- **N3.** The study coach is also an LLM call: `GET /attempts/:id/study-plan` (exam page `:455`, in `rate-policy.ts`'s `AI_GET`). Add it to the `{ slow: true }` list.
- **N4.** The `auth-strict` count is 7, not 6: the signup spec (P0-16/17) submits `/auth/signup`. That's still fine, even with smoke's 3 logins afterwards, if they fall in the same minute (10 of 10). It leaves no headroom, though, so note the budget in the Playwright config so a later login-type spec doesn't silently push it over.
- **N5.** Set `use: { serviceWorkers: 'block' }` in the Playwright config. `sw.js` (registered in `Providers.tsx:13`) handles navigations and API reads, and `page.route` / `page.on('request')` don't see requests that a service worker makes. So the P0-12 spec could miss the parallel API calls it counts or intercepts.
  Nit responses (round 2):
  - N3: taken. The study coach is added to the `slow` list in decision 3.
  - N4: taken. The count is now 7, and the budget comment goes in `playwright.config.ts`.
  - N5: taken. The config sets `serviceWorkers: 'block'`.

## Round 3 (2026-10-02) · Verdict: CHANGES REQUESTED (A1 delta only)
Reviewed: amendment A1 (decision 12, step 3a, and the "(A1)" lines in Goal, Non-goals, Test plan, Rollout and Risks). Checked against `origin/main`: `web/src/lib/api.ts`, `web/next.config.mjs` (no rewrites), and `api/gateway/src/main.ts` (CORS and proxy). Also `DEPLOYMENT.md` (the Vercel and Render origins are cross-site).

The server-side part holds. `serverApi` runs on Vercel and isn't subject to CORS, so it can read `x-render-routing`. A hibernation 429 then gives `unavailable` → `<WakingUp />`. That component wakes the services from the browser on mount, and Retry recovers. The `no-cors` `/health` pings, the 60 s throttle, the GET-only retries and the exposure reasoning are sound. The two blockers are both on the client path.

### Blockers
- **B1. The browser can't read `x-render-routing`, so `api()` never classifies a hibernation 429.** The browser calls the gateway cross-origin: `NEXT_PUBLIC_API_URL` (`api.ts:3`) points at `*.onrender.com`, the site is on `*.vercel.app`, and there is no Next rewrite. The gateway's `app.enableCors({ origin, credentials })` (`main.ts:83-91`) sets no `exposedHeaders`. In a CORS response, the browser shows only the safelisted headers, so `res.headers.get('x-render-routing')` is `null` in production.
  - **Scenario:** a signed-in learner opens `/dashboard` after the services have slept. `api()` gets the hibernation 429, can't see the header, and throws a plain `ApiError(429)`. Nothing wakes, nothing retries, and the dashboard shows an error. That fails A1's acceptance criterion for every client-fetched page.
  - The planned vitest builds a `Response` whose headers are readable, so it passes while production fails.
  - **Fix (either is fine):**
    - (a) The gateway adds `exposedHeaders: ['x-render-routing']`. That's one line, but it's an API change in a web-only phase, so it needs a gateway test and a Render deploy before or with the web deploy.
    - (b) Keep it web-only and classify by body as well. The gateway's own limiter answers JSON `{ statusCode: 429, … }`, and the observed hibernation 429 is plain text. So: a 429 whose body isn't that JSON, or that carries the header when it's readable, counts as hibernation.
  - Either way, the vitest should model the browser: a 429 response with no readable `x-render-routing`.
  Response: **Fixed with (b), web-only.** `isHibernation(res)`: the header when readable, **or** a 429 body that isn't the gateway limiter's JSON. I rejected (a) because it couples this web phase to a Render deploy, and the body test would still be needed for an older gateway. `api()` also treats a rejected `fetch` (network error) as waking. Step 3a's vitest builds the browser case: a plain-text 429 with no readable header.
- **B2. A user who comes back after more than 15 minutes is logged out instead of seeing "waking up".** The access token lives 15 minutes (`auth.service.ts:30`), and a free Render service sleeps after 15 idle minutes, so the common return case has both at once.
  - **Scenario:**
    1. The gateway wakes on the browser's request and answers 401 for the expired JWT.
    2. The single-flight refresh (decision 5) sends `POST /auth/refresh`, which reaches the sleeping auth service and gets the hibernation 429.
    3. Today `tryRefresh` returns `false` on any non-OK response (`api.ts:46-55`), and decision 5 says "only when that one refresh fails does the client call `setAuth(null)`".
    4. So the user is signed out, and decision 12's `WakingError` never comes into play, because the refresh goes through `tryRefresh`, not `api()`.
  - **Fix:**
    - Decision 5/12: only a 401 or 403 from `/auth/refresh` counts as a failed refresh that clears the session.
    - A hibernation 429 (classified as in B1), a 5xx or a network error wakes the services, keeps the stored auth, and throws `WakingError`, so a GET query retries under decision 12's 90 s policy.
    - Retrying the refresh is safe: the hibernated request never reached the auth service, so the single-use refresh token wasn't consumed.
    - Add vitest for both: a hibernation 429 on refresh keeps auth and throws `WakingError`, and a 401 on refresh logs out once.
  Response: **Fixed as proposed.** Decision 12 now has a token-refresh bullet: `tryRefresh` returns `ok | rejected | waking`; only `rejected` (401/403) clears the session, and `waking` (hibernation 429, 5xx, network error) wakes the services, keeps auth and throws `WakingError` to every single-flight waiter. Step 3a has both vitest cases.

### Nits (optional)
- **N1.** Helmet's default `Cross-Origin-Resource-Policy: same-origin` makes the browser block the opaque `no-cors` `/health` responses. The request still reaches Render, so the service still wakes, but each wake can log up to eight `ERR_BLOCKED_BY_RESPONSE` console errors. Mention it in the rollout check so nobody reads them as a failure.

On ethio-planner's FYI, Phase 7b A1 (keep `placehold.co` in the demo seed): no blocker. That matches `submitBlocker` (`course.service.ts:680`). One thing to know: if 7b adds its Amharic-titled course to the shared `scripts/lib/sample-catalog.mjs`, then `scripts/sample-content.mjs` (branch `feat/sample-content`) will publish it on production too, the next time the user runs it. Put the course in `demo-seed.mjs` only if that isn't wanted.
  Response: **Taken.** 7b's A1 now puts the Amharic test course in `demo-seed.mjs` only, not in the shared catalog.

## Round 4 (2026-10-02) · Verdict: APPROVED (A1; checks the round-3 fixes only)
- **B1** resolved. `isHibernation` uses the header when it's readable, and otherwise a 429 whose body isn't the gateway limiter's JSON. A rejected `fetch` also counts as waking. That covers the other browser outcome too: if a proxied hibernation 429 ever arrives without CORS headers, the browser rejects the fetch with a network error, and that is now handled the same way. The step 3a vitest models the unreadable header.
- **B2** resolved. `tryRefresh` returns `ok | rejected | waking`, and only a 401 or 403 clears the session. `waking` wakes the services, keeps the stored auth and rejects every single-flight waiter with `WakingError`, and the next attempt starts a new refresh. Step 3a has both cases.
- **N1** and the 7b note were taken.
