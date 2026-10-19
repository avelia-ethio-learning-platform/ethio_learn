# Phase 9e: Read paths (batched internal reads and bounded lists)

Status: approved (round 2); drift check vs 9a (2026-10-03): line drift only; drift check 2026-10-07 D1–D3 folded in (see Amendments)

## Amendments 2026-10-07 (planner, from the drift check; these override the text below)
- **D1 (heartbeat budget):** drop "≤ 3 database round trips". The heartbeat target is now:
  - no internal call;
  - no milestone or detection work once the course is complete;
  - **one** enrollment write: an `UPDATE` replacing both `touch()` saves;
  - exactly one count query while the course isn't complete;
  - 6b's video-progress read and write left as they are.
  
  The step 5 spec counts internal calls and enrollment writes, not total queries. Rewriting 6b's `apply()` as SQL stays a non-goal.
- **D2 (translated pages):** "Show more reviews" and any educator-name label on `CourseCard` get `t()` keys in both `i18n-en.ts` and `i18n-am.ts` (the parity test). Their `am` drafts go in `docs/i18n/am-review.md`. The course page is a server component, so "Show more reviews" is a small client island, like `CoursePreviewPlayer`.
- **D3 (`/refunds/pending`):** keep it a bare array (oldest first, `take: 100`) with **no `total`**, because 8a's Refunds tab maps it as an array (`admin/page.tsx:337,369`). The tab may show "100+" at 100 rows.
- **Line drift:** see plan-review.md "Drift check 2026-10-07". Re-find each site by its code, not by line number. Note that the payout cron already pages payees, so "batches of 200" applies only to the scheduled-payouts `find`.
- **Base and start (2026-10-07):** an early start in `../ethi0-9e` on branch `perf/read-paths`, from the 9d tip `feat/observability` (`c936e8c`), uncommitted until the day's commit budget allows. It merges the 9c and 9d tips as they move.

Size: L (sessions: 4 — ethio-impl implements, ethio-plan-review reviews the plan, ethio-reviewer reviews the code). Cross-service reads plus a few web list changes.
Base branch: `feat/observability` (9d), or `origin/main` once it has merged. This phase also needs these earlier changes:
- 6a's `internalPath` client and 9c's typed client errors;
- 6b's rewritten video heartbeat (`saveVideoProgress`);
- Phase 8's admin pages;
- 7b's course page.

Feature branch: `perf/read-paths`.
Roadmap: phase 9e, split from 9d (see 9d's header). Findings: P1-22 and P2-04. Also the batched user-name lookup that Phase 8 (payee names) and 7b (educator names on catalog cards) deferred to Phase 9.

## Goal
Pages that list things must cost a fixed number of queries and internal calls, not one or more per item, and must return a bounded page. Today:
- "My learning" makes one internal call per enrollment;
- an institution's bulk-purchase page makes two cross-service hops per seat and times out past about 50 seats (the gateway's 30 s proxy timeout);
- analytics load every confirmed payment into memory;
- a direct-message thread longer than 500 messages hides its newest messages.

Acceptance criteria:
- **Batched internal reads (P1-22).** These make one internal call per batch endpoint for a typical page, and at most ⌈items / cap⌉ in general, instead of one or more per item:
  - `GET /enrollments`;
  - `GET /sponsorships/mine` and `GET /bulk-purchases/mine`;
  - top educators;
  - the admin payment list;
  - the admin payout list;
  - course attempts.

  Each uses a new batch endpoint: user summaries by ids, lesson ids by course ids, progress by learner-course pairs.
- **Video heartbeat (P1-22):** with a lesson already recorded complete, a heartbeat makes no internal call (lesson data and lesson ids come from a 60 s cache) and at most 3 database round trips once the course is complete, 4 while it isn't (the extra one is the completion count). Milestones run only on a newly completed lesson. Completion detection keeps running while the enrollment isn't complete, so a failed check still heals on a later beat, as today.
- **Bounded lists (P2-04):** every list endpoint in decision 5's table returns at most its stated limit and supports paging where a user can reach older items.
  - **DM threads** return the newest 100 messages in chronological order, with "Load earlier". The response stays `{ thread, messages }`, plus `has_more`.
  - **Course comments** return the newest 50 top-level comments with every reply below them at any depth, so the client's reply tree stays whole, with "Load earlier". Old clients keep getting a bare array (bounded the same way) until a later release drops it.
  - **Course reviews** return the newest 20, with "Show more", and the average and count computed in SQL.
