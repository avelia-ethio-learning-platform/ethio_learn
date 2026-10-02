# Code review: Phase 5, web P0 fixes and the browser E2E harness

## Round 1 (2026-10-03) · Verdict: APPROVED (two should-fixes to fix or defer before the PR)
Reviewed: `git diff fix/payment-integrity...fix/web-p0` at `ce22cb8` (75 files, web and CI only), against `plan.md` including A1 and the deviations log.

What I ran, without touching the working tree:
- `pnpm -C web typecheck` → passes.
- `pnpm -C web test` → 26 files, 354 tests pass.
- Against the running `next start` build of this branch (BUILD_ID 00:23):
  - `/` serves `x-nextjs-cache: HIT` with `s-maxage=60`, and its revalidation completes;
  - `/educators/<id>` is `private, no-store`, so it's rendered per request and never ISR-cached.

What I didn't run:
- `next build`, because it would overwrite the `.next` that the running stack serves;
- Playwright. Impl's clean-env run is 27/27, and CI runs it again.

Verified as the plan states:
- **P0-12, single-flight refresh** (`api.ts:62-102,155-172`):
  - concurrent 401s share one `refreshInFlight` promise, and `.finally` clears the slot;
  - a late 401 whose token was already replaced resends without a second refresh;
  - only a 401/403 from `/auth/refresh` signs out, once, inside the shared promise;
  - a hibernation 429, a 5xx or a network error returns `waking` and keeps the session;
  - the limiter's JSON 429 throws `ApiError(429)` and keeps the session;
  - there's no retry loop.
- **A1:**
  - `isHibernation` reads the header or a non-limiter body;
  - `wakeServices` fires at most once a minute per tab and is a no-op without `NEXT_PUBLIC_WAKE_URLS`;
  - `WakingError` queries retry 9 times at 10 s. Mutations don't retry, and the offline outbox keeps a `WakingError` write.
- **P0-09:**
  - the course and certificate pages render `<WakingUp />` on `unavailable`, and real 404s still reach `notFound()` or "not valid";
  - `staticFallback` returns empty at build and throws at runtime;
  - the cold-start specs run the same build against a dead API on `:3100`.
- **P0-11:** login, Google and accept-invite use `roleHome`. The `RequireRole`s on `/teach/new`, the editor, `/institution`, `/qa` and `/admin` match the API, with no redirect loop. `safeNext` is unchanged.
- **CI:** the e2e job's order matches the plan (smoke script last), `.auth` is git-ignored, and there are no secrets in the workflow.

### Blockers
None.

