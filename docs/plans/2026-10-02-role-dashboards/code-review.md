# Code review: Phase 8a (admin console, shared dialog, leave)

## Round 1 (2026-10-03) · Verdict: APPROVED
Reviewed `ff1d89e..b1a6044` on `feat/role-dashboards-a`, head `7e036c2` (origin/main with 6b merged in), against the plan's 8a scope and its Progress deviations. I read the API changes, `ConfirmProvider`, `SearchPicker`, the invites/Leave page, the learner refund and account delete myself. A `feature-dev:code-reviewer` pass covered `admin/page.tsx`, `growth-tabs.tsx`, `coupon-manager.tsx`, `Pager`, `Bars` and `EmptyRows`.

Run in my own detached worktree `../ethi0-8a-review` at `7e036c2`:
- `pnpm -C api build --force`: passes;
- `pnpm -C api test`: 67 suites, 1255 passed, 1 skipped;
- `pnpm -C web typecheck`: passes;
- `pnpm -C web test`: 72 files, 643 passed;
- `pnpm -C web build`: passes (`/admin` 9.94 kB, `/account/invites` 4.44 kB). `web` has no `lint` script.
- I didn't rerun Playwright or the e2e scripts; the planner's gate records them at `eec6fb0`.

What holds:
- **Every money-moving or destructive action asks first and stops on Cancel/Escape:** bank transfer, run payouts, release, refund approve and deny, fraud resolve, suspend and ban, unlist and archive, broadcast, wallet adjust, coupon deactivate, the learner refund, account delete and leave. Each has try/catch into `FormStatus` and a busy guard. The wallet title and payload use the same signed value. The suspend and ban reason is forwarded.
- **`ConfirmProvider`:** `showModal` in an effect, focus by tone or reason, `cancel` → `false`, and a second call resolves the first `false` while keeping the original return-focus target. Confirm is disabled until the reason meets `minLength`. The learner refund's 5-character minimum matches the DTO.
- **API:**
  - `leave` is one conditional update scoped to `user_id` and `active|suspended`, so the 404 is the same for "not yours" and "not leavable", and it's audited. The route uses `@UuidParam`.
  - The user search escapes `\ % _`, caps `q` at 100, ignores an array `q`, and keeps the role filter on both OR branches.
  - `listPending` adds amount and title with one `In()` query.
  - No migration.
- **Pagination and tabs:**
  - the Users key includes term and page, the page resets on search, and `keepPreviousData` is used;
  - `?tab=` is read inside `Suspense` and an unknown value falls back;
  - the Coupons tab is `enabled: ready && !isAdmin`;
  - the own row hides Suspend and Ban.
- **The planner's rulings are sound:**
  - `aria-disabled` plus a busy guard keeps focus;
  - the wallet picker searching all roles fits the model: a wallet is keyed by `user_id` with no role restriction;
  - the refund reason's 500 cap is within the DTO's 1000;
  - `holdReasonLabel` is needed for the release dialog.
- **Not over-engineered:** every new piece traces back to a decision (`useConfirm`, `SearchPicker`, `Pager`, `EmptyRows`, `useDebouncedValue`), and there are no new dependencies.

### Blockers
None.

### Should-fix
None.

### Nits (optional)
- **N1. The admin coupon form keeps the course picker after a create** (`coupon-manager.tsx`, the create success path). The next coupon is scoped to the same course unless the admin clears the chip. Clear `adminCourse`, and `course_id` in the form, on success.
- **N2. The admin's own row shows Suspend and Ban until `me` loads** (`page.tsx`, `isMe`). The API refuses anyway. Hide the row actions until `me` is set.
- **N3. `SearchPicker` moves focus whenever `selected` changes, including when the parent resets it after a success** (the bank transfer and the wallet). Focus then jumps to the learner input, away from the button the admin just used. The `FormStatus` live region still announces the outcome, so only the focus jump is the nit. Move focus only from the picker's own pick and clear handlers.

---

# Code review: Phase 8b (educator, institution, QA and preview)

## Round 1 (2026-10-03) · Verdict: APPROVED (no blockers; two should-fixes, both small)
Reviewed `git diff origin/main...d741137` on `feat/role-dashboards-b` (merge-base = `origin/main` `03fd049`, so 8a, 6b and 6d are already in) against steps 5, 6 and 8, the 8b parts of step 9, and the "### 8b" deviations. I read the institution page, `bulk-purchases`, `instructor-manager`, `institution/review`, `qa`, preview, `Bars`, `PageChrome`, the bell, the API copy and the e2e changes myself. A `feature-dev:code-reviewer` pass covered the editor files (`teach/courses/[id]/*`, `/teach`, `/teach/new`, `/teach/analytics`), and I checked its findings in the code.