- **Analytics in SQL (P2-04):**
  - payee, admin and course analytics aggregate in the database (`GROUP BY`, `date_trunc`) instead of loading rows;
  - response shapes are unchanged, because Phase 8's charts read them.
- **Names where the UI showed ids:**
  - the admin payout list shows payee names;
  - catalog course cards show the educator's name.
- **No regression:** existing specs and e2e scripts pass. A query-count spec per batched endpoint pins the number of internal calls.

## Non-goals
- **Caching layers** (Redis caches for reads) or read replicas. Batching and SQL aggregation are enough at this scale.
- **Infinite scroll or virtualized lists in the web.** "Load earlier" and "Show more" buttons only.
- **Keyset pagination for admin lists.** Phase 8's offset `Pager` stays.
- **Rewriting the heartbeat's anti-cheat rules** (6b owns them). This phase only removes redundant work from 6b's version.
- **Search ranking or course-search performance.** It is already capped and cached.

## Current state
Line numbers at `2cdccf9`. 6a retypes every internal call site, 6b rewrites the heartbeat, Phase 8 changes the admin pages and 7b the course page, so the implementer re-finds each site by its code.

- **Internal endpoints that exist:**
  - **course** (`course/src/internal.controller.ts`): `courses/:id`, `courses/:id/lesson-ids`, `courses/:id/outline`, `lessons/:id`, `owners/:id/published-count`;
  - **auth** (`auth/src/internal.controller.ts`): `users/by-email/:email`, `users/:id`, `users/:id/institution`, `educators/:id`, `institutions/by-owner/:userId`, `institutions/:id`;
  - **enrollment:** `entitlements?learner_id=&course_id=` (`enrollment.controller.ts:114-118`, service `:396-405`), which makes its own nested `lesson-ids` call.
  - **No batch endpoints anywhere.** Every call goes service → public gateway → target.
- **N+1 sites:**
  - **`GET /enrollments`** `listForLearner` (`enrollment.service.ts:95-114`): unpaged; per enrollment, a `courseCache.findOne` plus `progressPercent` (`:636-648`: an internal `lesson-ids` call and a count). 9c makes `progressPercent` return `null` on failure.
  - **Sponsorships** `listBulk` (`sponsorship.service.ts:255-276`, up to 100 orders, a `find` per order) and `mine` (`:333-346`), both through `withProgress` (`:488-505`): one internal `entitlements` call per granted seat, which nests a `lesson-ids` call. Two hops per seat.
  - **`topEducators`** (`course.service.ts:1118-1160`): one `users/:id` call per educator, 12 by default and up to 50. Similar loops at `course.service.ts:802-805`, `payment.service.ts:653-657` (`adminList`, learner info per row) and `assessment.service.ts:672-679` (`courseAttempts`, sequential per learner).
  - **`myAttempts`** (`assessment.service.ts:740-760`): an `assessments.findOne` per attempt, plus an in-memory `courseId` filter after loading everything.
  - **Enrollment `analytics`** (`:307-357`): up to 25 courses, with 2 internal calls and 3 queries each. `nudgeInactiveLearners` (`:279-285`) does a cache lookup per candidate.
  - **Heartbeat `saveVideoProgress`** (`:156-182`; 6b rewrites it):
    - `liveLesson` makes an internal call per beat (`:213-217`; the course service does 3 queries);
    - two `findOne`s and two saves (`touch`, `:230-234`);
    - at 90% or more, `recordCompletion` (`:219-227`) runs on every beat: `announceMilestone` (an internal `lesson-ids` call) plus `detectCompletion` (another `lesson-ids` call, and on completion 3 more internal GETs).
- **Unbounded reads:**
  - **financial:** `payeeAnalytics` (`payment.service.ts:676-682`, summarized in memory, `:710-738`); `adminAnalytics` (`:685-708`); `GET /payments/mine` (`:638-641`); `refunds/mine` and `refunds/pending` (`refund.service.ts:131-138`); payouts `listForPayee` (`payout.service.ts:206-208`; `listAll` takes 200); `balance` (`:217`, loads all unpaid confirmed payments); the payout cron (`:93`).
  - **enrollment:** `adminAnalytics` (`:362-377`, the whole table); `analytics` (`:316`).
  - **quality:** `listReviews` (`quality.service.ts:623-632`, all rows, average in memory); `addReview` reloads them all (`:608`).
  - **notification:**
    - `listComments` (`community.service.ts:38-50`, the whole thread, ascending);
    - `threadMessages` (`:175-177`, `take: 500` ascending, so the newest are hidden after 500);
    - `myThreads` (`:137-144`).
  - **outcomes:** `courseAttempts` (`:655-700`); `myAttempts` (`:740-760`).
