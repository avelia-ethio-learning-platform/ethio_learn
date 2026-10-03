# Plan review: Phase 7b, public and learner pages

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)"), against `3de83c3` (read with `git show`, working tree untouched): auth service, entities and migrations, gateway rate policy, notification service, course search and public detail, stream-url, the course page, the lesson player and the preview player. The approved 7a plan and Phase 5 are treated as merged.

Checked and OK (security):
- **Only signup creates unverified users.** Google sign-in, staff and membership invites, and admin-created users are all verified at creation (`auth.service.ts:167,183,305`, `membership.service.ts:63`, `admin.controller.ts:82`). So resend can't mail an invitee or a Google user.
- **Enumeration:** the uniform 200 copies `requestPasswordReset` and adds no new oracle. Signup already answers 409 "Email already in use" (`auth.service.ts:53`), so account existence is enumerable there anyway. Resend reveals nothing more, and in particular not whether an account is verified. Resend and password reset share the same small timing difference (an insert and a publish). That isn't worth more work while signup gives the answer outright.
- **The link** is built from `WEB_URL`, not from the request, so it can't be pointed at another host. The token is the same 32-byte random as signup's.
- **Notification `deliver`** has no per-user dedupe (`notification.service.ts:650-668`), so a second verification email isn't swallowed. A separate event is the right call: `UserRegistered` has a financial consumer.

Checked and OK (other):
- `@CreateDateColumn({ type: 'timestamptz' })` matches `DEFAULT now()`, so `db:check` won't drift. The column-plus-concurrent-index pair follows Phase 3's `MembershipStatus`/`MembershipIndexes`.
- **The API already supports what the web needs:** `search` returns `total` and the five `sort` values; `publicDetail` returns `has_video`, `instructor_id` and `instructor_name`.
- **Preview:** the preview player sends signed-out users to `/login?next=`, so "Free preview for every pricing type" has no dead end.
- **Finished courses:** entitlement stays `active` after completion (`completed_at` is separate), so the "not enrolled" gate won't lock out learners who have finished.

### Blockers
- **B1. The per-account caps are check-then-insert with no lock, so a concurrent burst bypasses them** at Decision 7 (caps)
  Scenario: an attacker signs up with a victim's address (one email), then fires 50 resend requests at once from 5 IPs (10 each, within `auth-strict`). Every request counts the victim's rows before any insert commits, so every one sees "0 in the last 60 s, 1 in 24 h", inserts, and publishes. The victim gets about 50 emails in a second, and the next IPs repeat it.
  The acceptance criterion "capped per account (one per 60 s, five per 24 h)" fails. The endpoint becomes an unauthenticated email-bombing tool that runs on our sender reputation and free-tier email quota, which then delays real signup and reset emails.
  This differs from 6a's accepted "small race" for two reasons. Those endpoints are authenticated and bounded by a per-account rate class. Here the only bound on a burst is the number of IPs, and the attacker chooses the target.
  Suggested fix: in one transaction, `SELECT id FROM auth.users WHERE id = $1 FOR UPDATE` (or `pg_advisory_xact_lock` on the user id), then count, insert and commit. Publish after commit. Concurrent resends for one user then serialize, and the second one sees the first one's row. Add a jest or integration test: 5 parallel calls for one user → exactly 1 row and 1 event.
  Response: **Fixed.** Decision 7 now runs the cap check in one transaction: lock the user row (`SELECT … FOR UPDATE` via TypeORM `pessimistic_write`; works through Neon's transaction-mode pooler because it's a plain transaction lock), count, insert, commit, and publish only after commit. Concurrent resends for one user serialize. Step 6 adds the test: 5 parallel calls for one unverified user against a real Postgres → exactly 1 new row and 1 event. No api jest test uses a real DB today, so it's either a jest spec that runs only when `TEST_DATABASE_URL` is set (run locally and in the CI e2e job), or a node script in the e2e job that counts rows; if it goes through the gateway it must fit the `auth-strict` per-IP budget noted in `playwright.config.ts`. The in-memory repos can't show the race. The acceptance criterion now says the caps hold under concurrent requests.

### Should-fix
- **S1. The lesson player must not show "You're not enrolled" while the status is loading or has failed** at Decision 4 (states)
  Scenario: on the free tier, the enrollment service is asleep, so `/enrollments/status` is slow or errors. If the gate reads `status?.entitlement_status !== 'active'`, a paying learner sees "You're not enrolled in this course" with a link to the buy page. At best that's confusing, and at worst it prompts a second purchase.
  Suggested fix: spell out the order in decision 4. Status loading → skeleton. Status error → the same waking-up/Retry state as the course query. "Not enrolled" only when a successful response says the status isn't `active`. Add this case to the step 4 vitest.
  Response: **Fixed.** Decision 4 spells out the order: course query (404 → not found, error → waking-up/Retry); status loading → skeleton; status error → the same waking-up/Retry; "not enrolled" only on a successful response whose status isn't `active`. Added to the step 4 vitest.
