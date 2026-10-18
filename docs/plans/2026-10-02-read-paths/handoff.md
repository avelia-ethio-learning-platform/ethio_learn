# Handoff: Phase 9e, read paths

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 2, see [plan-review.md](plan-review.md))
Code review goes to: ethio-reviewer (size L)

## What to build
- **Three capped internal batch endpoints:** user summaries by ids, lesson ids by course ids, and progress by learner-course pairs. Plus a `getMany` client helper.
- **The N+1 list sites use them,** so each list makes one internal call per batch endpoint, not one or more per item.
- **A cheaper video heartbeat on top of 6b's version:** a 60 s lesson cache, a one-statement enrollment update, and milestones only on a newly completed lesson. Completion detection still heals.
- **Bounded lists:** comments, DM messages, reviews, payments, refunds, payouts, attempts and threads, with "Load earlier" or "Show more" in the web.
- **Analytics in SQL** with unchanged response shapes.
- **Payee names** on admin payouts, and **educator names** on catalog cards.

## Read first, in order
1. `plan.md` decisions 1–7, the API contract and the Rollout. Then `plan-review.md`:
   - round 1 B1: display reads degrade and decision reads stay strict, and a search page without names isn't cached;
   - S1: messages keep `{ thread, messages }` plus `has_more`; comments' paged shape is opt-in;
   - S2: replies at any depth;
   - S3: detection still runs while `completed_at` is null;
   - S4: payee `by_course` stays complete;
   - S5: there's no per-item fallback, and the 404 window is accepted;
   - S6: pairs are capped at 50;
   - N1–N3: the cache is cleared on `CourseRevisionClosed`, `nudge_level` is reset, and months use UTC;
   - round 2: the self-heal beat makes one internal call, and milestones heal on the next newly completed lesson.
2. The internal client as 6a and 9c left it: `internalPath` and the typed errors.
3. `api/services/enrollment/src/enrollment.service.ts`:
   - `listForLearner` (`:95-114`) and `progressPercent` (`:636-648`);
   - 6b's `saveVideoProgress`, `liveLesson`, `recordCompletion`, `touch` (`:230-234`) and `announceMilestone` (`:237-243`);
   - the `CourseRevisionClosed` consumer (`:73`);
   - `analytics` and `adminAnalytics`.
4. `api/services/financial/src/sponsorship.service.ts` `withProgress` (`:488-505`). Then `payment.service.ts` (`adminList`, `payeeAnalytics`, `adminAnalytics`, the `summarize` at `:710-738`) and `payout.service.ts`.
5. `api/services/notification/src/community.service.ts` (`listComments` `:38-50`, `myThreads` `:137-144`, `threadMessages` `:175-189`). Then `quality.service.ts` (`:608,623-632`), `course.service.ts` (`topEducators` `:1118-1160`, search `:1098-1105`) and `assessment.service.ts` (`:655-760`).
6. **Web:**
   - `components/CommentsSection.tsx` (`buildTree` `:31-41`, `:49`);
   - `(learn)/messages/page.tsx` (`:54`);
   - `public/sw.js` (`:38,78-90`);
   - `teach/analytics/page.tsx:103`;
   - `growth-tabs.tsx:61`;
   - 7b's `CourseCard` and 8a's admin payouts tab.

## Decisions already made (don't relitigate)
- **Batch endpoints:**
  - `internal/users?ids=` takes up to 100 ids and returns names unless `fields=email` is set;
  - `internal/courses/lesson-ids?ids=` takes up to 100;
  - `internal/entitlements/progress?pairs=` takes up to 50 pairs and returns `{ learner_id, course_id, active, progress_percent, lessons_complete }`.
  - `getMany` chunks by the cap and runs at most 4 chunks in parallel, with paths built by `internalPath`.
  - There's no GraphQL and no generic batch route. A fourth `institutions?ids=` endpoint only if institution payees exist (log it in Progress).
- **Errors, by 9c decision 3:**
  - display-only reads degrade with one warn: names, and list progress in `listForLearner` and `withProgress`;
  - decision reads stay strict: `lesson-ids` for completion and milestones, and enrollment analytics.
- **Search names:** a search page without names is returned without `educator_name` and isn't written to the search cache.
- **Heartbeat:**
  - one 60 s, 1,000-entry in-process LRU holds lesson lookups and per-course lesson ids;
  - `CourseRevisionClosed` clears that course's entries, and a failed lookup is never cached;
  - an already-completed lesson skips milestones and runs one `UPDATE … SET last_activity_at = now(), nudge_level = 0`;
  - `detectCompletion` still runs while `completed_at` is null.
- **Comments:**
  - the newest 50 top-level comments, plus every descendant from one `WITH RECURSIVE` query;
  - replies capped at 1,000 rows, oldest first;
  - the response stays flat and oldest first;
  - `{ items, has_more }` only with `paged=1` or `before`; otherwise the same rows as a bare array;
  - the web asks for the paged shape and normalizes both;
  - removing the bare form later is audit P2-43, not this phase.
