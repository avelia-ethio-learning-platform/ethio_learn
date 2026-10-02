# Handoff: Phase 5, web P0 fixes and a browser E2E harness

From ethio-planner to ethio-impl (or a second web implementer, if the user adds one)
Plan: [plan.md](plan.md) (approved in round 2, see [plan-review.md](plan-review.md); amendment A1, decision 12 and step 3a, reviewed in round 3)
Code review goes to: ethio-plan-review (size M)

## What to build
This phase fixes what a first visitor or a new customer hits:
- an honest cold-start state instead of false 404s and "invalid certificate" pages;
- a static (ISR) home page;
- the right landing page per role;
- one token refresh instead of a logout race;
- no content under the fixed header;
- no sideways scroll at 375 px;
- an opaque mobile menu;
- copy fixes;
- a `/verify` form.

It also adds a Playwright smoke suite to CI that guards every one of these.

## Read first, in order
1. `plan.md` decisions 1–11, then `plan-review.md`:
   - round 1 B1 explains why `unavailable` is rendered by the page and never thrown to `error.tsx` (Next 14 sanitizes Server Component errors in production), and why prerendered pages go through `staticFallback`;
   - round 2 S4 sets the local build order.
2. `web/src/lib/server-api.ts` and its callers:
   - home `(public)/page.tsx`;
   - `courses/[id]/page.tsx`;
   - `courses/page.tsx`;
   - `educators/page.tsx`;
   - `educators/[id]/page.tsx`;
   - `(verify)/verify/[uid]/page.tsx`;
   - `app/sitemap.ts`.
3. `web/src/lib/api.ts`: `tryRefresh` (`:44-55`), the 401 path (`:76-80`) and the `api()` signature, where `{ slow }` goes.
4. The role landing call sites (`login/page.tsx`, `GoogleSignInButton.tsx`, `accept-invite/page.tsx`) and the guards (`teach/new/page.tsx:120`, `teach/courses/[id]/page.tsx:495`). Phase 3 has changed these files; read the merged versions, including its `safeNext` and `jsonLdScript` helpers in `web/src/lib/`.
5. `components/Header.tsx:72-73,184`, `globals.css:116,121,148-150,396-403`, `app/layout.tsx`, `(public)/home-client.tsx:65,291-305`.
6. `.github/workflows/ci.yml`: the `web` job (builds with no backend) and the `e2e` job's step order.

## Decisions already made (don't relitigate)
- **`serverApi`** returns `{ ok, data } | 404 | 'unavailable'` with an 8 s timeout. 5xx, network errors and timeouts all count as `unavailable`.
- **Dynamic pages** render `<WakingUp />`, with Retry calling `router.refresh()`. `generateMetadata` never throws. `error.tsx` stays generic.
- **Prerendered pages** (home, `/educators`, sitemap) use `staticFallback`:
  - empty data during `next build`;
  - a throw at runtime, so Next keeps the last good page;
  - the home page shows "Browse the catalog" when the build had no data.