- **Web consumers of the changed lists:**
  - the course page reviews (7b);
  - `components/CommentsSection.tsx`;
  - `(learn)/messages/page.tsx`;
  - the editor's and the institution's review lists (8b);
  - the admin payouts tab (8a);
  - `CourseCard` (7b).

## Design and key decisions
1. **Three batch endpoints, capped:**
   - **auth `GET /api/v1/internal/users?ids=a,b,…`** (≤ 100 UUIDs, validated): `[{ id, name, role }]`. Email only with `&fields=email`, so the default carries no personal data beyond the name.
   - **course `GET /api/v1/internal/courses/lesson-ids?ids=…`** (≤ 100): `{ [course_id]: string[] }`, from one query.
   - **enrollment `GET /api/v1/internal/entitlements/progress?pairs=learner:course,…`** (≤ 50 pairs): `[{ learner_id, course_id, active, progress_percent, lessons_complete }]`, the fields today's single entitlement read gives `withProgress`. One enrollments query and one grouped `lesson_progress` count, plus one batched `lesson-ids` call; if that call fails, `progress_percent` is `null` as in 9c's single endpoint. The cap is 50, not 200: each pair encodes to about 75 characters, so 200 pairs make a URL of about 15 KB, past Node's 16 KiB header budget once headers are added (review S6). 50 pairs are about 3.8 KB, in line with 100 UUIDs.
   - **The client:** a `getMany` helper in the internal client chunks ids by the cap and runs chunks in parallel, at most 4 at a time. It builds paths with 6a's `internalPath`, which encodes each value.
   - **Errors:** a missing id is simply absent from the result, and callers render a fallback name ("Unknown user") as today. `getMany` throws 9c's typed errors; what a failure means is the caller's call, by 9c decision 3's rule (review B1):
     - **display-only reads degrade:** names (catalog `educator_name`, `topEducators`, admin `payee_name`, learner names in `adminList` and `courseAttempts`) and list progress (`listForLearner`, `withProgress`). They catch the error, log one warn, and return the items without names or with `progress: null`, as `topEducators` and `withProgress` do today. A sleeping auth service never turns the catalog into a waking page;
     - **reads that decide something stay strict:** `lesson-ids` for completion detection and milestones, and enrollment analytics. They propagate the typed error (a 503), never a default.
   - Rejected: GraphQL or a generic "batch any endpoint" route. Three specific endpoints are smaller and easier to authorize.
2. **The N+1 sites use them:**
   - **`listForLearner`:** one `courseCache` `In()` query, one `lesson-ids` batch call and one grouped progress count. Capped at 200 enrollments (decision 5).
   - **`withProgress`:** one `entitlements/progress` batch call per list.
   - **`topEducators`, `adminList`, `courseAttempts` and `course.service.ts:802-805`:** one `users` batch call each.
   - **`myAttempts`:** `assessments` loaded with one `In()`; the course filter goes into the `WHERE` clause.
   - **Enrollment `analytics`:** one `lesson-ids` batch call and grouped SQL for all its courses.
   - **`nudgeInactiveLearners`:** one `courseCache` `In()`.
3. **Names the UI couldn't show:**
   - **Admin payouts:** `GET /payouts` (the admin listing) adds `payee_name` from one `users` batch call, or the institution name through a batched `institutions?ids=` read. The implementer adds that fourth batch endpoint on auth only if institution payees exist in the data model, and logs it in Progress. The admin payouts tab (8a) shows the name with the short id as secondary text.
   - **Catalog cards:**
     - the course search response adds `educator_name`, from one `users` batch call per page, cached with the search cache. If the names call fails, the page is returned without `educator_name` (the card shows no name, as today) and is not written to the search cache, so the next request tries again;
     - `CourseCard` shows it (7b deferred this);
     - institution courses show the institution name if the search row has one, otherwise the educator's name.
