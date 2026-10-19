# Plan review: Phase 9e, read paths

## Round 1 (2026-10-03) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)"), against the code at `2cdccf9`. I also read the 6a, 6b, 9b and 9c plans where 9e builds on them.

Verified as the plan states:
- **Gateway routing:** the gateway already routes the three new internal paths: `internal/users` to auth, `internal/courses/…` to course and `internal/entitlements/…` to enrollment (`gateway/src/routes.ts:35,39,41`).
- **Names:** `users?ids=` returns names only unless `fields=email` is set. Educator names are already public on `/educators/:id`, so showing them on catalog cards exposes nothing new.
- **Reviews:** today's response is `{ course_id, average_rating, review_count, reviews }` (`quality.service.ts:623-632`), so adding `has_more` is additive.

### Answers to the planner's questions
1. **The `{ items, has_more }` shape change (decision 5):** see S1.
   - **Comments:** the only consumer is `CommentsSection.tsx:49`. It reads a bare array (`buildTree(rows)`, `rows?.filter`) and refetches every 15 s.
   - **The service worker:** it caches `/api/v1/courses/...` GETs, comments included, network-first with a cache fallback (`web/public/sw.js:38,78-90`).
   - **Messages:** the plan's current state is wrong. The route is `GET /messages/threads/:id` (`community.controller.ts:76-81`), and it already returns an object, `{ thread, messages }` (`community.service.ts:175-189`). The messages page reads both fields (`messages/page.tsx:54`).
   - **Other consumers:** no e2e script and no Playwright plan uses either endpoint.
2. **The heartbeat cache (decision 4):**
   - Its memory bound (a 1,000-entry LRU) and the per-instance scope are fine.
   - The premise "a lesson's duration is fixed once it has a video" is false (N1).
   - Skipping `recordCompletion` removes today's only automatic retry for a failed course-completion check (S3).
3. **The deploy-order note (Rollout):** both of its premises are wrong (S5).
   - A missing route gives a 404, not a 503.
   - The user can't deploy three services first, because Render deploys all eight on every merge.

### Blockers
- **B1. Optional names would turn the public catalog into a "waking up" page whenever auth sleeps** at decision 1 ("A batch failure follows 9c's typed errors: a 503 to the caller, never a silent default") and decision 3 (course search `educator_name`)
  - **Today:** course search reads only the course DB (`course.service.ts:1098-1105`). `topEducators` already falls back to "Educator" when a lookup fails (`:1141-1147`).
  - **With the plan:** every search cache miss and the top-educators list call auth, and a failure becomes 503 `service_waking`.
  - **Why it's common:** anonymous browsing keeps course awake, but nothing keeps auth awake once nobody has logged in or refreshed for 15 minutes. In that state every new catalog query shows Phase 5's waking screen for 30–60 s, and SSR or crawler requests get the "unavailable" page.
  - This contradicts 9c's own rule that hidden optional data errs to a safe default (9c decision 3).

  Suggested:
  - name lookups for display (catalog `educator_name`, `topEducators`, admin `payee_name`) catch the batch error and return the items without names, with a warn log;
  - don't put a page without names into the search cache, or cache it only briefly;
  - keep the strict 503 for batch reads that decide something (`entitlements/progress`, `lesson-ids`);
  - add a spec: search with auth down → 200 with items and no `educator_name`.

  Response: **fixed** (your suggestion). Decision 1 now splits callers by 9c decision 3's rule:
  - display-only reads degrade: names (catalog, `topEducators`, payee, learner names) and list progress. They catch the typed error, log one warn, and return items without names or with `progress: null`, as `topEducators` and `withProgress` do today;
  - reads that decide something stay strict: `lesson-ids` for completion and milestones, and enrollment analytics.

  Search without names isn't written to the search cache, so the next request retries. Step 4 adds the "auth down → 200, no `educator_name`, not cached" spec, and step 3 adds degrade specs for `topEducators` and `withProgress`.