### Should-fix
- **S1. The public pay-link page tells a payer the link is dead while the financial service is waking** (`web/src/app/(public)/pay/[token]/page.tsx:30-34,54`)
  - **The code:** the query sets `retry: false`, and `if (loadError || !data)` renders "Request not found. This payment link is invalid or has expired."
  - **What breaks:** someone opens a pay request from a sponsor's message after a quiet period. `api()` throws `WakingError`, the page shows the dead-link card, and the 90 s waking retries never run.
  - **Why it matters here:** this is the false "invalid" that P0-09 removes from the course and certificate pages, on a page that moves money. The plan didn't list the page, so it's an omission, not a deviation.

  Suggested:
  - drop `retry: false` so the default policy applies;
  - render a waking state while `loadError instanceof WakingError` (or while the query is still retrying);
  - keep "not found" for `ApiError` 404/400 only;
  - add one vitest.

  Response: **Fixed in `ea31a78`, with one change from the suggestion.**
  - The query uses `retry: retryWhileWaking` (new in `query-client.ts`), not the default policy. It retries a `WakingError` every 10 s for 90 s, exactly like the default, but doesn't retry other errors. Dropping `retry: false` outright would have made a real dead link retry once and show "not found" about 2 s later.
  - A `WakingError`, a 5xx or a 429 renders `<WakingUp onRetry={refetch} />`. That's the same split as `serverApi`'s `unavailable`. `WakingUp` takes an optional `onRetry`, so Retry refetches on a client-fetched page.
  - Any other error keeps the card.
  - vitest (`pay/[token]/page.test.tsx`, 5 cases): a 404 is final with no retry; a waking service keeps loading and then shows the request; after 90 s it shows waking, and Retry refetches; a 500 and a 429 aren't a dead link. Plus `retryWhileWaking` and `WakingUp onRetry` cases.
  - **New finding while verifying this, pre-existing and not in this phase:** `GET /pay-requests/:token` answers **401 to everyone**, so the pay page has never worked.
    - The gateway marks the GET public (`routes.ts:54`).
    - The financial `GrowthController` has a class-level `@UseGuards(RolesGuard)` (`growth.controller.ts:174`), and `RolesGuard` throws "Authentication required" when there's no user, even with no `@Roles` (`roles.guard.ts:25`).
    - The page calls it with `{ auth: false }`, so no token is ever sent.
    - Reproduced on the e2e stack with a real request: anonymous → 401, Bearer → 200. The same code is on `origin/main` (since `cadf91e`, 2026-09-13).
    - So in production every pay link shows "Request not found". After this fix it still does, because a 401 isn't `unavailable`. I deliberately didn't map the 401 to the waking state, which would loop.
    - The fix belongs in the API (exempt that handler from the guard, plus an e2e check). That's an auth change on a payment controller, so I've sent it to ethio-planner to place, not added it to this web-only phase.
- **S2. `serverApi` maps the gateway limiter's JSON 429 to a 404** (`web/src/lib/server-api.ts:39-42`)
  - **Why it trips:** SSR calls are anonymous, so the gateway keys them by IP (`main.ts:100-107`). Every server-side fetch from Vercel shares the egress IP's `general` bucket (300/min). A crawler walking course pages can trip it.
  - **What breaks:**
    - course pages answer `notFound()`, a real 404 for the crawler;
    - certificate pages say "Not a valid certificate";
    - a home or `/educators` revalidation that meets the 429 goes through `staticFallback`'s 404 branch and replaces the last good page with an empty one until the next revalidation.
  - **Against the plan:** this contradicts the acceptance criteria "never a false 404 or a false invalid certificate" and "a failed revalidation keeps the last good page". Step 3a said "as before", so impl followed the plan; this is a gap in the plan I approved.

  Suggested:
  - return `UNAVAILABLE` for every 429, keeping `NOT_FOUND` for 404/400;
  - update the `server-api` vitest.

  Or defer with a reason. 9c and 11b touch the same limiter keys.

  Response: **Fixed in `d9caa7c`.** Every 429 and every 5xx is `UNAVAILABLE`, and 404/400 stay `NOT_FOUND`. `serverApi` no longer needs `isHibernation`; the client `api()` still uses it. The vitest now expects `unavailable` for the limiter's JSON 429. So a course page shows `<WakingUp />` with `noindex`, the certificate page shows waking, and `staticFallback` throws at runtime, which keeps the last good home or `/educators` page.

Checked and not findings:
- **An ISR-cached waking page on `/educators/[id]`:** the route is dynamic at runtime (`private, no-store` on repeated requests), so Retry re-renders it.
- **`refreshSession()` after accepting an institution invite failing on a sleeping auth:** the accept call itself is served by auth, so auth is awake for the refresh that follows.

### Nits (optional, max 3)
- **N1.** In `runRefresh`, `res.json()` on a malformed 200 throws a `SyntaxError`. That error is neither `ApiError` nor `WakingError`, so the caller gets a raw parse error. Treat it as `waking` (`api.ts:86-88`).
- **N2.** The role-aware back-link test (`e2e/roles.spec.ts:14-17`) checks only the label. Click the link and assert `toHaveURL('/institution')`.
- **N3.** `web/Dockerfile` has `ARG`s for the other `NEXT_PUBLIC_*` variables but not `NEXT_PUBLIC_WAKE_URLS`, so a self-built image can't turn A1 on.