4. **Heartbeat on top of 6b:**
   - **Lesson lookup cache:** `liveLesson` results (course id, duration, has-video, published state) and each course's lesson ids are cached in-process for 60 s, in one 1,000-entry LRU, so repeated beats don't call the course service. A lesson's video and duration can change: 6b's approved revision replaces them (6b decision 1). So enrollment's existing `CourseRevisionClosed` consumer (`enrollment.service.ts:73`) clears that course's entries, and the TTL bounds anything missed (one instance gets each event). A failed lookup is never cached. 6b's rule that completion needs the real duration still holds.
   - **Already-completed lesson:** when a `lesson_progress` row already exists for the lesson, the beat skips milestones. It saves the video progress row and updates the enrollment in one statement, `UPDATE … SET last_activity_at = now(), nudge_level = 0`, which is what `touch` does today (`:230-234`) without re-saving the whole row (review N2).
   - **Completion detection still runs while the enrollment isn't complete** (review S3). Today a failed `lesson-ids` call as the last lesson completes is healed by the next beat past 90%, which re-runs detection. So the beat still runs `detectCompletion` while `completed_at` is null, using the cached lesson ids: one count query and no internal call. Once the course is complete it stops.
   - **Milestones** run only when a lesson is newly completed, and share the cached `lesson-ids` with detection: one internal call at most, not two.
   - The implementer applies this to 6b's version, keeping its anti-cheat behaviour and tests green, and adds a query-count spec.
5. **Bounded lists:**

   | Endpoint | Change | Limit |
   |---|---|---|
   | `GET /enrollments` (learner) | cap; newest first | 200 |
   | `GET /payments/mine` | `PageQuery` (9c), newest first | 20 default, 100 max |
   | `GET /refunds/mine` | `take` | 100 |
   | `GET /refunds/pending` (admin) | `take`, oldest first, plus `total` | 100 |
   | `GET /payouts?payee_id` and own payouts | `PageQuery` | 20 / 100 |
   | `GET /payouts/balance` | SQL `SUM`/`COUNT` instead of loading rows | n/a |
   | payout cron (`payout.service.ts:93`) | process scheduled payouts in batches of 200 until none remain | 200 per batch |
   | `GET /courses/:id/reviews` | newest first plus `page`; average and count via SQL; adds `has_more` | 20 |
   | `addReview` aggregate | SQL `AVG`/`COUNT` | n/a |
   | `GET /courses/:id/comments` | the newest 50 top-level comments plus every reply below them at any depth (one `WITH RECURSIVE` query from the 50 ids), flat and oldest first as today, so the client's tree still builds. With `paged=1` or `before` (a cursor on the top-level `(created_at, id)`), the response is `{ items, has_more }`; without either it stays a bare array of the same rows, for open pages and service-worker-cached clients | 50 threads; replies capped at 1,000 rows |
   | `GET /messages/threads/:id` | `ORDER BY created_at DESC, id DESC LIMIT 100`, reversed in code; `before` cursor on `(created_at, id)`; the response stays `{ thread, messages }` and adds `has_more` | 100 |
   | `GET /threads` (mine) | ordered by last message | 50 |
   | `courseAttempts` (educator) | `PageQuery` | 50 / 200 |
   | `myAttempts` | filter in SQL | 200 |

   - **Response shapes** stay as they are, plus `has_more` (and `total` where noted), so web and API can deploy in either order (review S1). Messages already return an object, so `has_more` is additive. Comments are a bare array today: the paged object shape is opt-in (`paged=1` or `before`), the new web asks for it and normalizes both shapes (`Array.isArray(d) ? { items: d, has_more: false } : d`), which also covers a service-worker-cached array. Dropping the bare form is a later clean-up, logged in the audit as a P2 follow-up.
   - **Comment replies at any depth** (review S2): every node has a Reply button and the API accepts any comment on the course as a parent, so "all their replies" means all descendants. The replies are capped at 1,000 rows, oldest first. A reply is always newer than its parent, so an oldest-first cut never leaves a reply without its parent in the set; hitting the cap logs a warn.
   - **Indexes:** `dm_messages (thread_id, created_at)` already exists from Phase 2's P2-14 work. The implementer confirms indexes for comments `(course_id, created_at)` and `(parent_id)` (the recursive join), and reviews `(course_id, created_at)`, and adds any that are missing in one `CONCURRENTLY` migration per service.
6. **Analytics in SQL, same shape:**
   - **financial:** `payeeAnalytics` and `adminAnalytics` compute totals, `by_month` (12 months, `date_trunc('month', created_at AT TIME ZONE 'UTC')`, so buckets match today's ISO months whatever the connection's time zone), `by_purpose` and `by_course` with `GROUP BY` queries over confirmed payments.
     - `by_course` stays complete for `payeeAnalytics`: the educator's analytics table looks each of their courses up in it (`teach/analytics/page.tsx:103`), and it's bounded by the payee's own course count. Only `adminAnalytics` takes the top 8, which is what its UI shows (`growth-tabs.tsx:61`) (review S4).
   - **enrollment:** `adminAnalytics` and `analytics` do the same.
   - **Spec:** each new SQL path produces the same JSON as the old in-memory path on a fixed fixture. The old code is kept in the spec only, as the oracle. SQL sums are exact `numeric` and the old code chains float `toFixed(2)`, so fixture amounts are whole birr or exact halves, which can't differ by a cent; one fixture row sits just before midnight UTC at a month end.
   - Rejected: materialized views. They are unnecessary at this volume and add refresh jobs.