### Should-fix
- **S1. The list shape changes break open pages, cached responses and the messages page** at decision 5 and the API contract (comments, messages)
  - **Comments:** Render (notification) and Vercel (web) deploy independently. Once notification serves `{ items, has_more }`, every course page already open in a browser refetches within 15 s and calls `.filter` on an object, so the comments section crashes. The service worker's offline fallback can also serve an old array to the new client.
  - **Messages:** as written, the contract replaces `{ thread, messages }` and drops `thread`, which the page uses.

  Suggested:
  - **Messages:** keep `{ thread, messages }` and add `has_more`. It's additive and compatible in both deploy orders. Use a `(created_at, id)` cursor, as for comments, so a tie at a page edge doesn't drop a message.
  - **Comments:** return the new shape only when the client asks for it (`?paged=1` or `before`), and keep the bare array, bounded to the newest 50 threads, otherwise. The new web normalizes both shapes (`Array.isArray(d) ? { items: d, has_more: false } : d`), which also covers the service worker cache. Drop the bare form in a later phase.

  Response: **fixed.**
  - **Messages:** the route is now named correctly (`GET /messages/threads/:id`). It keeps `{ thread, messages }` and adds `has_more`, with a `(created_at, id)` cursor. Step 6 has a tie-at-the-edge case.
  - **Comments:** the paged object is opt-in (`paged=1` or `before`). Without either, the endpoint returns the same bounded rows as a bare array. The new `CommentsSection` asks for the paged shape and normalizes both, which covers the service-worker cache too.
  - Dropping the bare form is logged as a P2 follow-up in the audit. Decision 5 now says web and API deploy in either order, and the Rollout says the same.
- **S2. "All their replies" must mean all descendants, not direct children** at decision 5 (comments) and step 6's spec
  - **Why:** replies nest to any depth. Every node has a Reply button (`CommentsSection.tsx:158,195-197`), and the API accepts any comment on the course as a parent (`community.service.ts:76-80`).
  - **What breaks:** the natural query, `parent_id IN (<top-level ids>)`, drops replies to replies, so they vanish from the course page. Any reply whose parent isn't in the page is rendered as a top-level thread (`buildTree`, `:31-41`).

  Suggested:
  - fetch the page's subtrees with a `WITH RECURSIVE` query from the 50 top-level ids, or add a `root_id` column (with a backfill);
  - change the spec to "a reply to a reply in the page is included, and nothing outside the page is".

  Response: **fixed.** One `WITH RECURSIVE` query from the 50 top-level ids returns every descendant at any depth, with a `(parent_id)` index confirmed or added. I also capped replies at 1,000 rows, oldest first, as a safety bound. A reply is always newer than its parent, so an oldest-first cut never orphans one. Step 6's spec is now yours: a reply to a reply in the page is included, and nothing outside the page is.
- **S3. Skipping `recordCompletion` on beats for completed lessons removes the self-heal for a failed completion check** at decision 4 ("No completion re-run")
  - **Today:** `recordCompletion` saves the progress row first and then runs `detectCompletion` (`enrollment.service.ts:219-227`). Its `lesson-ids` call isn't in the try/catch (`:587-589`; 9b leaves that as is).
  - **What breaks:** if that call fails once (a 9c 503 or a timeout) as the last lesson completes, the lesson is recorded but the course isn't. The web's retried beat now finds the progress row and skips detection, and so does every beat after it. With every lesson complete, no "newly completed" lesson ever comes again: no completion and no certificate, unless a revision removes a lesson.
  - **Today's backstop:** every beat at 90% or more re-runs detection.

  Suggested:
  - when the lesson is already complete, skip milestones, but still run `detectCompletion` while the enrollment's `completed_at` is null;
  - cache lesson ids per course for 60 s in the same LRU, so that beat makes no internal call and adds one count query;
  - adjust the "at most 3 round trips" acceptance to allow it.

  Response: **fixed** (your suggestion). On an already-completed lesson the beat skips milestones but still runs `detectCompletion` while `completed_at` is null. Course lesson ids share the 60 s LRU, so that adds one count query and no internal call. The acceptance is now ≤ 3 round trips once the course is complete and ≤ 4 while it isn't. Step 5 adds the self-heal spec: the `lesson-ids` call fails as the last lesson completes, and the next beat completes the course.
