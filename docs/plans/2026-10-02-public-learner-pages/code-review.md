# Code review: Phase 7b, public and learner pages

## Round 1 (2026-10-03) · Verdict: APPROVED (two should-fixes; please fix S1 before the PR, it's three lines)
Reviewed: `feat/public-learner-pages` @ `ba4d5db` (code at `4f90352`), base `origin/main` @ `5f5fe7d`, against `plan.md`, its Progress deviations and the rulings R1–R23. I read the whole API side myself. Two read-only helper reviews covered the web side (lesson player and panels; public pages and forms), and I checked every finding below in the code before keeping it. I ran everything in my own detached worktree (`../ethi0-7b-review`), never in `../ethi0-web`.

Checks run:
- **api:**
  - `pnpm -C api build --force` and `pnpm -C api typecheck --force` → OK, with 0 turbo cache hits;
  - `pnpm -C api test` → 64 suites, 1126 passed, 1 skipped (the `TEST_DATABASE_URL` spec).
- **The real-Postgres resend spec** (`auth.resend-verification.db.spec.ts`), on a scratch database in the local Docker Postgres:
  - 3 runs out of 3 pass;
  - **mutation check:** with `lock: { mode: 'pessimistic_write' }` removed, it fails 2 runs out of 2 with 5 rows instead of 1. So the test really catches the race the lock prevents. The file was restored and the scratch DB dropped.
  - The new CI step runs the same command. It hasn't run in GitHub yet (the branch isn't pushed), so the PR's e2e job is its first real run.
- **web:**
  - `pnpm -C web typecheck` → OK;
  - `pnpm -C web test` → 66 files, 554 passed;
  - `next build` → OK.
- **OG fonts in production** (plan decision 2, round-2 S5):
  - `BUILD_STANDALONE=1 next build` puts the three TTFs in `.next/standalone/src/assets/fonts/`, and the route's `route.js.nft.json` lists them. So the `outputFileTracingIncludes` key matches the hashed route `/courses/[id]/opengraph-image-10l7fm`.
  - The standalone `server.js`, started from its own directory like the Dockerfile's `WORKDIR /app`, served a 1200×630 PNG for a seeded course, with the Ethiopic label ቢዝነስ rendered and no boxes.
- **Not re-run:** Playwright, because the stack is with ethio-impl. I'm relying on the 94/94 at this head. Neither `web` nor `api` has a lint script, so there is no lint gate to run.

### Confirmed (no change needed)
- **Resend verification:**
  - the lookup, then `SELECT … FOR UPDATE` on the user row, the two counts, the insert and the commit, with the publish after the commit;
  - one 200 body for unknown, inactive, verified and capped accounts, and for a failed publish;
  - logs carry `user_id` and the outcome, never the email;
  - `auth-strict` covers the route, and direct calls to the auth service are refused in production by `REQUIRE_INTERNAL_TOKEN`, so the IP limit can't be bypassed.
- **Migrations:**
  - `ADD COLUMN … NOT NULL DEFAULT now()` doesn't rewrite the table (`now()` is stable, so it's evaluated once);
  - the index uses the house `CONCURRENTLY` pattern with `transaction = false`;
  - the entity's `@Index` keeps `db:check` clean;
  - ordering after 6a is pinned by a spec.
- **Notification:** one `verificationEmail` helper for both events.
- **Web:**
  - the lesson-player state order matches decision 4;
  - the `<video>` mounts on `activeId`, before the stream URL arrives;
  - DOM order equals mobile order, and the radiogroup and the disclosures have correct ARIA;
  - the buy box is rendered once and is the page's only `<aside>`;
  - `MobileBuyBar` cleans up its observers and focuses the real `[data-primary-action]`;
  - `hasRealThumbnail` survives malformed URLs;
  - `sort` is allowlisted server-side;
  - `grep -rn "score < 3" web/src` finds nothing.
- **No over-engineering worth flagging.** Every new prop and component has a real caller.

### Blockers
None.

