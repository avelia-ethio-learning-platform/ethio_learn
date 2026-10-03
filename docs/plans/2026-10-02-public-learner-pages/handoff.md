# Handoff: Phase 7b, public and learner pages

From ethio-planner to ethio-impl (or `ethio-impl-web` in its own git worktree, if the user adds one)
Plan: [plan.md](plan.md) (approved in round 2, see [plan-review.md](plan-review.md); round-2 S5 is folded into decision 2; the 2026-10-03 drift check D1–D8 is folded in, marked "(drift Dn)")
Code review goes to: ethio-plan-review (size M)

## What to build
- **Web:**
  - generated course covers and a per-course OG image;
  - a course page that decides in the first screen on a phone (byline, buy box, bottom bar, honest preview and bullets);
  - a lesson player that works on a phone and never dead-ends;
  - branded 404, error and loading pages, and per-panel errors;
  - catalog sort and mobile filters;
  - a review radiogroup and a password checklist that matches the server.
- **Small API change:** `POST /api/v1/auth/resend-verification`, enumeration-safe and capped per account under a row lock, with a new `VerificationEmailRequested` event that the notification service turns into the existing verification email.

## Read first, in order
1. **`plan.md`:** decisions 1–10, the data model and the API contract. Then `plan-review.md`:
   - round 1 B1: why the resend cap check holds a `FOR UPDATE` lock on the user row;
   - S1: the lesson player's state order;
   - S2: why the filters use a button, not `<details>`;
   - S3: the Satori layout and the Ethiopic font;
   - S4: why the lesson list sits between the player and the panels in the DOM;
   - round 2 S5: how the fonts must be read so they ship with the route;
   - the drift check (2026-10-03): D1 (a malformed course ID is a 400, which must still show "Course not found"), D2/D3/D6 (Phase 5 specs and the `auth-strict` budget this phase must keep working), D4 (auth migrations after 6a's), D5 (all three password callers), D7/D8 (one source for category labels).
2. **The 7a plan** (`../2026-10-02-ui-foundations/plan.md`): this phase uses its `Field`, `FormStatus`, `labels.ts`, `format.ts`, the `text-white/80` rule for always-dark surfaces, and the axe gate.
3. **The Phase 5 plan** (`../2026-10-02-web-p0-fixes/plan.md`), decisions 1 and 7:
   - the `serverApi` result type and `WakingUp`, which the course page, the OG image and the player's error states reuse;
   - `overflow-x: clip`, which makes the sticky buy card work.
4. **The visual direction**, studies 1 and 2: https://claude.ai/artifact/1KNuTFQ4NeRfsnuAJTxj5k.
5. **Existing code to build on:**
   - `api/services/auth/src/auth.service.ts` `requestPasswordReset`: the enumeration-safe pattern;
   - `api/services/auth/src/migrations/*Membership*`: Phase 3's column-plus-index migration pair to copy;
   - `api/services/course/src/course.service.ts` `publicDetail`: it already returns `instructor_id` and `instructor_name`;
   - `search`: it already supports `sort`.

## Decisions already made (don't relitigate)
- **Covers:** the cover is CSS (`CourseCover`); the OG image is its own Satori layout sharing colours and labels from `categories.ts`. `placehold.co` thumbnails count as missing, with no data migration. The demo seed **keeps** its `placehold.co` URL (plan amendment A1: course submit requires a thumbnail); if `feat/sample-content` merged first, the seeded course list is in `scripts/lib/sample-catalog.mjs`; add the Amharic test course in `demo-seed.mjs` only, since the shared catalog is published on production.
- **OG image:** it always uses the generated design (not the uploaded thumbnail), with a generic card when the API is unavailable.
- **Buy box:** one component, rendered once and placed by grid. The bottom bar focuses the buy box's button; it has no enroll logic of its own.
- **Resend:**
  - always 200 with the same message;
  - the caps (1 per 60 s, 5 per 24 h, active and unverified users only) are counted from `email_verifications.created_at` under a user-row lock, and the event is published after commit;
  - it uses a new `VerificationEmailRequested` event, not a second `UserRegistered`;
  - older links stay valid until they expire.
- **Accepted deploy-window risk:** a resend made while the new auth is live and the old notification still runs is acked and dropped (fanout plus "ack unknown events"). No deploy ordering.
- **Out of scope:** educator names on catalog cards (Phase 9 batching), `next/image` (Phase 10), and payment-flow polish such as P2-01 and P2-02.

## Gotchas learned while planning
- **No real-DB jest tests today:** the resend concurrency test is new ground. Gate a jest spec on `TEST_DATABASE_URL`, or write an e2e script that counts rows. Through the gateway, it must fit the `auth-strict` per-IP budget comment in `playwright.config.ts` (Phase 5).
- **Satori:** inline styles and flexbox only, no pseudo-elements, no Tailwind. Fonts are read with `new URL(..., import.meta.url)`, or the standalone/Vercel build won't contain them. Check `.next/standalone` after `BUILD_STANDALONE=1 pnpm -C web build`.
- **Amharic category labels** are in plan step 2 and need the native-speaker review the user asked for. They live in `categories.ts`. The five i18n `cat_*` keys the pills already use keep their strings, which a vitest pins equal to `categories.ts`, and they join the review (drift D8).
- **6a isn't below this branch** (drift D4, D5): its auth migrations (`…397-InvitedAt`, `…398-InvitedAtIndex`) and its account/password rewrite arrive only through `git merge origin/main`. Give this phase's migrations later timestamps and list them after 6a's in `index.ts`. Until 6a is merged in, run `db:check` and the migration round trip on a scratch DB, because the shared local DB may already hold 6a's column.
- **Phase 5 specs to keep green:** `layout.spec.ts` (sticky buy card: the page's only `<aside>`, sticky card as first child), `cold-start.spec.ts` (point its 404 check at the new heading), and the `auth-strict` budget comment in `playwright.config.ts` (the resend adds 1, so 8 of 10).
- **Phase 6b** edits `markComplete`, the heartbeat and the "Mark complete" 409 message in the same lesson-player file. Whichever merges second rebases; keep this phase's player changes to layout and states.
- **The 60 s cooldown** on the signup success screen starts on mount: the signup email already used the per-account 60 s slot.
- **Environment:**
  - Node isn't on PATH: `export PATH="/home/kal/.local/opt/node22/bin:$PATH"`.
  - pnpm installs need `--store-dir /home/kal/snap/code/current/.local/share/pnpm/store/v3`.
  - The secret-guard hook scans untracked files, so never paste `.env` values into notes.
  - Restart web by killing the `next-server` PID, never with a `pkill -f` pattern.
- **Commit the plan folder:** it isn't in `.git/info/exclude`, so commit it on your branch.
- **Worktree ports:** in `ethi0-web`, web runs on :3200 (cold twin :3300) with `E2E_WEB_PORT`/`E2E_COLD_PORT`. The resend endpoint needs a stack window from ethio-impl, because the worktree's own auth build has to run on the shared stack's ports. See 7a's handoff, Branch → Parallel run.

## How to run
- API: `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck`; then `pnpm -C api db:check` with the stack up.
- Migrations on a scratch DB: per service, `migration:run`, `migration:revert` twice, `migration:run` (Phase 2's README workflow).
- Web: `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`; also `BUILD_STANDALONE=1 pnpm -C web build` for the font check.
- Browser: `pnpm -C web exec playwright test`, with the local stack up and web on :3000, in Phase 5's build order.

## Branch
`feat/public-learner-pages` from `origin/main` @ `ebc1eba` (2026-10-03: 6a merged as PR #24, 7a as PR #25), in the `ethi0-web` worktree. ethio-planner implements it there (same method as 7a). 6a's auth migrations and account/password page are already on the base, so this phase's migrations go after `…398-InvitedAtIndex` in `index.ts` from the start, and the password change gates on `ok` in all three callers directly. Before the PR, `git merge origin/main` once more (6c or 6b may have landed) and rerun the migration round trip, `db:check`, vitest and Playwright. Push, PR and the `--merge` merge on green CI plus an APPROVED code review are covered by the user's standing authorization (`~/.claude/CLAUDE.md`).

## Definition of done
- Acceptance criteria met.
- API build, tests, typecheck and `db:check` pass.
- Migrations run, revert and re-run, listed after 6a's, with `db:check` clean after the pre-PR `origin/main` merge.
- Web typecheck, vitest, build and standalone font check pass.
- Full Playwright suite passes, with the 7a axe gate extended.
- Screenshots and the Amharic OG PNG are saved for the user.
- Plan checklist ticked and deviations logged.
- Then ask ethio-plan-review for code review.