- **S4. "`by_course` (top N)" truncates the educator's per-course revenue table** at decision 6
  - **Today:** `summarize` returns every course (`payment.service.ts:736`). The educator analytics table looks each of its courses up in it (`teach/analytics/page.tsx:103`).
  - **What breaks:** with a top-N cut, an educator with more than N courses sees no revenue for the rest. The shape is unchanged, but the content isn't.

  Suggested: keep `by_course` complete for `payeeAnalytics`, which is bounded by the payee's own course count. Apply `LIMIT` only to `adminAnalytics`, whose UI shows 8 (`growth-tabs.tsx:61`).

  Response: **fixed.** `by_course` stays complete for `payeeAnalytics`. Only `adminAnalytics` takes the top 8 its UI shows. Step 7 adds a payee with 12 courses getting all 12.
- **S5. The new batch routes 404, not 503, until their service deploys, and all eight services deploy together** at Rollout
  - **The 404:** a caller running before its peer has the route gets Nest's 404 for an unknown path. 9c maps a peer 404 to `PeerNotFoundError`, a 404 to the browser. "My learning" and the bulk-purchase page would then show not-found or empty states, not Phase 5's wake-and-retry.
  - **The deploy order:** `render.yaml` gives every service `branch: main` with no build filter or auto-deploy setting, so every merge redeploys all eight at once. "Trigger those three first" isn't possible after merging.

  Suggested: for this one release, `getMany` treats a route-level 404 from the batch endpoint as "not supported yet" and falls back to the per-item path. Or ship the three endpoints in an earlier merge and the callers in a later one. Correct the Rollout text either way.

  Response: **fixed** (corrected the Rollout; no fallback path). Every merge redeploys all eight services, so the window is a few minutes, and the route gives a 404 (`PeerNotFoundError`). With B1's rule, every display caller degrades on any typed error, 404 included: no names, `progress: null` for those minutes. The heartbeat's strict `lesson-ids` call fails, and S3's re-run completes the course on a later beat. Keeping a per-item fallback for one release would mean two code paths and a second clean-up; splitting into two merges would mean an extra PR for the user. Neither buys more than those few minutes of names and progress.
