# Phase 7c code review (ethio-plan-review)

## Round 1 (2026-10-07) · Verdict: APPROVED (no blockers; please fix S1 in the same commit, a one-class change; N1–N2 optional)
I reviewed the **uncommitted** worktree `../ethi0-7c` (branch `feat/color-system`, HEAD `043e6fd`): `git diff 043e6fd` (57 tracked files) plus the two untracked guards, `web/src/lib/color-tokens.test.ts` and `web/src/lib/no-raw-colors.test.ts`. I checked it against the plan, its 6 deviations, Fixes A and B, the `.brand-fill` follow-up, and `../ethi0-11d/docs/COLOR_SYSTEM.md`.

**What I ran** (my detached snapshot `../ethi0-7c-review`: `043e6fd` plus the diff and both untracked files, with 61 status lines matching the impl's; frozen installs, clean env):
- **Gate:** `pnpm typecheck && pnpm test && pnpm build` exit 0.
  - typecheck is clean;
  - vitest: 84 files, 742 tests pass;
  - `next build` succeeds.
  - First-load sizes are unchanged from Phase 10: `/` 128 kB, `/courses/[id]` 124 kB, `/learn/[courseId]` 142 kB. `/teach/courses/[id]` is 159 kB, and shared is 87.7 kB.
- **The guards aren't vacuous.** I made three mutations in my snapshot, then restored it:
  - `text-red-600` in `PanelError.tsx`;
  - an inline `#ff0000` in `PanelError.tsx`;
  - light `--rating` set to `#fbbf24`.

  Each mutation failed its test with a precise message: `PanelError.tsx:21 text-red-600`, `PanelError.tsx:21 #ff0000`, and `--rating on page: 1.67 < 3`. Restored, all 51 tests pass.
- **Spec values:** the 16 status text and solid values (light and dark), `--rating`, `--muted-foreground`, `--input-border` and `.btn-danger` all match COLOR_SYSTEM.md's tables.
- **Playwright** wasn't rerun. The impl's recheck on a fresh stack covers it: `a11y.spec.ts` 38/38, and the full suite at 131 passed, 1 skipped. S1 is a case axe can't see (a gradient background makes the check incomplete), so a rerun wouldn't have caught it either.
- **Screenshots:** before and after are 32 each. I looked at `home-dark-1440` (hero, chips, stat tiles, cards) and `exam-light-1440`. They match the impl's notes.

### Blockers
None.

### Should-fix
- **S1. The timestamp in your own chat bubble drops below AA.** In `messages/page.tsx:195`, the "mine" bubble is now `.brand-fill` (`#1d4ed8`→`#2563eb`, 135°), and its timestamp is `text-white/85` at `text-xs`.
  - The timestamp is right-aligned at the bottom of the bubble, which is the gradient's light `#2563eb` end. There, 85% white measures **4.19:1**, under 4.5:1. Before 7c it was `text-blue-100` on `bg-blue-700`, at 5.49:1, so this is a regression in the phase that pins contrast.
  - axe reports gradient backgrounds as incomplete, not as violations, and `color-tokens.test.ts` checks only solid white on `.brand-fill`. Nothing catches it.
  - **Fix:** `text-white` (5.17:1 at the light end). `text-white/90` would land at 4.50 exactly, too close to the line.
  - The other `text-white/85` lines are fine: the hero sub-line, the search icon and the help banner sit on `.brand-panel`. Its lightest stop is `#1d4ed8`, where 85% white is 5.30:1, and it's darker in dark mode. The hero placeholder (`white/75` on the `white/10` field) goes from 2.49:1 to 3.81:1, an improvement.

### Nits (optional)
- **N1.** The follow button (`educators/[id]/follow-button.tsx:44`) is `brand-fill hover:brightness-110`. On hover, white text at the light end drops to 4.45:1. `.btn` uses `brightness(1.05)` (4.77:1). `hover:brightness-105` would match it.
- **N2.** `home-client.tsx:194` is a template literal with nothing left to interpolate (`` className={`… rounded-xl brand-fill`} ``), and the stats array has `icon: Wallet, }` trailing commas. Both are left over from dropping `stat.gradient`. Make it a plain string and tidy the objects.

### Checked, no finding
- **Tokens:**
  - `status()` in `tailwind.config.ts` is four lines giving `DEFAULT`/`soft`/`line`/`solid`;
  - the roles are channels, so `/opacity` still works;
  - `.badge-*` has no `.dark` overrides left;
  - `.progress-fill` is solid `brand-600`;
  - `accent-color` is set.
- **Migration** (I read every changed line):
  - text pairs map consistently to `text-danger|warning|success`, and callouts to `-soft` with `-line`.
  - Star **glyphs** (`'★'.repeat`) use `text-warning`, which reaches 4.5:1 as text, and star **icons** use `fill-rating text-rating`, which reaches 3:1 as graphics. That split is right.
  - The exam page's light-only states (`bg-red-50`, `bg-amber-100`, `bg-green-100`, with no dark variants) were wrong in dark mode before. Now they're roles, a fix that comes free with the migration.
  - So is `ConfirmProvider`'s `dark:text-gray-400`.
- **Deviations 1–6:** all reasonable. `.brand-panel`'s dark variant and the `--brand-50`/`--brand-700` pin keep the dark hero's look, which is a non-goal to change. Rank 3 losing bronze is fine, because the rank number is printed. The Free tag on `bg-gray-50/95` reaches 4.9:1 or more on every cover.
- **No over-engineering:**
  - `.brand-fill` traces to the dark-mode screenshot finding;
  - `.badge-count` traces to the "no text on a solid" rule plus the camera tag;
  - the two guards are decision 6.
  - Nothing else was added.
- **Guard scope:** palette classes and hex values in `web/src/**/*.{ts,tsx}`, as planned. The only inline `rgba()` left is the hero's decorative grid lines (`home-client.tsx:90`).
- **e2e additions:**
  - `draftWithLesson` checks for an existing lesson before it creates one, so reruns don't keep adding lessons. `layout.spec` and `csp.spec` open the same draft and don't assert on an empty state.
  - The exam page sends `POST /assessments/:id/attempts` only from `start()` (exam `page.tsx:171`). So the two theme visits to the intro don't use up the learner's attempts.
- **Merge prerequisites:** none from the user (no env vars). Before the PR:
  - merge `origin/main`, which is now at `40c40f2` (#48), and 11d hasn't merged yet;
  - run `pnpm -C api build && node scripts/lint-check.mjs`;
  - step 9 (the COLOR_SYSTEM.md rows for `.badge-count`, `.brand-fill` and the `.brand-panel` dark variant) goes in whichever of 7c and 11d merges second.
- **Commits:** per today's cap, this file stays uncommitted. Please include it in 7c's single commit.

### Round 1 response (ethio-impl, 2026-10-07)
- **S1: fixed.** The "mine" timestamp is `text-white`, 5.17:1 at the `#2563eb` end.
  - I checked the other `text-white/85` uses, and all sit on `.brand-panel`: the hero subtitle, the hero search icon and the help banner text. White/85 holds 5.28:1 at its lightest end (`#1d4ed8`), and more on dark.
  - So only `.brand-fill` had the problem.
- **N1: taken.** `hover:brightness-105`, as on `.btn`.
- **N2: taken.** The stat tile is a plain `className` string, and the stats objects lost their trailing commas.
- **After the fixes:** tsc clean; vitest 84 files, 742 passed.
- **Still uncommitted:** per the commit cap, this all goes into 7c's single commit tomorrow. Before the PR, I merge `origin/main` and run `pnpm -C api build && node scripts/lint-check.mjs`.

### Fixes checked (ethio-plan-review, 2026-10-07)
I read the fixes in `../ethi0-7c`, now based on `40c40f2`. Still APPROVED, with no round 2:
- **S1:** the "mine" timestamp is `text-white` (`messages/page.tsx:195`).
- **N1:** the follow button uses `hover:brightness-105`.
- **N2:** the stat tile is a plain string, and the trailing commas are gone.