Responses to the nits (all taken, in `42e3963`):
- **N1:** `runRefresh` treats a 200 whose body isn't JSON as `waking`: it wakes the services, keeps the session and throws `WakingError`. vitest added.
- **N2:** the spec opens `/teach/analytics` in a new tab from `/institution`, clicks Back and expects `/institution`.
  - A plain `page.goto` leaves `about:blank` in the history, so `BackButton` took `router.back()` and the first try landed on `about:blank`.
  - A new tab has no history, which is the case where the role-aware fallback applies.
  - 3/3 with `--repeat-each=3`.
- **N3:** the `ARG` and `ENV` are in `web/Dockerfile`, and the matching build arg is in `docker-compose.yml`'s `web` service. `docker compose config -q` passes.

Re-verified after the fixes: web typecheck; vitest 27 files and 362 tests (47.3% statements); the no-backend build. On a fresh `el_e2e` stack in CI order: the API scripts, then Playwright `CI=1` 27/27, then `e2e-smoke.mjs`. That Playwright run came before S1's last change, which narrowed the waking state from "anything but 404/400" to "`WakingError`, 5xx or 429". No spec covers the pay page; its vitest does.

## Round 2 (2026-10-03) · Verdict: APPROVED (checks the round-1 fixes only)
Reviewed: `git diff ce22cb8..fix/web-p0` at `63d942d` (`d9caa7c`, `ea31a78`, `42e3963`, plus the plan.md log).

What I ran, without touching the working tree:
- `pnpm -C web typecheck` → passes.
- `pnpm -C web test` → 27 files, 362 tests pass.
- I didn't run `next build` (it would overwrite the `.next` the running stack serves) or Playwright. Impl ran both in CI order: the no-backend build, Playwright 27/27 and the smoke script. `web` has no lint script yet; 11c adds the baseline.

Round-1 findings:
- **S1: resolved.**
  - `retryWhileWaking` retries only a `WakingError`, with the default 10 s delay, for 90 s. A 404 or 400 stays final on the first answer, which is better than my suggestion of dropping `retry: false`.
  - A `WakingError`, a 5xx or a 429 renders `<WakingUp onRetry={refetch} />`. That's the same split as `serverApi`.
  - A 401 keeps the card. `api()` with `auth: false` never refreshes, so it can't loop.
  - The five page tests cover: a final 404, recovery while waking, give-up then Retry, and a 500 and a 429 that aren't shown as dead links.
- **S2: resolved.** Every 429 and every 5xx is `UNAVAILABLE`, and 404/400 stay `NOT_FOUND`. The vitest expects `unavailable` for the limiter's JSON 429. `staticFallback` now throws on it at runtime, so a revalidation keeps the last good page.
- **N1–N3: taken.**
  - A non-JSON 200 from refresh is `waking` and keeps the session.
  - The back-link spec clicks through in a new tab and asserts `/institution`. The `window.history.length > 1` check in `BackButton` is why the tab is needed.
  - `NEXT_PUBLIC_WAKE_URLS` is in the Dockerfile's `ARG`/`ENV` and in the compose build args.

Checked and not findings:
- **Retry on the pay page after the 90 s give-up** reruns the full waking policy, so the button can stay in its checking state for up to another 90 s while the service still sleeps. That's honest, and it ends as soon as the service answers.
- **The pay-request 401 impl found:** I confirmed it in the code. `GrowthController` has a class-level `@UseGuards(RolesGuard)` (`growth.controller.ts:174`). `RolesGuard` throws `UnauthorizedException` whenever there's no user, whatever `@Roles` says. `@Get('pay-requests/:token')` (`:264`) has no exemption, and the page sends `auth: false`. It's pre-existing and API-side, outside this web-only phase. It's with ethio-planner to place. Phase 5's page keeps the card for it, which is correct for a 401.

### Blockers
None.

### Should-fix
None.