**Gate (my run, review worktree `../ethi0-8b-review` detached at `d741137`, frozen lockfile):**
- web typecheck: clean. web vitest: 76 files, 661 passed. web build: OK.
- api build: OK. api jest (whole workspace): 67 suites, 1281 passed, 1 skipped.
- Native-dialog grep (`git grep -nE '\b(window\.)?(confirm|alert|prompt)\(' web/src`, tests excluded): no matches. The app-wide acceptance holds.
- I didn't rerun the stack parts (db:check, e2e scripts, Playwright, images) because the local stack belongs to 9a until about 22:30. impl reports them green on the merged head, and there is no migration.

**Does what the plan says:**
- **Confirms (decision 3, educator and institution):** unpublish and archive, remove section and lesson, replace outline, discard staged changes, restart a mismatched upload, institution unlist (default tone), instructor suspend (optional reason, max 500) and remove, bulk assign (lists the de-duplicated, lower-cased emails), and QA decisions with `opt.confirm`. Every `ask` returns before any request or busy flag. The Cancel tests assert against the paths the code really calls, so they aren't vacuous.
- **No silent failure:** every former `alert`/bare `catch` now goes to a per-card `FormStatus` error. `setOk` runs only after the awaited call. Busy flags clear in `finally` or on every path, including `AssessmentManager.save`'s early return. `InstitutionSetup` keeps `location.reload()` on success and shows the error otherwise.
- **Removed rows show `status_reason`** (drift D4), with a test.
- **Preview (decision 13):** the overlay, the poster, `aria-current` with a visible active style, `h2` sections and `statusLabel`, with a test. Showing "Preview as learner" for drafts is backed by the owner `GET /courses/:id` check (deviation noted).
- **Bars on phones:** every other month (January always), only the tallest value; the sr-only text keeps all twelve. `grid-cols-1` fixes the 23 px min-content overflow.
- **API copy:** create and `assertPricing` no longer name `price_etb`. The submit blocker string is unchanged and still covered by `course.service.spec.ts:1122`.
- **e2e:** `ownCourseId` creates a draft when the seeded educator has none, and the overflow checks wait for `networkidle`. Both are reasonable.
- **Complexity:** no new component, hook, endpoint or dependency beyond what 8a shipped. Nothing extra.

### Blockers
None.

### Should-fix
- **S1. Removing a tutor note on a draft course has no confirm** (`course-tools.tsx:211`). `noteRemoval` (`working.ts:399`) returns `confirm: null` when the course isn't live, and the click only asks `if (removal.confirm && …)`. On a draft, one click on "remove" sends the DELETE, and the note is gone. Decision 3 lists "remove a tutor note ✱" without a condition. This is inherited from main's `window.confirm` gating, not new, but this phase is the one that promises it.
  **Fix:** always `ask`. When `removal.confirm` is null, use a body like "Removes it from the course tutor. This can't be undone." Add a Cancel case for a draft in `page.test.tsx`, or wherever the note-removal test lives.
- **S2. Removing a quiz option can move the correct answer to a different option** (`teach/courses/[id]/page.tsx:517`). This is pre-existing, but 8b rewrote this line. `correct_index: Math.min(x.correct_index, x.options.length - 2)` doesn't shift the index when an option above it is removed. For example, take options A, B, C, D with C correct. Remove A: the options become B, C, D, the index stays 2, and the key now marks **D**. The radio does show the change, but nothing draws attention to it, so the quiz can be saved with the wrong key and learners are graded against it.
  **Fix:** `correct_index: oi < x.correct_index ? x.correct_index - 1 : oi === x.correct_index ? 0 : x.correct_index`. Removing the correct option itself then falls back to the first option; today it silently becomes the next one. Add one vitest.

### Nits (optional, no new round)
- **N1.** The bulk-assign dialog counts every typed token, including invalid emails and emails that already have a seat, so the title can say "Assign 5 seats" while the API assigns 3, or answers "Only N seat(s) left". The API is the authority and its message is clear, so this is cosmetic.
- **N2.** The buttons using `aria-disabled` plus a busy guard (QA decisions, instructor rows, institution Unlist and Restore) have no busy look, because `.btn*`'s disabled styles key on `:disabled`. An `aria-disabled:opacity-50` (Tailwind's `aria-disabled:` variant) on those would fix it; 8a's Users rows have the same gap (`globals.css` has no `aria-disabled` rule).

### Round 1 response (impl, 8b)
- **S1: fixed.** A tutor-note removal always asks. On a draft the body reads "Removes it from the course tutor. This can't be undone." A new vitest checks that Cancel on a draft sends nothing.
- **S2: fixed.** Removing an option above the correct one moves `correct_index` down by one. Removing the correct option falls back to the first. A new vitest (C correct of A–D, remove A, the key stays on C) fails on the old line and passes now.
- **N1: deferred.** The API is the authority, and its "Only N seat(s) left" message is clear.
- **N2: fixed** with one rule in `globals.css`: `[aria-disabled='true']` on `.btn`, `.btn-secondary`, `.btn-danger` and `.btn-ghost` gets `cursor-not-allowed opacity-50`. 8a's Users rows get it too.
- **Tests:** web typecheck; vitest 663/663; web build ok.