7. **Web changes (small):**
   - the course page reviews gain a "Show more reviews" button when `has_more`;
   - `CommentsSection` (requesting `paged=1` and normalizing both shapes) and the messages page gain a "Load earlier" button that fetches with `before` and prepends;
   - the admin payouts tab shows payee names;
   - `CourseCard` shows the educator name.

   Each change gets a vitest. Labels use 7a's primitives, and new strings get `t()` keys where the page already translates.

## API contract
| Endpoint | Auth | Request | Response |
|---|---|---|---|
| `GET /api/v1/internal/users` (new) | internal | `ids` (≤100 UUIDs), `fields?=email` | 200 `[{ id, name, role, email? }]`; 400 on bad ids |
| `GET /api/v1/internal/courses/lesson-ids` (new) | internal | `ids` (≤100) | 200 `{ [course_id]: string[] }` |
| `GET /api/v1/internal/entitlements/progress` (new) | internal | `pairs` (≤50 `learner:course`) | 200 `[{ learner_id, course_id, active, progress_percent \| null, lessons_complete }]` |
| `GET /courses/:id/reviews` (changed) | public | `page?` | as today plus `has_more`; `reviews` is the newest 20 |
| `GET /courses/:id/comments` (changed) | as today | `paged?=1`, `before?` (top-level cursor) | with `paged` or `before`: `{ items: [...flat, oldest first, as today], has_more }`; otherwise the same rows as a bare array. Newest 50 threads, every reply at any depth |
| `GET /messages/threads/:id` (changed) | as today | `before?`, `limit?` ≤100 | `{ thread, messages: [...oldest first], has_more }` with the newest 100 |
| `GET /payouts`, `/payments/mine`, attempts (changed) | as today | `page`, `limit` | as today, bounded; admin payouts add `payee_name` |
| Course search (changed) | public | as today | each item adds `educator_name` when the names lookup succeeds |