- **Redirects:** the legacy `/?q=` filters redirect through `next.config.mjs` `redirects()`.
- **`{ slow: true }` opts out of the 4 s notice:** outline generation, assessment generation, tutor chat send, the study coach and `upload.ts`.
- **Guards:** `/teach/new` allows educators only. The editor allows educators and institution admins. `/institution` gets no "new course" action.
- **(A1) Waking up:** a hibernation 429 (the `x-render-routing: hibernate-rate-limited` header when readable, otherwise a non-JSON 429 body, since the browser can't read the header cross-origin) or a network error counts as `unavailable` / `WakingError`. `tryRefresh` logs out only on 401/403; a hibernation 429, 5xx or network error on refresh keeps auth and throws `WakingError`. `wakeServices()` pings the public `/health` URLs in `NEXT_PUBLIC_WAKE_URLS` from the browser (`no-cors`, once per 60 s). GET queries retry `WakingError` every 10 s for up to 90 s; mutations don't. See plan decision 12.
- **Single-flight refresh:** one module-level promise. Logout happens only when that one refresh fails.
- **Header offset:** `pt-28` moves to the layout's `<main>`, and the home hero drops its own offset.
- **Overflow:** `overflow-x: clip` replaces `hidden`.
- **Mobile menu:** `bg-background` panel plus a backdrop that closes the menu on tap.
- **Playwright:**
  - a setup project with per-role `storageState`, 7 `auth-strict` calls in total (budget comment in the config);
  - `serviceWorkers: 'block'`, `workers: 1` in CI;
  - CI order: API scripts, web build, `next start`, Playwright, then `e2e-smoke.mjs` last.
- **Dependencies:** the only new devDependencies are `@playwright/test` and `@vitest/coverage-v8`.

## Gotchas learned while planning
These Next 14.2.35 behaviors were verified by the reviewer in the installed sources:
- `NEXT_PHASE` reaches the static workers.
- A failed background revalidation keeps the stale entry and retries within 30 s.
- The sitemap stays ISR even if its build-time fetch fails.
- Next drops the `signal` on background re-fetches of stale data-cache entries, so the 8 s timeout doesn't apply there. That is harmless, because a stale page is already being served.

Local workflow:
- **Local build order (S4):** `next build` empties `.next` under the running :3000 server. Run:
  1. `GATEWAY_INTERNAL_URL=http://127.0.0.1:9 pnpm -C web build`, as the check;
  2. a normal build with the stack up;
  3. restart `next start` on :3000 by killing the `next-server` PID, never with a `pkill -f` pattern that matches your own shell;
  4. Playwright.
- **P0-09 spec:** a second `next start` on another port with `GATEWAY_INTERNAL_URL` pointed at a closed port, sharing the same `.next`. It never writes, because its revalidations fail.
- **Installing dependencies:** `web` has its own lockfile. Add the devDependencies with `pnpm -C web add -D … --store-dir /home/kal/snap/code/current/.local/share/pnpm/store/v3`.
- **Playwright browsers:** locally, `pnpm -C web exec playwright install chromium` (skip `--with-deps`, which needs sudo). In CI, add `--with-deps` and cache `~/.cache/ms-playwright` keyed on the locked version.
- **Login state:** add `e2e/.auth/` to `web/.gitignore`.
- **Credentials:** take seeded role credentials from the seed script or env, never pasted into specs or docs. The secret-guard hook scans untracked files for `api/.env` values.
- **Screenshots:** the before screenshots are in `docs/plans/2026-10-02-refinement-audit/screenshots/before/` (git-ignored). Save the after screenshots at 375/768/1440 to `screenshots/after-phase5/` with the same file names, so the planner can pair them.
- **Plan folder:** it is in `.git/info/exclude`. On your branch, remove that line and commit the folder. This phase isn't a security fix, so there's no same-day-deploy constraint.
- **Environment:** the same notes as the earlier handoffs apply:
  - the node PATH export;
  - Postgres on 55432;
  - after an API rebuild, restart the backend with `scripts/stop-backend.sh && scripts/start-backend.sh`.
- **Production is off-limits.** Vercel needs no configuration for this phase.

## How to run
- Web: `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`, plus `pnpm -C web test:coverage`.
- Browser E2E: follow the build order above, then `pnpm -C web exec playwright test` with the stack running and web on :3000.
- API untouched: `pnpm -C api test` stays green.

## Branch
Create `fix/web-p0` from `fix/payment-integrity` (tip `2cdccf9`) now. The user chose not to wait for the merges. The stack is linear: main ← `feat/schema-migrations` (#19) ← `fix/access-control` ← `fix/payment-integrity` ← `fix/web-p0`. Phase 3's web helpers (`safeNext`, `jsonLdScript`) are already on this base.
- Don't push and don't open a PR until #19, Phase 3 and Phase 4 have merged into main. Those merges and their deploys are the user's.
- They merge as merge commits, so their SHAs stay the same. When they land, run `git merge origin/main` into `fix/web-p0` (no rebase). The PR diff then shows only Phase 5.
- If one of them is squashed or rebased instead, run `git rebase --onto origin/main fix/payment-integrity fix/web-p0`.
- Request code review on the stacked branch with base `fix/payment-integrity`.

## Definition of done
- The acceptance criteria are met, including the no-backend build.
- Web typecheck, tests and build pass, and the Playwright suite passes locally. On the PR, the CI `web` and `e2e` jobs pass.
- The after screenshots of every touched page are saved for the planner's before/after report.
- The plan checklist is ticked, with deviations logged.
- Then request code review from ethio-plan-review.