- **S6. A 200-pair batch makes a URL of about 15 KB** at decision 1 (`entitlements/progress`, ≤ 200 pairs)
  - **The arithmetic:** 6a's `internalPath` encodes each array item and joins them with commas. Each pair is `uuid%3Auuid`, 75 characters, so 200 pairs come to about 15.2 KB, plus the path.
  - **Why that's too big:**
    - Node's default `maxHeaderSize` (16 KiB) counts the request line plus every header, and `api/` doesn't raise it. That leaves about 1 KB for headers at both the gateway and the target.
    - Common reverse proxies cap the request line at 8 KB, and Render's edge limit isn't documented.
  - **What breaks:** an institution with about 200 granted seats would get a 431 or 414 on the very page this phase fixes.

  Suggested: cap pairs at 50 (about 3.8 KB, in line with the 100-UUID users cap at about 3.7 KB). `getMany` chunks anyway, so 200 seats still take 4 calls. Or add a POST read to the client.

  Response: **fixed.** Pairs are capped at 50 (about 3.8 KB). `getMany` chunks, so 200 seats take 4 parallel calls. The acceptance now says "one call for a typical page, at most ⌈items / cap⌉", and step 2 specs 51 pairs → 400 and 120 pairs → 3 calls. I also added `lessons_complete` to the response, since `withProgress` reads it today.

  Nits: N1 taken (the premise is corrected; `CourseRevisionClosed` clears the course's entries; a failed lookup isn't cached). N2 taken (`last_activity_at = now(), nudge_level = 0` in one statement; the step 5 spec checks the reset). N3 taken (`date_trunc('month', created_at AT TIME ZONE 'UTC')`, a spec with an Addis session time zone, and fixture amounts that can't differ by a cent).

### Nits (optional, max 3)
- **N1.** The cache's premise is false. 6b mirrors `video_duration_seconds` in `LessonPending`, so an approved revision replaces a live lesson's video and its duration (6b decision 1). For up to 60 s the cache then serves the old `required`. Enrollment already consumes `CourseRevisionClosed` (`enrollment.service.ts:73`), so clear that course's entries there. The TTL bounds anything that's missed (one queue per service, so one instance gets the event).
- **N2.** `touch` also resets `nudge_level` (`enrollment.service.ts:230-234`), and the column is `last_activity_at`. The one-statement update must reset both. Otherwise a nudged learner who comes back keeps `nudge_level = 1`, and their next idle spell skips straight to the email.
- **N3.** On a `timestamptz`, `date_trunc('month', …)` uses the session time zone. Write `date_trunc('month', created_at AT TIME ZONE 'UTC')`, so the buckets match today's ISO months (`payment.service.ts:713-724`, `enrollment.service.ts:379-392`) whatever the connection's time zone (Addis is UTC+3). The SQL sums are exact `numeric`, while the old code chains float `toFixed(2)`, so the oracle fixtures should use amounts that can't differ by a cent.

## Round 2 (2026-10-03) · Verdict: APPROVED (checks the round-1 fixes only)
Reviewed: `plan.md` (status "in review (round 2)").

- **B1 resolved.**
  - **Degrade or strict:** decision 1 splits callers by 9c decision 3's rule. Display-only reads (names, list progress) degrade with one warn. Reads that decide something (`lesson-ids` for completion and milestones, enrollment analytics) stay strict.
  - **Search cache:** a names-less search page isn't written to the cache.
  - **Specs:** step 4 has the "auth down → 200, no `educator_name`, not cached" spec, and step 3 has the degrade specs.
- **S1 resolved.**
  - **Messages:** keep `{ thread, messages }` and add `has_more`, with a `(created_at, id)` cursor and a tie-at-the-edge spec.
  - **Comments:** the paged shape is opt-in, and the new web normalizes both shapes. Its `paged=1` URL is also a different service-worker cache key, so an old cached array only reaches the new client through the normalizer.
- **S2 resolved.** One `WITH RECURSIVE` from the 50 top-level ids, with a spec for a reply to a reply. The oldest-first 1,000-row cut keeps every included reply's parent: a parent is older than its reply, so it falls inside the cut too.
- **S3 resolved.** Detection keeps running while `completed_at` is null, and the self-heal spec is in step 5.
  - **Lesson ids after a failure:** a failed lookup isn't cached, so the healing beat makes one internal call. That's what the spec should expect.
  - **Milestones:** they still heal too. `announceMilestone` sends every threshold that is due and not yet sent (`enrollment.service.ts:237-243`), so a milestone missed on a failed beat goes out with the next newly completed lesson.
- **S4 resolved.** Payee `by_course` stays complete, with a 12-course spec, and only the admin view is cut to the top 8.
- **S5 accepted** (reasoned disagreement, not a blocker). The Rollout now states the 404 window correctly. Display callers degrade on any typed error, and the heartbeat heals through S3. During those minutes, enrollment analytics (strict) shows the educator an error until the deploy finishes. That's the only visible cost, and it's acceptable.
- **S6 resolved.** Pairs are capped at 50, with chunking specs.
- **N1–N3:** taken as suggested.

No new findings.

## Drift check vs 9a (2026-10-03)
Not a review round: the plan stays APPROVED. This is a read-only check against 9a as built (`fix/event-delivery` @ `fa06f83`, with its deviations). 9e barely touches 9a's code: only the enrollment `CourseRevisionClosed` consumer (the heartbeat cache clear) and the quality and course files 9a rewrote around.

### Mismatches
None.

### Confirmed, plus line drift to re-find by code
- **The heartbeat cache clear (decision 4)** extends enrollment's existing `CourseRevisionClosed` handler. It's now at `enrollment.service.ts:91`, not `:73`, because of 6b; 9a doesn't change enrollment. Under 9a a failed handler retries the whole message, and clearing a cache entry is idempotent.
  - If 9e adds a separate `subscribe` instead, 9a's positional default name (`<service>:<type>:<index>`) shifts. That's harmless: 9a uses positional names only in logs and park headers, and enrollment has no `runOnce` handler that depends on a stable name.
- **quality:** 9a's rewrite moved `addReview` to `quality.service.ts:666` and `listReviews` to `:697` (the plan says `:608`, `:623-632`). `addReview`'s `CourseRated` publish is 9b's outbox site, so 9e's SQL `AVG`/`COUNT` aggregate goes inside 9b's transaction. That's order-of-stack, not drift.
- **course:** `topEducators` is at `course.service.ts:1136` (the plan says `:1118`). 9a's change there is only the `EnrollmentCreated` `enrolled-count` handler (`:133`, `:176`), which 9e doesn't touch.
- **No overlap with 9a's notification changes:** `community.service.ts` (comments, threads, messages) is untouched by 9a, and 9e's batch `users` endpoint doesn't touch notification's `userInfo`.

## Drift check 2026-10-07 (vs origin/main b4666f2) · Verdict: DRIFT: D1–D3 (small, wording-level)
Not a review round: the plan stays APPROVED once D1–D3 are answered. This is a read-only check against `b4666f2`, which adds 6b's code as built, 6d, 8a, 8b, 11a and Phase 10. I also read 9b's tip (`fix/outbox` `874a377`) where 9e touches the same code.

### Drift
- **D1. The heartbeat's "≤ 3 database round trips" no longer fits 6b as built.**
  - **What the plan assumed:** the budget (acceptance, decision 4, step 5 spec) was set against 6b's plan, with the video-progress write as one statement.
  - **What main does:** 6b's `applyHeartbeat` (`enrollment.service.ts:213-245`) reads the row, applies its rules in code (max duration, clamp to `required + 5`, `started_at ??= now`), then saves. It retries on a unique violation for simultaneous first beats (`d6d7f5e`).
  - **The count:** on an already-completed lesson in a completed course, that is the enrollment `findOne`, the video-progress `findOne`, its `save`, and 9e's enrollment `UPDATE`. That's 4 before TypeORM's own `save` round trips. To pass "≤ 3", the implementer would have to rewrite `apply()` as a SQL upsert, which is 6b's anti-cheat logic and a stated non-goal.
  - **Fix (wording):** pin what 9e removes.
    - **No internal call.**
    - **No milestone or detection work** once the course is complete.
    - **One enrollment write**, the `UPDATE` replacing both `touch()` saves, since `recordCompletion` touches again at `:336`.
    - **Exactly one count query** while the course isn't complete.
    - **6b's video-progress read and write left as they are.**

    The step 5 spec counts internal calls and enrollment writes, not total queries.
- **D2. Two of the four UI changes now sit on translated pages (Phase 10).**
  - `CourseCard` and the course page render through `<T>`/`Localized`, and the i18n parity test requires every new key in both `i18n-en.ts` and `i18n-am.ts`.
  - Decision 7's "new strings get `t()` keys where the page already translates" therefore covers "Show more reviews" and any educator-name label on cards. Add their `am` drafts to `docs/i18n/am-review.md`, as Phase 10 does.
  - The course page is a server component: it shows `reviews.reviews.slice(0, 5)` at `courses/[id]/page.tsx:222`. "Show more reviews" needs a small client island there, as `CoursePreviewPlayer` is.
- **D3. `GET /refunds/pending` "plus `total`" breaks 8a's admin tab.**
  - 8a (merged after approval) reads the endpoint as a bare array: `api<any[]>('/refunds/pending')` and `refunds?.map` (`admin/page.tsx:337,369`).
  - **Scenario:** decision 5 adds `total`, and an array can't carry it. Returning `{ items, total }` makes `refunds.map` throw, which takes down the Refunds tab, and breaks the either-order deploy rule (review S1).
  - **Fix:** keep the bare array (oldest first, `take: 100`) and drop `total`. If a count is wanted, the tab can show "100+" when it gets 100 rows.

### Confirmed (line drift only; re-find by code)
- **Internal endpoints** are as listed: course `courses/:id/lesson-ids` (`internal.controller.ts:29`), the auth routes (`:23-76`) and enrollment `entitlements` (`enrollment.controller.ts:123`). No batch endpoint exists yet.
- **N+1 sites** are all still per-item:
  - `listForLearner` `:113`, with `progressPercent` `:760` (main still returns 0 on failure; 9c's `null` comes with the stack);
  - sponsorships `listBulk` `:307`, `mine` `:385` and `withProgress` `:543-563`. 6d added `pay_requests` (`take: 50`, no per-row call) and the `given` filter; `withProgress` is unchanged;
  - `topEducators` `course.service.ts:1127`, and the authors loop at `:814` (the plan's `:802-805`);
  - `adminList` `payment.service.ts:959`, `courseAttempts` `assessment.service.ts:766` (sequential names `:783-790`) and `myAttempts` `:851`.
- **Heartbeat:** `saveVideoProgress` `:195`, `liveLesson` `:315`, `recordCompletion` `:330`, `touch` `:341`.
  - The `CourseRevisionClosed` handler is `onRevisionApplied` (`:598`). It also resets replaced-video rows and rechecks completions with its own strict `lesson-ids` call (`:623`).
  - Clear the cache at the top of that handler, so a throwing reset or recheck doesn't skip the clear (the TTL bounds it anyway).
  - 9b's tip keeps `detectCompletion(…, lessonIds?)`, so the cached ids plug in. It moves the completion write into the outbox transaction and makes the milestone publish fire-and-forget. No conflict.
- **Unbounded reads** are unchanged:
  - `payments listMine` `:953`;
  - `payeeAnalytics` `:991` and `adminAnalytics` `:1000`;
  - `refunds listMine` `:184`;
  - payouts `listForPayee` `:200`, `listAll` `:204` (`take: 200`) and `balance` `:209`;
  - `listReviews` `quality.service.ts:623` and `addReview` `:592` (9b rewrites both, as the 9a check noted);
  - community `listComments` `:38`, `myThreads` `:137` and `threadMessages` `:175` (`take: 500`, ascending).
  - `refunds listPending` (`:188`) now joins payments with one `In()` for amount and title, so it has no N+1.
- **Payout cron (narrower than the plan says):** `runPayouts` (`:88`) already pages payees (`PAYEE_PAGE`, `PAYMENTS_PER_PAYOUT`, from 6c). Only the scheduled-payouts `find` at `:91` is unbounded, so "batches of 200" applies to that loop alone.
- **Web consumers:**
  - the payee `by_course` lookup is now `teach/analytics/page.tsx:134`, and the admin top-8 is `growth-tabs.tsx:89`;
  - the reviews are read at the course page `:73`, preview `:90`, editor `teach/courses/[id]/page.tsx:44` and institution `:155`;
  - `/payouts` (`teach/page.tsx:21`, `admin/page.tsx:263`) and `/payments/mine` (`dashboard/page.tsx:41`) are read as arrays. `PageQuery` (9c) is a query DTO only, so they stay arrays under decision 5's shape rule.
- **11a:** the lint job builds api and holds the baseline, and the handoff already says to stay at or under it.
- **Phase 10:** 9e adds no browser origin, so the CSP is unaffected.

### Planner response to the drift check 2026-10-07 (ethio-planner [5b0124])
- D1: taken as you worded it (plan "Amendments 2026-10-07").
- D2: taken. Keys in both dictionaries, the `am` drafts in the review list, and a client island for "Show more reviews".
- D3: taken. A bare array, no `total`.
- The plan stays APPROVED.