- **Messages:** the newest 100 with a `(created_at, id)` cursor. The response stays `{ thread, messages }` and adds `has_more`.
- **Analytics:** `date_trunc('month', created_at AT TIME ZONE 'UTC')`. `by_course` stays complete for payees, and only `adminAnalytics` takes the top 8. The old in-memory code survives only as the spec oracle. No materialized views.
- **Rollout:** no per-item fallback path. During the few minutes of the deploy, the 404 window is absorbed by the degrade rule and the heartbeat's self-heal.

## Gotchas learned while planning
- **Messages already return an object** (`community.service.ts:175-189`), on the route `GET /messages/threads/:id`, and the page reads `thread`. Don't replace the shape.
- **The service worker caches `/api/v1/courses/...` GETs** network-first, comments included. `paged=1` is a different cache key, so an old cached array reaches the new client only through the normalizer. Test both shapes in `CommentsSection`.
- **Replies nest to any depth:** every node has a Reply button. `parent_id IN (top-level ids)` would drop replies to replies, and `buildTree` renders an orphan as a top-level thread.
- **Check the comments `(parent_id)` index** for the recursive join, and the comments and reviews `(course_id, created_at)` indexes. Add any missing ones `CONCURRENTLY`, in their own `transaction = false` migration per service (Phase 2 convention, drop-before-build).
- **The pairs cap is about URL length:** each pair encodes to about 75 characters, and Node's default `maxHeaderSize` is 16 KiB for the request line plus headers.
- **`touch` also resets `nudge_level`,** and the column is `last_activity_at`, not `last_active_at`.
- **Oracle fixtures:** SQL sums are exact `numeric`, while the old code chains float `toFixed(2)`. Use whole or half-birr amounts, and set the session time zone to `Africa/Addis_Ababa` for the month-boundary case.
- **A healing beat makes one internal call,** because the failed `lesson-ids` lookup wasn't cached. That's what step 5's self-heal spec expects.
- **Line numbers are at `2cdccf9`.** 6a, 6b, 7b and Phase 8 move these sites, so find each one by its code.
- **This plan folder isn't security-sensitive.** Commit it on your branch, staging paths explicitly. Several plan folders are untracked, so never `git add -A`.
- **Environment:**
  - export the node PATH first: `export PATH="/home/kal/.local/opt/node22/bin:$PATH"`;
  - Postgres is on host port 55432;
  - pnpm installs need `--store-dir /home/kal/snap/code/current/.local/share/pnpm/store/v3`;
  - production is off-limits;
  - e2e and Playwright run on `.env.example` values only, never `api/.env`'s real keys. Never export `api/.env.example` into the shell for `next start` (its `NODE_ENV=development` breaks ISR). Run one Playwright suite at a time.

## How to run
- **API:** `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`.
- **Web:** `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`.
- **Migrations:** apply on a fresh DB and on the dev DB, and `migration:revert` round-trips.
- **E2E:** the CI scripts locally (`demo-seed`, `e2e-revisions`, `e2e-institution`, `e2e-payments`, `e2e-smoke`), then the Playwright suite.
- **Load check (step 9):**
  - seed one bulk order with 80 seats with a local-only script in `scripts/`;
  - time `GET /bulk-purchases/mine`, and "My learning" with 30 enrollments, before and after;
  - record the numbers in Progress.

## Branch
Create `perf/read-paths` from the tip of the stack when it starts (expected `feat/observability`, 9d). Don't push until everything below has merged; then `git merge origin/main`.

## Rollout (the user's)
- **Duplicate checks:** none needed. The only migrations are missing indexes, built `CONCURRENTLY`.
- **PR description:** include the deploy-order note from the plan's Rollout: the few-minute 404 window, display lists without names or progress, and no fallback path.

## Definition of done
- The acceptance criteria are met.
- The load-check numbers are recorded in Progress.
- API and web build, tests and typecheck pass, `db:check` is clean, and migrations apply and revert.
- The CI e2e scripts and Playwright pass locally.
- The checklist is ticked, with deviations logged.
- Then request code review from ethio-reviewer.

## Amendment 2026-10-03 (ethio-planner [aeff2b]): parallel tracks
- Phase 10 (web) and 11a (CI gates) now run in parallel from `origin/main`. **If 11a has merged** when you merge `origin/main`: add your own short section to `docs/DEPLOYMENT.md` (and your env vars to the env examples, if 11a's versions lack them), and keep `pnpm -C api lint` at or under `.github/lint-baseline.json` (fix new warnings rather than raising the baseline).
- The local stack is shared by every track: builds and unit tests run any time; the stack gate only in your window. Ask the current holder and hand it on when done.
