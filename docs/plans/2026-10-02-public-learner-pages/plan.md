# Phase 7b: Public and learner pages

Status: approved (round 2); amended after approval (A1, see the end of Risks and open questions); drift check (2026-10-03) folded in (D1–D8, marked "(drift Dn)")
Size: M (sessions: 3 — ethio-impl, or `ethio-impl-web`, implements; ethio-plan-review reviews plan and code). Web, plus one public auth endpoint (with a two-file migration) and one new event that the notification service consumes.
Base branch: `origin/main` @ `ebc1eba` (2026-10-03), which already has 6a (PR #24) and 7a (PR #25). So 6a's auth migrations (`…397-InvitedAt`, `…398-InvitedAtIndex`) and its account/password rewrite are already below this branch; the drift D4/D5 notes about merging them in later only apply to the pre-PR `git merge origin/main` (6c or 6b may land first). Built in the `ethi0-web` worktree by ethio-planner. This phase uses 7a's `Field`, `FormStatus`, `labels.ts`, `format.ts` and axe gate · Feature branch: `feat/public-learner-pages`
Roadmap: phase 7b (Phase 7 split; see `../2026-10-02-ui-foundations/plan.md`, "Roadmap change").
Visual direction (approved by the user): https://claude.ai/artifact/1KNuTFQ4NeRfsnuAJTxj5k, studies 1 and 2.
Findings: P1-32, P1-34, P1-35, P1-36, P1-39, P2-22, P2-25, P2-30, P2-32, P2-35.

## Goal
Fix the pages where learners decide and learn:
- **Course page:** decide from the first screen on a phone.
- **Catalog:** looks finished and can be sorted.
- **Lesson player:** works on a phone.
- **Dead ends:** branded 404s, error pages and failed panels offer a way forward.
- **Verification email:** a lost one no longer locks a new account out.

Acceptance criteria:
- **Course page (P1-35):**
  - an educator byline links to the educator's profile;
  - at 375 px, the price and the primary action are visible in the first screen (no scrolling), and a bottom bar keeps them in reach while scrolling;
  - at ≥1024 px, the buy card is sticky;
  - "Free preview" shows only when a preview can actually play, and a playable preview shows for every pricing type;
  - free courses show no payment or refund lines.
- **Covers (P1-36):**
  - a course without a real thumbnail (none, or a `placehold.co` URL) shows a generated cover: category colour, full title, the Amharic category label and the woven band;
  - every course page has its own 1200×630 OG image;
  - the demo seed keeps its `placehold.co` URL (A1): course submit requires a thumbnail (`api/services/course/src/course.service.ts:680`), and `hasRealThumbnail` treats that URL as missing, so seeded courses still show the generated cover.
- **Lesson player (P1-39):**
  - below 1024 px, the lesson list comes right after the player, collapsed to the current section with "All lessons" to expand;
  - the empty player shows "Start lesson 1" or "Resume: <lesson>", never a dead `<video>` control bar;
  - on completion, the page links to the certificate, or says what's still missing.
- **Dead ends (P1-32, P2-32):**
  - branded `not-found`, `error` and `global-error` pages, each with a way forward;
  - `loading.tsx` for the course detail and lesson routes;
  - a bad or unknown lesson-player course ID shows "Course not found", not a skeleton forever. A malformed ID is a **400** from the API, not a 404 (drift D1);
  - a learner who isn't enrolled sees "You're not enrolled" with a link to the course page;
  - the account page shows an error with Retry instead of going blank;
  - each lesson-player side panel (assessments, tutor, changelog) shows its own error with Retry;
  - `.skeleton` is defined once.
- **Verification (P1-34):**
  - `POST /api/v1/auth/resend-verification` sends a new link to an unverified account;
  - it answers the same way whether or not the account exists or is verified;
  - it is capped per account (one per 60 s, five per 24 h), **including under concurrent requests**, and per IP (the `auth-strict` bucket);
  - it never emails suspended or banned accounts;
  - the signup success and verify-email pages offer "Resend email" and "Go to login".
- **Catalog (P2-22):**
  - a Sort select (Recommended, Newest, Most popular, Price low–high, Price high–low) kept in the URL;
  - filter pills expose `aria-pressed`;
  - below 768 px, filters collapse into a "Filters (n)" disclosure, so results start in the first screen;
  - "Showing 1–12 of 15 courses".
- **Small things:**
  - review stars default to none, as a radiogroup, and Submit stays disabled until a rating is chosen (P2-25);
  - the signup password checklist mirrors the server rule ("at least 8 characters and 3 of these 4"), and the error sits under the password field (P2-30);
  - lucide icons replace emoji used as status icons on public and learner pages (P2-35).
- The 7a axe gate stays at zero serious or critical violations, now also covering the new states.

## Non-goals
- **Educator names on catalog cards:** that needs a batched user-name lookup, which is Phase 9 (P1-22, N+1). The byline goes on the course page only, where the API already returns `instructor_name`.
- **Role-page changes** (Phase 8); i18n beyond the keys this phase adds (Phase 10); `next/image` and image dimensions (P2-26, Phase 10).
- **Abandoned checkouts and "Resume payment"** (P2-01) and the `/payment/return` empty state (P2-02): these are payment flows, left for a later phase. This phase doesn't touch `enroll-panel.tsx` beyond moving it into the new buy box.
- **Invalidating older verification links on resend:** each link stays valid until it expires (24 h) or is used. That is simpler, and no worse than today.
- **Real course artwork or an image service:** the cover is CSS.

## Current state
Line numbers are from `fix/access-control` @ `3de83c3`; phases 5, 6b and 7a edit some of these files first.

- **Course page** `web/src/app/(public)/courses/[id]/page.tsx`:
  - a server component with a two-column grid (`:93`);
  - the category is shown as a raw value (`:95`); 7a's words sweep already replaces it, and 7a's format sweep already moves `CourseCard`'s price to `formatETB` (drift D7);
  - no educator, although `GET /courses/:id` already returns `instructor_id` and `instructor_name` (`api/services/course/src/course.service.ts`, `publicDetail`);
  - the preview player renders for free and freemium only (`:111`), while the "Free preview" badge shows on any `is_free_preview` section (`:122`). The API streams free-preview lessons for any pricing type, to a signed-in user (`course.controller.ts:373-392`);
  - the buy card is the last grid item (`:159-177`), so below `lg` it comes after the whole syllabus, and its payment and refund bullets show for every pricing type;
  - `generateMetadata` uses the thumbnail as `og:image` when there is one (`:44-49`).
- **Cards and thumbnails:**
  - `CourseCard.tsx`: an emoji over a gradient when there is no thumbnail (`:24-51`); the price is built by concatenation (`:18-22`);
  - `scripts/demo-seed.mjs:268` sets a `placehold.co` URL for every seeded course, and the same URL may be in production data;
  - `lib/categories.ts`: 16 categories, English labels and emoji, with no Amharic labels, and a `categoryLabel` that falls back to "Other". 7a adds a second `categoryLabel` in `lib/labels.ts` that falls back to the sentence-cased value (drift D7);
  - the catalog and home pills already show Amharic through five i18n keys, `cat_tech`, `cat_business`, `cat_freelancing`, `cat_healthcare` and `cat_other` (`lib/i18n.tsx`): ቴክኖሎጂ, ቢዝነስ, ፍሪላንሲንግ, ጤና, ሌላ (drift D8).
- **Lesson player** `web/src/app/(learn)/learn/[courseId]/page.tsx`:
  - `if (!course)` shows a skeleton (`:201-216`) with no `isError` branch, and the enrollment status (`:81-84`) is fetched but never used to gate;
  - the empty `<video controls>` renders before any lesson is chosen (`:257-270`), with "Select a lesson" twice (`:290`, `:315`);
  - the lesson `aside` is the second grid column (`:341`), so on mobile it renders after the assessments, the tutor and the review box;
  - completion shows "course completed 🎉" (`:326`) with no certificate link. Certificates come from `GET /me/certificates` (`dashboard/page.tsx:33`).
  - The `ReviewBox` (`:419-451`) defaults to 5 stars, uses plain buttons and a single message for success and error.
- **Catalog:**
  - `courses/page.tsx` forwards `q`, `category`, `pricing_type`, `page` and `limit`, but not `sort`, which the API already supports (`top | new | popular | price_asc | price_desc`, `course.service.ts` `search`);
  - in `explore-client.tsx`, the pills have no `aria-pressed` (`:173-203`), and the filters are always expanded.
- **Auth:**
  - `signup` stores an `EmailVerification` row and publishes `UserRegistered` with the link (`auth.service.ts` `signup`). There is no resend route;
  - `EmailVerification` has no `created_at` (`entities.ts:55-71`);
  - the gateway already routes `/api/v1/auth/*` as public (`gateway/src/routes.ts`), and `rate-policy.ts:40` lists the `auth-strict` paths (10 per minute per IP);
  - `requestPasswordReset` is the enumeration-safe pattern to copy;
  - in `verify-email/page.tsx`, the error state has no action, and after Phase 5 the signup success screen has no dev line and no resend.
- **Passwords:** the server requires ≥ 8 characters and 3 of 4 categories (`auth/src/dto.ts:5-30`). The client `scorePassword` (`PasswordStrength.tsx:4-14`) counts length as a check and merges upper and lower case, so `12345678!` passes the client and fails the server. Three forms gate on `scorePassword(...).score < 3`: signup, accept-invite and account/password (which 6a rewrites, with a new `page.test.tsx`). `PasswordStrength.test.tsx` pins today's scores (drift D5).
- **Error pages:** Phase 5 adds a plain root `not-found.tsx` and `error.tsx` built on `PageShell`, plus `WakingUp` for cold starts. There is no `global-error.tsx` and no `loading.tsx`. `e2e/cold-start.spec.ts` asserts the waking course page has no `Page not found` text (drift D3).
- **Phase 5's specs on these pages:** `e2e/layout.spec.ts` checks the sticky buy card as `getByRole('complementary') > div` at y = 112 at 1440 px (drift D2). The `playwright.config.ts` comment budgets 7 of the gateway's 10 `auth-strict` calls per minute per IP (drift D6).
- **Account page:** `account/page.tsx:36` returns `null` on a query error.
- **CSS:** `.skeleton` is defined twice in `globals.css` (`:334-344` in `@layer components`, and `:423-432` unlayered, which wins).

## Design and key decisions
1. **`CourseCover`, a CSS component** in `web/src/components/CourseCover.tsx`, used by `CourseCard`, the course page header, the dashboard rows and the OG image.
   - **Look:**
     - category colour from five groups (tech, business, freelancing, healthcare, other);
     - full title;
     - English and Amharic category labels;
     - the woven band from the visual direction.
   - **Data:** `categories.ts` gains `group` and `am` per category, and exports the five group colours and the band colours, so `CourseCover` (Tailwind) and the OG image (Satori) share data, not a component. The Amharic labels are listed in the plan's step 2 and flagged for the native-speaker review the user asked for.
   - **One label source per category (drift D7, D8):**
     - the course-page chip, `CourseCover` and the OG image use `categories.ts`: its `categoryLabel`, plus a `categoryMeta(value)` that returns the `other` entry for an unknown value. The English label, the Amharic label and the colour group then always agree. Where 7a's sweep imported `labels.ts`'s `categoryLabel` on the course page or `CourseCard`, switch that import. Other 7a call sites keep `labels.ts`;
     - for the five values that already have i18n keys (`tech`, `business`, `freelancing`, `healthcare`, `other`), `categories.ts`'s `am` uses the same strings the pills show today. A vitest asserts `am === dictionaries.am['cat_<value>']` for those five, so the two lists can't drift. The `cat_*` keys join the native-speaker review list.
   - **Real thumbnails:** `hasRealThumbnail(url)` is false for null and for `placehold.co` hosts, so existing production rows fall back without a data migration. An uploaded thumbnail still wins.
   - Rejected: generating images server-side for the cards. The cover would then need an image request per card, and CSS renders instantly.
2. **Per-course OG image:** `courses/[id]/opengraph-image.tsx` with `ImageResponse` renders the cover design at 1200×630: title, category, educator name, price via `formatETB`, and the band.
   - **Its own Satori layout,** not `CourseCover`: inline styles and flexbox only, no pseudo-elements, using the shared colours from `categories.ts` (round-1 S3).
   - **Fonts:** Node runtime. Inter and a Noto Sans Ethiopic TTF are passed via `fonts`, read with `fs` from `web/src/assets/fonts/` (OFL, with the licence file alongside), never fetched at request time. Without the Ethiopic font, Amharic labels and titles render as boxes. Subset it with fonttools if available; otherwise commit the Bold weight as is.
   - **The fonts must ship with the route** (round-2 S5): read them with `readFile(new URL('../../../assets/fonts/<file>', import.meta.url))` (relative to the route file), so Next's file tracing bundles them; or list them in `outputFileTracingIncludes`. A plain `fs` path from `src/` works under `next start` but fails with ENOENT in the Docker standalone runtime (which copies only `.next/standalone`, `static` and `public`) and on Vercel. Step 9 checks that the font files appear in `.next/standalone` after `BUILD_STANDALONE=1 pnpm -C web build`, and that the route returns a PNG from the standalone server.
   - It always uses the generated design, even when a thumbnail exists. Thumbnails can be any size or host, and the generated card is consistent in Telegram and Facebook previews.
   - On `unavailable` (Phase 5's `serverApi` result), it renders a generic site card instead of failing.
   - `generateMetadata` drops the thumbnail `images` entry, since the file convention wins.
3. **Course page layout** (study 2):
   - **Header:** cover strip (`CourseCover`, short), `categoryLabel` chip, h1, summary, educator byline (`instructor_name` → `/educators/<instructor_id>`, hidden when the name is empty), and the facts row (lessons, minutes, language, certificate).
   - **Buy box below `lg`:** placed right after the facts row, in the first screen at 375 px. It shows the price, `EnrollPanel`, and the bullets for the pricing type: free → "Verifiable certificate on completion" only; paid/freemium → plus payment methods and the 7-day refund line.
   - **Desktop (≥ `lg`):** the same component is the sticky right-hand card (`top-28`). That works once Phase 5's `overflow-x: clip` lands. One component, rendered once, placed by CSS grid order, not duplicated in the DOM.
   - **Keep Phase 5's sticky check working (drift D2):** the buy box stays the page's only `<aside>`, and its first child `div` is the sticky card, so `layout.spec.ts`'s `getByRole('complementary') > div` at y = 112 still holds. Update that spec if the structure must change. Don't add a second sticky test.
   - **Bottom bar:** below `lg`, a bar with the price and a primary button appears once the buy box scrolls out of view (`IntersectionObserver`). Its button scrolls to and focuses the buy box's primary action rather than duplicating enroll logic. It's hidden while the buy box is visible, and the page reserves bottom padding so it never covers the footer.
   - **Free preview:** shown when any `is_free_preview` section has a lesson with video, whatever the pricing type. Otherwise no badge and no player.
4. **Lesson player:**
   - **States, in this order** (round-1 S1):
     - `course` query error with an `ApiError` status of **400 or 404** → "Course not found", with Browse courses. A malformed ID is a 400: `DbErrorFilter` maps Postgres 22P02 to 400 on main, and 6a's `UuidParam` rejects it before the query. Phase 5's `serverApi` already treats 400 as not found (drift D1);
     - other `course` errors → Phase 5's waking-up/Retry pattern;
     - enrollment status loading → the skeleton;
     - enrollment status error → the same waking-up/Retry. A sleeping enrollment service must never read as "not enrolled";
     - a **successful** status response that isn't `active` → "You're not enrolled in this course", with a link to `/courses/<id>`;
     - only then the player.
   - **The `<video>` mounts as soon as a lesson is chosen** (`activeId` set), before the stream URL arrives, with the loading overlay over it. `playLesson` then always finds `videoRef.current` (round-1 N2). Before a lesson is chosen, the black panel shows one button: "Resume: <lesson>" (from `video-progress`), or "Start lesson 1", using `text-white/80` per 7a. This removes the duplicate "Select a lesson".
   - **Mobile order = DOM order** (round-1 S4): split today's main column into "player and controls" and "panels" (progress, assessments, tutor, review), and put the lesson `aside` **between them in the DOM**. On desktop, grid lines place it (`lg:col-start-3 lg:row-start-1 lg:row-span-2`, sticky within its area), so keyboard and screen-reader order matches the visual order at every width. Below `lg`, the list is collapsed to the active (or first unfinished) section, with an "All lessons (n)" disclosure button (`aria-expanded`).
   - **Completion:** read `GET /me/certificates` and match `course_id`.
     - certificate found → "View certificate" (its verify URL) and "Download";
     - no certificate yet → "You've finished the lessons. Pass the remaining assessments to get your certificate", linking to the assessments panel.
     - The emoji goes (P2-35).
   - The active lesson button gets `aria-current="true"`.
5. **Error and loading pages:**
   - **`not-found.tsx`** (replacing Phase 5's plain one) uses `PageShell`: h1 "We couldn't find that page", a course search form (`/courses?q=`), and Browse courses and Home buttons.
   - `e2e/cold-start.spec.ts`'s check that the waking course page isn't a 404 moves from `getByText('Page not found')` to the new heading, so it doesn't pass vacuously (drift D3).
   - **`error.tsx`:** "Something went wrong" with Retry (`reset()`) and Home.
   - **`global-error.tsx`:** a minimal page with its own `<html>`/`<body>` and inline styles (it renders when the root layout itself fails), with a Reload button.
   - **`loading.tsx`** for `courses/[id]` and `learn/[courseId]`: a skeleton matching each page's layout.
   - Phase 5's `WakingUp` stays the cold-start state; these pages are for real 404s and real bugs.
6. **Panel errors (P2-32):**
   - a small `PanelError` component ("Couldn't load <panel>." plus Retry calling the query's `refetch`), used by the assessments, tutor and changelog panels and the account page;
   - `.skeleton` is kept once: the unlayered shimmer version wins today, so keep it and delete the `@layer components` copy.
7. **Resend verification:**
   - **Request and response:** `POST /api/v1/auth/resend-verification` with `{ email }` (`ResendVerificationDto`: `@IsEmail`, `@MaxLength(254)`) → always `200 { message: "If an unverified account exists for that email, we've sent a new link." }`.
   - **When it sends:** only if the user exists, has `email_verified_at` null, and is within the caps. It then creates a fresh `EmailVerification` row and publishes a new **`VerificationEmailRequested`** event: `{ user_id, email, name, verification_url }`, typed in `@ethiopialearn/contracts` `events.ts`.
   - **Notification:** the service subscribes to it and sends the same verification email. The HTML moves into one `verificationEmail(p)` helper, used by both the `UserRegistered` and the `VerificationEmailRequested` handlers, with event type `VerificationEmailRequested` in the notification log.
   - **Why not reuse `UserRegistered`:** a second "registered" event for the same user is semantically wrong. The financial consumer (`sponsorship.service.ts` `claimForEmail`) only touches `pending_claim` seats, so it would be a no-op today, but any future consumer counting signups or granting a welcome credit would double-count.
   - **Caps** are counted from `email_verifications` rows with `created_at` in the window: at most 1 in the last 60 s and 5 in the last 24 h per user. Over a cap, it sends nothing and returns the same 200. A 429 here would reveal that the account exists.
   - **The cap check is serialized per user** (round-1 B1). One transaction: `SELECT … FROM auth.users WHERE id = $1 FOR UPDATE` (TypeORM `lock: { mode: 'pessimistic_write' }`), then count, insert, commit; publish only after the commit. Without the lock, a burst of parallel requests from a few IPs all read "0 in the last 60 s" and each sends an email, turning the endpoint into an email bomb against an address the attacker signed up. A plain transaction-scoped row lock works through Neon's transaction-mode pooler.
   - **Inactive accounts:** users whose `status` isn't `active` are skipped (round-1 N3).
   - **IP limit:** the gateway's `auth-strict` regex gains `resend-verification`.
   - **Login error:** Phase 3 kept "Email not verified…" on login (enumeration on a correct password only). The login page now shows a "Resend verification email" link next to that error.
   - Rejected:
     - reusing `UserRegistered` (above);
     - Redis counters, a second store for a cap the rows already record.
8. **Catalog:**
   - `sort` is forwarded by `courses/page.tsx` (allowlisted to the five values, default `top` → label "Recommended"), with a labelled `<select>` (7a's `Field`) next to the result count;
   - pills get `aria-pressed`;
   - below `md`, the category, pricing and page-size groups collapse behind a plain disclosure (round-1 S2): an `md:hidden` `<button aria-expanded aria-controls>` "Filters (n active)" toggles a panel that is `hidden md:block` when collapsed and `block` when open, initially open when any filter is active. CSS alone keeps it open at `md` and above. Not `<details>`, which can't be forced open on desktop and would mismatch on hydration;
   - result line: "Showing {from}–{to} of {total} courses".
9. **Review box:**
   - `rating` starts at 0;
   - a `role="radiogroup"` with five `role="radio"` star buttons (`aria-checked`, arrow keys move the selection);
   - Submit is disabled until a rating is chosen;
   - result via 7a's `FormStatus`.
10. **Password rule:** `scorePassword` mirrors the server: `ok = length >= 8 && categories >= 3`. The checklist reads "At least 8 characters" plus "3 of these 4: lowercase, uppercase, number, symbol", each category ticked. The signup error renders in the password `Field`'s error slot. A unit test runs the same table of passwords against the client function and a copy of the server's regexes, so the two can't drift silently.
    - **All three callers gate on `ok`, not `score < 3` (drift D5):** signup, accept-invite, and account/password as 6a rewrote it (its `page.test.tsx` must still pass). `PasswordStrength.test.tsx`'s pinned scores move to the new rule. After the pre-PR merge of `origin/main`, `grep -rn "score < 3" web/src` finds nothing.

## Data model and migrations
- **`auth.email_verifications.created_at timestamptz NOT NULL DEFAULT now()`:**
  - `ADD COLUMN` with a constant default, so no table rewrite on PG 11+. Existing rows get the migration time, which only makes old rows count toward the 24 h cap for one day. That's harmless.
  - Entity: `@CreateDateColumn({ type: 'timestamptz' })`.
- **Index** `IDX_email_verifications_user_id_created_at` on `(user_id, created_at)`, built `CONCURRENTLY` in a second migration with `transaction = false`, using the house pattern: `DROP INDEX CONCURRENTLY IF EXISTS`, then `CREATE INDEX CONCURRENTLY` (not `IF NOT EXISTS`), one statement per `query()`. The entity declares it as a class-level `@Index('IDX_email_verifications_user_id_created_at', ['user_id', 'created_at'])`, or `db:check` reports a DROP (drift D4). The closest model is 6a's `InvitedAt` and `InvitedAtIndex` pair (`auth/src/migrations/1790964028397-*`, `…398-*`).
- **Ordering after 6a (drift D4):** 6a takes the auth slots `1790964028397-InvitedAt` and `1790964028398-InvitedAtIndex`. This phase's two migrations take timestamps generated when they're written (later than `1790964028398`). In `migrations/index.ts`, they're listed after 6a's two. 7b's base doesn't contain 6a, so if 6a has merged by step 6, merge `origin/main` first. Otherwise, resolve `index.ts` at the pre-PR merge (step 11): 6a's imports and entries first, then this phase's. Rerun the migration round trip and `db:check` after that merge.
- **Local DB:** the shared local Postgres may already hold 6a's `invited_at` column (ethio-impl's stack). Without 6a's code, `db:check` would report it as drift, so run this phase's migration round trip and `db:check` on a scratch DB until 6a is merged in.
- **Rollback:** `down()` drops the index (`IF EXISTS`), then the column. Both are safe, since nothing else reads them.
- `pnpm -C api db:check` → no drift after both run.

## API contract
- **`POST /api/v1/auth/resend-verification`**, public, `auth-strict` per IP.
  - Body: `{ email: string }`.
  - 200 `{ message }` in every valid case.
  - 400 on an invalid body (the existing validation envelope).
  - 429 only from the gateway's IP limiter (not per account).
- **New event `VerificationEmailRequested`** (auth → notification), payload as in decision 7. Delivery semantics are the same as `UserRegistered` today: publish after commit, at most once per request.
- **No change to existing endpoints.** The web additionally reads `instructor_id` and `instructor_name` (already returned) and passes `sort` to `/search` (already supported).

## Steps
- [x] 1. Branch `feat/public-learner-pages` from `origin/main` @ `ebc1eba` (6a and 7a merged) in the `ethi0-web` worktree. Merge `origin/main` again before the PR (step 11).
- [ ] 2. `categories.ts` `group` and `am` labels, `categoryMeta`, plus `CourseCover` and `hasRealThumbnail`; `CourseCard` uses them (7a already moved its price to `formatETB` and its category to a label; keep those, and switch to `categories.ts`'s label per decision 1); demo seed keeps its thumbnail line (A1) and adds one course with an Amharic title, for the OG font check in step 9 (decision 1).
  - **Amharic category labels** (the native-speaker review flags these): programming ፕሮግራሚንግ, web_development የድር ልማት, design ግራፊክ ዲዛይን, video_editing ቪዲዮ ኤዲቲንግ, data_science ዳታ ሳይንስ, tech ቴክኖሎጂ, business ቢዝነስ, marketing ማርኬቲንግ, freelancing ፍሪላንሲንግ, finance ፋይናንስ, language ቋንቋ, healthcare ጤና, agriculture ግብርና, arts ጥበብ እና ሙዚቃ, education ትምህርት, other ሌላ. Business and other match the i18n `cat_*` strings the pills already show (drift D8). The review list also names the five `cat_*` keys.
  - **vitest:** `hasRealThumbnail` (null, placehold.co, a real URL); every category has a `group` and an `am` label; `categoryMeta` of an unknown value is the `other` entry; for the five `cat_*` values, `am` equals the i18n string.
- [ ] 3. Course page layout, byline, buy box with pricing-aware bullets, bottom bar, preview rule (decision 3); per-course OG image (decision 2).
  - vitest for the bullets per pricing type and the preview rule.
- [ ] 4. Lesson player states, deferred `<video>`, mobile order and disclosure, completion and certificate link, `aria-current` (decision 4); `ReviewBox` (decision 9).
  - vitest: not-found for a 404 **and** for a 400 (malformed ID, drift D1), not-enrolled, Start/Resume button, certificate found vs missing, radiogroup keyboard and the disabled Submit.
- [ ] 5. `not-found`, `error`, `global-error` and the two `loading.tsx` (decision 5); `PanelError` on the panels and the account page; `.skeleton` dedupe (decision 6).
- [ ] 6. **API:**
  - two auth migrations and the entity column (data model);
  - `ResendVerificationDto`, the controller route, `AuthService.resendVerification` with the caps;
  - the `VerificationEmailRequested` contract type, the notification subscription, and the shared `verificationEmail` helper;
  - the gateway `auth-strict` regex and its spec (decision 7).
  - jest (notification): `VerificationEmailRequested` sends one email with the link, logged under that event type.
  - **Concurrency test against a real Postgres:** 5 parallel resends for one unverified user → exactly 1 new row and 1 event (round-1 B1). No api jest test uses a real DB today, so this is either a jest spec that runs only when `TEST_DATABASE_URL` is set (run locally and in the CI e2e job), or a node script in the e2e job that counts rows. **It never goes through the gateway** (drift D6): 5 calls would overflow the `auth-strict` budget the Playwright suite and `e2e-smoke.mjs` share. Prefer the jest spec; a script calls the auth service's own port directly.
  - jest: unknown email → no row, no event, same message; verified user → nothing sent; suspended user → nothing sent; first resend → row plus a `VerificationEmailRequested` event with a new token (and no `UserRegistered`); a second within 60 s → nothing; a sixth in 24 h → nothing; an invalid email → 400; the gateway classifies the route as `auth-strict`.
  - Migrations (house pattern, later timestamps, entity `@Index`, ordering after 6a: see the data model): `migration:run` then `migration:revert` twice, then run again, on a scratch DB; `pnpm -C api db:check` → no drift.
- [ ] 7. **Web for resend:** "Resend email" on the signup success screen (it already knows the email), on the verify-email error state (email `Field`), and next to the login "Email not verified" error. Each has a 60 s client cooldown, which starts on mount on the signup success screen because the signup email counts toward the 60 s cap (round-1 N1); a `FormStatus` result; plus "Go to login".
  - vitest for the cooldown and the message.
- [ ] 8. Catalog sort, `aria-pressed`, mobile disclosure, result line (decision 8); password rule and checklist (decision 10); emoji → lucide on public and learner pages (P2-35).
  - vitest: the sort param round-trips; the password table (client vs server rule); `PasswordStrength.test.tsx` updated to the new rule; signup and accept-invite refuse a password that isn't `ok` (drift D5).
- [ ] 9. **Playwright:**
  - course page at 375 px: the buy box's primary button is within the first viewport; after scrolling the syllabus, the bottom bar is visible and focuses the buy box's button. At 1440 px, Phase 5's `layout.spec.ts` sticky test keeps passing; update it rather than adding a second one (drift D2);
  - a course without a thumbnail shows the cover, and `/courses/<id>/opengraph-image` returns a PNG; one seeded course with an Amharic title renders its OG image, and the PNG is saved into the after-folder for the user;
  - the lesson player at 375 px: the lesson list starts above the assessments panel; tabbing from the player controls reaches the lesson list next; no `<video>` before a lesson is chosen; "Start lesson 1" gives the `<video>` a `src` or an HLS `blob:` source; an unknown course ID **and `/learn/not-a-uuid`** show "Course not found" (drift D1);
  - `/does-not-exist` shows the branded 404 with a search form; `cold-start.spec.ts` asserts the new heading's absence instead of `Page not found` (drift D3);
  - resend, inside `copy.spec.ts`'s existing signup test (drift D6): after "Check your email", pass the on-mount 60 s cooldown with Playwright's `page.clock` (installed before `goto`), click Resend, see the status message, and see the button disabled again. The server answers the same 200 whether or not its own 60 s cap sent, so the message is the assertion. That's +1 `auth-strict` call, so the suite spends 8 of 10. 7a's error-state scan stubs its login, so it adds none. Update the budget comment in `playwright.config.ts`;
  - catalog: choosing "Newest" puts `sort=new` in the URL, and the order changes accordingly against the seeded data;
  - the 7a axe gate is extended to the course page at 375 px, the lesson player empty state, the 404 page, and the verify-email error state.
- [ ] 10. Before/after screenshots of the course page (free, freemium, paid), catalog, home cards, lesson player (empty, playing, completed), 404 and verify-email, at 375 and 1440, light and dark, into `docs/plans/2026-10-02-refinement-audit/screenshots/after-phase7b/` (git-ignored).
- [ ] 11. **Full gate:**
  - `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck`;
  - `pnpm -C api db:check`;
  - `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`;
  - the Playwright suite against the local stack, in Phase 5's build order;
  - **before the PR:** `git merge origin/main` (it brings 6a, and 6c/6b if merged). Resolve auth `migrations/index.ts` (6a's first) and 6a's account/password page (gate on `ok`), then rerun the migration round trip, `db:check`, web vitest (6a's `page.test.tsx` included) and the Playwright suite (drift D4, D5);
  - CI `api`, `web` and `e2e` jobs green on the PR.
- [ ] 12. Code review by ethio-plan-review; the user approves push and PR.

## Test plan
- **jest (auth):** the resend matrix and the gateway classification (step 6).
- **vitest:** covers, thumbnail rule, course page bullets and preview rule, player states, review radiogroup, resend cooldown, sort param, password table (steps 2–8).
- **Playwright:** step 9, plus the 7a and Phase 5 suites still green.
- **Migrations:** run, revert and re-run on a scratch DB, then `db:check`.

## Rollout and ops
- **Deploy order:** auth migrations run at service boot (Phase 2), so the auth deploy adds the column and index before the web deploy calls the new route. Events go to a fanout exchange, and every service's durable queue already receives every event. The old notification code acks events it has no handler for (`event-bus.service.ts:137-149`), so a resend made while the new auth is live but the old notification still runs is silently dropped. Render deploys the services from one push within minutes of each other. The window is short and the learner can press Resend again after 60 s, so this is accepted rather than adding deploy ordering. The rollout note in the PR says so. A web deploy that lands first only exposes "Resend" buttons that get a 404 from the gateway until auth deploys. The web treats any non-200 as "Couldn't send right now. Try again in a minute", so that window is harmless.
- **Email volume:** bounded by the caps (5 per account per day) and by `auth-strict` (10 per minute per IP).
- **Production data:** courses with `placehold.co` thumbnails switch to generated covers on deploy. No data change.
- **Logging:** the resend path logs `resend_verification` with `user_id` and the outcome (`sent`, `capped`, `already_verified`, `inactive`, `unknown`), never the email (P1-21 discipline).

## Risks and open questions
- **Amharic labels** need the native-speaker review the user asked for. They're isolated in `categories.ts`, so a correction is a one-line change.
- **Concurrency with Phase 6b:** 6b changes `markComplete`, the heartbeat and the "Mark complete" 409 message in the same lesson-player file. Whichever merges second rebases. This phase restructures layout and states, not the progress calls, so conflicts are mechanical.
- **`opengraph-image` cost on a cold start:** a crawler hitting a sleeping API gets the generic card (decision 2). That's acceptable.
- **The bottom bar and Phase 5's `WakingUpNotice`** both sit at the bottom on mobile. The notice stacks above the bar (`bottom` offset by the bar height while the bar is visible), and Playwright checks they don't overlap.

- **A1 (amendment after approval, 2026-10-02, from ethio-impl):** step 2 originally had the demo seed write `thumbnail_url: null`. `submitBlocker` refuses to submit a course without a thumbnail (`course.service.ts:680` on main: "Thumbnail is required before submitting"), so every seeded course would stay a draft and break demo-seed and CI e2e. Decision: keep the seed's `placehold.co` URL; `hasRealThumbnail` already treats it as missing, so the cover shows. Relaxing the submit rule was rejected: it's an API and product change outside this phase. If `feat/sample-content` has merged first, the seed's course list (`COURSES`, `buildSections`) lives in `scripts/lib/sample-catalog.mjs`. Add the Amharic-titled course in `demo-seed.mjs` only, not the shared catalog, because `scripts/sample-content.mjs` publishes that catalog on production (plan-review round-3 note).

## Progress and deviations (implementer)