- **S2. A `<details>` element can't stay open on desktop, so the filters would be collapsed at 1440 px** at Decision 8
  Scenario: the server renders `<details>` closed when no filter is active. In Chrome before 131, Safari and Firefox, author CSS can't show a closed `<details>`'s content (only `::details-content` can, and it's new). So a desktop visitor with no filter set sees only "Filters (0)". Making `open` follow `matchMedia` instead flashes after hydration and is wrong on the server.
  Suggested fix: use a plain disclosure. A `<button aria-expanded aria-controls>` (`md:hidden`) toggles a panel whose classes are `hidden md:block` when collapsed and `block` when open, with the initial state open when any filter is active. CSS alone keeps it open at `md` and above, and there's no hydration mismatch.
  Response: **Fixed.** Decision 8 uses a plain disclosure: an `md:hidden` `<button aria-expanded aria-controls>`, and a panel with `hidden md:block` when collapsed and `block` when open, initially open when any filter is active. No `<details>`.
- **S3. The per-course OG image needs an Ethiopic font, and it can't reuse `CourseCover`** at Decisions 1 and 2
  Scenario: `ImageResponse` (Satori) only has its bundled Latin font. The Amharic category label, or any course with an Amharic title, renders as empty boxes in every Telegram and Facebook preview. Satori also supports only inline styles, flexbox and no pseudo-elements, so the Tailwind `CourseCover` component can't render there as decision 1 implies.
  Suggested fix:
  - Share the cover's data (group colour, labels, band colours) from `categories.ts`, not the component.
  - Write a Satori-specific layout in `opengraph-image.tsx`.
  - Pass a subset Noto Sans Ethiopic TTF via `fonts`, read from the repo with the Node runtime, rather than fetched from Google at request time.
  - Make the step 9 Playwright check render one course with an Amharic title and assert the PNG, or at least screenshot it into the after-folder for the user.
  Response: **Fixed.** Decision 1 shares the cover's data (group colours, labels, band colours) from `categories.ts`, and decision 2 has its own Satori layout in `opengraph-image.tsx` (inline styles, flexbox, no pseudo-elements). It uses the Node runtime and passes Inter and a Noto Sans Ethiopic TTF via `fonts`, read from `web/src/assets/fonts/` (OFL, with the licence file next to it), never fetched at request time. Subset it with fonttools if available, otherwise commit the Bold weight as is. Step 9 renders a seeded course with an Amharic title and asserts a PNG, and the screenshot goes into the after-folder.
- **S4. Lesson-player DOM order should match the mobile order; CSS `order` alone can't do it here** at Decision 4 (mobile order)
  Scenario: today the player and every panel sit in one `lg:col-span-2` div, and the `aside` is its sibling (`learn/[courseId]/page.tsx:229-230,341`). CSS `order` can't move the aside between the player and the assessments inside that div. And if the implementer splits the column but leaves the aside last in the DOM, mobile keyboard and screen-reader users reach the lesson list only after the assessments, the tutor and the review box. Visually it sits right under the player, which fails WCAG 1.3.2 and 2.4.3, and axe doesn't catch this.
  Suggested fix: split the main column into "player and controls" and "panels". Put the `aside` between them in the DOM. On desktop, place them with grid lines (`lg:col-start-3 lg:row-start-1 lg:row-span-2` on the aside, which is sticky inside its area), as decision 3 already does for the buy box.
  Response: **Fixed.** Decision 4 splits the main column into "player and controls" and "panels", with the `aside` between them in the DOM. On desktop it's placed by grid lines (`lg:col-start-3 lg:row-start-1 lg:row-span-2`, sticky inside its area), so DOM order equals mobile visual order. Step 9 adds a Playwright tab-order check at 375 px: from the player controls, the next focusable control is in the lesson list.

### Nits (optional)
- **N1. The signup success screen's Resend should start its 60 s cooldown on mount.** The signup row counts toward the 60 s cap, so a click in the first minute is silently capped while the UI says a new link was sent.
  Response: **Fixed.** The signup success screen starts the 60 s cooldown on mount (decision 7 web part, step 7).
- **N2. `playLesson` reads `videoRef.current` after the stream-url await** (`:161-164`) and returns silently if it is null. Mount the `<video>` as soon as `activeId` is set, not when the URL arrives. Add a Playwright step: "Start lesson 1" → the `<video>` gets a `src` (or an HLS-attached `blob:` source).
  Response: **Fixed.** Decision 4 mounts the `<video>` as soon as `activeId` is set, with the loading overlay over it until the URL arrives; the Playwright step is added to step 9.
- **N3. Have `resendVerification` also skip users whose `status` isn't `active`,** with the outcome logged. A suspended or banned account can't log in, so a verification email to it is pointless mail on our sender.
  Response: **Fixed.** Decision 7 skips users whose `status` isn't `active` (outcome `inactive` in the log), with a jest case.

## Round 2 (2026-10-02) · Verdict: APPROVED
Reviewed: `plan.md` (status "in review (round 2)"); only the changed parts, against the round 1 findings.

Resolved:
- **B1:** decision 7 serializes the cap check per user: one transaction, the user row taken with `FOR UPDATE` (`pessimistic_write`), then count, insert and commit, with publish after commit. Under READ COMMITTED, the waiting transaction's count runs after the lock is released and sees the first row. The acceptance criterion now covers concurrent requests, and step 6 has the real-Postgres test (5 parallel → 1 row, 1 event).
- **S1:** decision 4 orders the states: status loading → skeleton; status error → waking-up/Retry; "not enrolled" only on a successful non-active response. The vitest covers it.
- **S2:** a button disclosure with `hidden md:block`, and no `<details>`.
- **S3:** shared cover data, a Satori-only layout, local Inter and Noto Sans Ethiopic via `fonts`, and an Amharic-titled seed course with a PNG check.
- **S4:** the DOM order is player → aside → panels, placed by grid lines on desktop, with a 375 px tab-order check.
- **N1–N3:** all taken (cooldown on mount, `<video>` mounts on `activeId`, inactive users skipped and logged as `inactive`).

### Blockers
None.

### Should-fix
- **S5. Make sure the font files reach the deployed OG route, not just the repo** at Decision 2 (fonts)
  Scenario: `opengraph-image.tsx` reads `web/src/assets/fonts/*.ttf` with `fs` and a `process.cwd()` path. The runtime Docker image copies only `.next/standalone`, `.next/static` and `public` (`web/Dockerfile:29-31`), and Vercel's function bundle contains only traced files. If tracing misses the font, every course's `/opengraph-image` fails with ENOENT in production, so link previews lose their image. Meanwhile the Playwright check passes, because it runs `next start` from the repo, where `src/` exists.
  Suggested fix: read the fonts with `readFile(new URL('<relative path>/NotoSansEthiopic-Bold.ttf', import.meta.url))`, which webpack emits as an asset of the route, or list them in `experimental.outputFileTracingIncludes`. Add a check to step 11: after `BUILD_STANDALONE=1 pnpm -C web build`, the fonts appear under `.next/standalone` (or in the route's `.nft.json`).
  Response:

### Planner response to round 2
- **S5 (round 2):** **Fixed.** Folded into decision 2: fonts are read via `new URL(..., import.meta.url)` (or `outputFileTracingIncludes`), and the standalone build is checked for the font files and a working route.

## Round 3 (2026-10-02) · Verdict: APPROVED (A1 FYI, delta only)
Reviewed: amendment A1 at the end of "Risks and open questions" and step 2 of the checklist.

- A1's premise holds: `submitBlocker` refuses a course without `thumbnail_url` (`api/services/course/src/course.service.ts:680` on `origin/main`), so a seed writing `null` would leave every seeded course a draft and break demo-seed and CI e2e. Keeping the `placehold.co` URL (`scripts/demo-seed.mjs:268` on main) and treating it as missing via `hasRealThumbnail` is the right call, and relaxing the submit rule is correctly out of scope.
- The note on `feat/sample-content` is folded in: on that branch `demo-seed.mjs` imports `COURSES`/`buildSections` from `scripts/lib/sample-catalog.mjs`, which `scripts/sample-content.mjs` also publishes on production. The Amharic-titled OG-check course goes in `demo-seed.mjs` only.

No blockers, no should-fix.

## Drift check (2026-10-03, against origin/main 4b4a64c, fix/security-platform and 7a's plan)
Not a review round: the plan stays APPROVED. A read-only check of the code this phase will be built on, after Phases 3–5 merged (`origin/main` 4b4a64c) and with 6a in flight (`fix/security-platform`). Subagents did the sweep; I verified every blocker against the code myself. The planner folds these into the plan before the handoff (or now, for a phase already in progress). Blocker here means the implementer would build something wrong or silently break a merged behaviour or test.

### Blocker
- **D1. Decision 4, and the criterion "a bad or unknown course ID shows Course not found".** A malformed id gets a **400**, not a 404:
  - on main, `DbErrorFilter` maps 22P02 to 400 (`api/packages/common/src/http/db-error.filter.ts:20`);
  - 6a adds `UuidParam` on the course routes.

  As planned, `/learn/not-a-uuid` would show the waking-up state, whose Retry can never succeed, instead of "Course not found". Phase 5's `serverApi` already treats 400 as not found (`server-api.ts:41`).
  **Fix:** map an `ApiError` 400 or 404 to "Course not found", and add a `/learn/not-a-uuid` case.
  Response (2026-10-03): **Fixed.** Decision 4's first state is now an `ApiError` 400 or 404 → "Course not found" (with the reason); the acceptance criterion says so; step 4 vitest adds the 400 case and step 9 adds `/learn/not-a-uuid`.

### Fixes
- **D2. Decision 3 and step 9 (the sticky buy card).** Phase 5 already tests it: `getByRole('complementary') > div` at y = 112 (`web/e2e/layout.spec.ts:84-92`). Keep an `<aside>` whose first child is the sticky card, or update that spec rather than adding a duplicate.
  Response (2026-10-03): **Fixed.** Decision 3 keeps the buy box as the page's only `<aside>`, with the sticky card as its first child `div`; step 9 relies on `layout.spec.ts` instead of adding a second sticky test.
- **D3. Decision 5 (the 404 heading "We couldn't find that page").** `cold-start.spec.ts:14` asserts `getByText('Page not found')` has count 0. That assertion then passes vacuously, so point it at the new heading.
  Response (2026-10-03): **Fixed.** Decision 5 and step 9 move `cold-start.spec.ts`'s absence check to the new heading.
- **D4. Step 6 (auth migrations).**
  - 6a takes the next auth slots, `1790964028397-InvitedAt` and `…398-InvitedAtIndex`. Use later timestamps and list them after 6a's in `migrations/index.ts`.
  - The house index pattern is `DROP INDEX CONCURRENTLY IF EXISTS`, then `CREATE` (`auth/src/migrations/1790964028396-MembershipIndexes.ts:15-16`), not `IF NOT EXISTS`.
  - Add a named entity `@Index`, or `db:check` reports a DROP.
  Response (2026-10-03): **Fixed.** The data model now uses later timestamps, lists them after 6a's in `index.ts` (merging `origin/main` first if 6a has merged, otherwise at the pre-PR merge), follows the DROP-then-CREATE pattern with a named entity `@Index`, and runs `db:check` on a scratch DB until 6a is merged in. Steps 1, 6 and 11 say so.
- **D5. Decision 10 (the password rule).** `scorePassword(...).score < 3` gates three forms:
  - signup (`signup/page.tsx:35`);
  - accept-invite (`accept-invite/page.tsx:34`);
  - account/password, which 6a rewrites with a new `page.test.tsx`.

  `PasswordStrength.test.tsx:7-8` pins the old scores. Move all three callers to `ok` and update that test.
  Response (2026-10-03): **Fixed.** Decision 10 moves all three callers to `ok` (account/password as 6a rewrote it, keeping its `page.test.tsx` green) and updates `PasswordStrength.test.tsx`; step 11's pre-PR merge checks that `score < 3` is gone.
- **D6. Step 9, the auth-strict budget.** The suite spends 7 of 10 per minute (`playwright.config.ts:8-9`). 7a's a11y spec may add wrong-password submits, and 7b's signup plus resend takes it to 10 or more. Resend from `copy.spec.ts`'s existing signup (+1 call), or stub it, and update the budget comment.
  Response (2026-10-03): **Fixed.** Step 9's resend runs inside `copy.spec.ts`'s existing signup (+1, so 8 of 10), using `page.clock` for the on-mount cooldown, and updates the budget comment. Step 6's concurrency test never goes through the gateway.
- **D7. Steps 2–3 against 7a.**
  - 7a's `labels.ts` adds a second `categoryLabel` with a sentence-case fallback (`feat/ui-foundations:web/src/lib/labels.ts:60`). `categories.ts`'s version falls back to "Other". Name which one the chip and the cover use.
  - 7a's sweeps already replace the raw `course.category` and CourseCard's ETB concatenation.
  Response (2026-10-03): **Fixed.** Decision 1 names `categories.ts` (`categoryLabel` plus a new `categoryMeta` with the `other` fallback) for the chip, the cover and the OG image, and switches 7a's import there; step 2 keeps 7a's ETB and label swaps.
- **D8. Step 2 (Amharic labels "in categories.ts only").** The catalog pills already show Amharic through the i18n `cat_*` keys (`web/src/lib/i18n.tsx:196-200`): ቢዝነስ and ሌላ, against the plan's ንግድ and ሌሎች. Keep one source, and add the i18n keys to the native-speaker review.
  Response (2026-10-03): **Fixed.** Step 2's `am` labels for business and other now match the `cat_*` strings (ቢዝነስ, ሌላ); a vitest pins the five to the i18n keys; the `cat_*` keys join the native-speaker review.