## Steps
- [ ] 1. Branch `perf/read-paths` from `feat/observability`.
- [x] 2. Batch endpoints (decision 1) and the client `getMany`. · Specs: validation and caps (101 ids and 51 pairs → 400); missing ids absent; one query each; chunking at the cap (120 pairs → 3 calls).
- [x] 3. N+1 sites (decision 2). · Query-count specs with the internal client mocked: `listForLearner` with 30 enrollments makes 1 `lesson-ids` call; `withProgress` with 60 seats makes 2 progress calls; `topEducators` makes 1 users call; and so on. Degrade specs: `topEducators` and `withProgress` with the batch call throwing a 503 return 200 with names absent and `progress: null`.
- [x] 4. Names (decision 3): admin payout `payee_name`, search `educator_name`. Web: the admin payouts tab and `CourseCard`. · Spec: search with auth down → 200 with items and no `educator_name`, and the page isn't cached (the next search calls auth again).
- [x] 5. Heartbeat (decision 4) on 6b's code. · Specs:
  - a beat on an already-completed lesson in a completed course → no internal call, at most 3 queries, and `nudge_level` reset to 0;
  - the same in a course that isn't complete → no internal call (cached lesson ids), one more count query;
  - self-heal: the `lesson-ids` call fails as the last lesson completes (the beat errors), and the next beat on that lesson completes the course, making one internal call (a failed lookup isn't cached);
  - `CourseRevisionClosed` clears the course's cache entries;
  - a beat that completes a lesson → at most one `lesson-ids` call;
  - 6b's anti-cheat specs stay green.
- [x] 6. Bounded lists (decision 5), plus any missing indexes. · Specs per endpoint: limit honoured; cursor returns the previous page; `has_more` is correct at the boundary.
  - `threadMessages` with 150 messages returns `{ thread, messages, has_more: true }` with the newest 100 in order, and `before` returns the oldest 50. Two messages with the same `created_at` at the page edge both appear exactly once across the two pages.
  - `listComments` with 60 threads returns the newest 50. A reply to a reply in the page is included, and nothing outside the page is. Without `paged`/`before` the same rows come back as a bare array.
- [x] 7. Analytics in SQL (decision 6). · Oracle specs: same JSON as the old in-memory computation on fixtures, including months with no data, a row just before a UTC month end with the connection's time zone set to `Africa/Addis_Ababa`, the admin top-8 cut, and a payee with 12 courses getting all 12.
- [x] 8. Web (decision 7) and its vitests: Show more reviews; Load earlier comments and messages; `CommentsSection` rendering both a bare array and the paged object; payee names; educator names on cards, and a card without a name.
- [ ] 9. Load check on the local stack: seed one bulk order with 80 seats (a script in `scripts/`, local only) and time `GET /bulk-purchases/mine` before and after. Expected: from tens of seconds to well under 2 s. Do the same for "My learning" with 30 enrollments. Record the numbers in Progress.
- [ ] 10. Full gate:
  - `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`;
  - `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`;
  - the CI e2e scripts and the Playwright suite locally.
- [ ] 11. Code review by ethio-reviewer; the user approves push and PR.

## Test plan
- **API unit:** batch endpoints (step 2); query-count specs (steps 3 and 5); bounded-list and cursor specs (step 6); analytics oracle specs (step 7).
- **Web vitest:** the four UI changes (step 8).
- **Local measurements:** bulk seats and My learning (step 9).
- **Regression:** all api specs, CI e2e scripts and Playwright, including Phase 8's analytics charts reading the unchanged shapes.

## Rollout and ops
- **Deploy order** (review S5): every merge redeploys all eight services at once (`render.yaml`, `branch: main`), and web on Vercel independently. For the few minutes until auth, course and enrollment are live, a batch call gets Nest's 404 for an unknown route (9c's `PeerNotFoundError`), not a 503:
  - display-only callers degrade on any typed error, that one included (decision 1): lists show no names and `progress: null` for those minutes;
  - the heartbeat's strict `lesson-ids` call fails and the web retries the beat; completion detection reruns on later beats (decision 4), so nothing is lost;
  - web and API work in either order: comments keep the bare array for clients that don't ask for the paged shape, and the other changes are additive.

  No per-item fallback path is kept. This goes in the PR description.
- **Migrations:** only missing indexes, built `CONCURRENTLY`.
- **Watching:** 9d's access log shows response times. Compare `/api/v1/bulk-purchases/mine` and `/api/v1/enrollments` before and after.

## Risks and open questions
- **List shape changes** (comments, messages, reviews) touch web pages from 7b and 8b. All are additive except comments' opt-in paged shape. The cursor pattern is applied once and the same way to all three, and each consumer gets a vitest.
- **The heartbeat cache** could serve a lesson's old state for up to 60 s after an approved revision changes its video, on an instance that didn't get the `CourseRevisionClosed` event. The worst case is one beat judged against the old duration, which 6b's next beat corrects.
- **A comment thread with more than 1,000 replies** shows only its oldest 1,000. That's a safety bound, far above today's data.
- **The analytics oracle specs** only prove equality on fixtures. A month boundary in a different time zone is the likely difference, so the SQL truncates `created_at AT TIME ZONE 'UTC'`, matching the in-memory ISO months, and a spec pins it with an Addis session time zone.

## Progress and deviations (implementer)

## Progress (2026-10-19, branch `fix/read-paths`)
- Steps 2–8 done; step 9 not run (needs the local stack); step 10: api build/jest/lint and web vitest/tsc/build local, `db:check` and e2e in CI.
- Deviations (drift.md A1–A8 applied):
  - Enrollment analytics are strict: course down → 503; a course course no longer knows is skipped. Per-course `courses/:id` reads stay, now parallel.
  - `courseAttempts` names fall back to "Unknown learner" in both places, and it answers `{ items, total }` (13b review S1; 13b's exam-results panel switches after both merge).
  - Admin `listAll` payouts keep `take: 200` and add names; the `payee_id` admin listing is paged.
  - A7: institution payees get `payee_name: null` (P2 follow-up: an institutions batch endpoint).
  - `getMany` is a helper that takes the client, not a client method (mocks with only `get` keep working).
  - Course cards reuse the existing `course_by` key; new keys are `show_more_reviews` and `loading_more`.
  - Lint gate: 5 findings above the baseline come from 9c lines (`page-query.spec.ts`, `chapa.provider*.ts`, `db-error.filter.ts`) already fixed on `fix/calls-and-jobs`; they clear when 9c merges.