### Should-fix
- **S1. A failed background refetch tears down a loaded lesson player, and the account page** at `learn/[courseId]/page.tsx:214-227` and `account/page.tsx` (`if (isError || !me)`)
  - **Why it happens:** TanStack Query keeps `data` but sets `error`/`isError` when a refetch fails after an earlier success. The app's defaults are `staleTime: 15_000` and React Query's `refetchOnWindowFocus: true`. Non-waking errors get one retry (`query-client.ts:17-20`).
  - **Scenario:**
    - a learner is mid-lesson, switches tabs for more than 15 s, and comes back;
    - the focus refetch of `enrollment-status` or `course` fails twice (a 500, a 429, a mobile network blip);
    - `statusError` or `courseError` is now truthy while `status` and `course` still hold good data;
    - `<WakingUp>` replaces the player, the `<video>` unmounts, and playback stops until Retry. A 404 on the refetch shows "Course not found" over a course that loaded.
    - On the account page, the same thing throws away whatever the user had typed into the profile form.
  - **A regression from this phase:** before 7b the player had no error branch (`if (!course)` skeleton), so a failed refetch left it alone.
  - **Fix:** show these states only when there is no data: `courseError && !course` (both branches), `statusError && !status`, `isError && !me`. Add one vitest where a refetch rejects after a first success and the player stays.

  Response: Fixed in `32b159f`. The not-found and both waking-up branches in the lesson player now apply only without data (`!course && courseError…`, `!status && statusError`), and the account page shows its error only when `!me`. New vitest: a loaded player whose course refetch then 404s and whose status refetch 503s keeps "Start lesson 1", with no "Course not found" and no Retry. It fails on the old code.

- **S2. The certificate poll isn't bounded the way its comment says** at `completion-card.tsx:32-33`
  - **The bound:** `dataUpdateCount` counts *successful* updates of the shared `['certificates']` cache entry (the dashboard uses the same key, `dashboard/page.tsx:38`).
  - **Scenario:** `/me/certificates` keeps failing (an outcomes bug, or errors past the waking retries). `data` stays undefined and the count stays 0, so the tab refetches every 5 s for as long as it's open. The card renders `null` meanwhile, so nobody sees why. In the other direction, a long session's focus refetches can push the count past 24 before completion, and then the card never polls.
  - **Fix:**
    - bound the poll by this card's own clock: a `useRef(Date.now())` at mount, stop after 2 minutes, and also stop when `query.state.status === 'error'`;
    - or, simpler, drop the poll and say "Your certificate is being prepared. It will appear here and on your dashboard shortly." The focus refetch then picks it up.

  Response: Fixed: bounded by the card's own clock (`useRef(Date.now())`, 2 minutes), and it stops when the query is in error. I kept the poll rather than dropping it: without it, a learner who stays on the page would read "shortly" until they switched tabs. New vitests: a failing request stops the poll at once (fails on the old code), and no certificate means polling stops after 2 minutes.

### Nits
- **N1.** `ResendVerification.tsx:36-38` shows the raw error message for anything other than 400 or 429. During the deploy window that's the gateway's 404 text, and later "Internal server error". The plan's Rollout says the web shows "Couldn't send right now. Try again in a minute." Use that line for the other errors (`WakingError`'s own message can stay), or update the Rollout text.
- **N2.** `completion-card.tsx:42`, `:87-88`: "Your certificate is being prepared…" shows while `assessments` or `attempts` are still loading, and permanently if the assessments query fails, even when a required assessment is still unpassed. Render that branch only once both lists have loaded.
- **N3.** `explore-client.tsx:103-104`: with `?page=` past the last page, the line reads "Showing 1189–10 of 10 courses" over an empty grid. Clamp `from` to `to`, or show "No courses on this page".

### Nit responses (planner)
- N1: taken. Any failure other than 400, 429 or `WakingError` shows "Couldn't send right now. Try again in a minute."; vitest added for a 404 and a 500.
- N2: taken. Without a certificate, the card says nothing until both assessments and attempts have loaded; vitest added (attempts never resolve → no copy).
- N3: taken. Past the last page the line reads "No courses on this page"; vitest added.

Checks after the fixes: web typecheck OK, vitest 66 files / 560 passed, `next build` OK. Playwright runs on the PR's CI (the stack is with ethio-impl).

