# Phase 7c: Color system

Status: implemented, in code review (rebuilt 2026-10-18 on `feat/color-system` from `docs/contributor-docs`; the 2026-10-07 build was lost with its worktree). Code review goes to the Phase 7c reviewer.
Size: M (sessions: 3). ethio-impl implements; ethio-review-plan reviews the plan and the code. Web only: no API, migration or env change.
Base branch: `origin/main` once Phase 10 has merged. Phase 10 touches many of the same files (CourseCard, PasswordStrength, the auth pages, the course page), so an earlier start is from `feat/web-hardening`'s tip, merging `origin/main` once 10 lands. · Feature branch: `feat/color-system`
Spec: `docs/COLOR_SYSTEM.md` (Phase 11d). Until 11d merges, the spec is [../2026-10-03-contributor-docs/plan.md](../2026-10-03-contributor-docs/plan.md) decision 4 plus `contrast/palette-table.md` in that folder.

## Goal
The user asked on 2026-10-03 for the UI coloring to be "the best". 11d writes the color system down. This phase makes the code follow it:
- one set of named color roles;
- every text, boundary and graphic pair at WCAG 2.2 AA in light and dark;
- a guard so the system stays that way.

The look stays the approved visual direction (blue, slate, generated covers, the flag band as structure). The only visible changes:
- helper text is slightly darker;
- inputs get a visible border;
- chart bars are solid;
- rating stars are a deeper amber in light mode;
- status colors that were wrong in dark mode are right.

Acceptance criteria:
- **Tokens:** `globals.css` and `tailwind.config.ts` define the 11d roles in both themes:
  - `success`, `warning`, `danger` and `info`, each with text, `soft`, `line` and `solid`;
  - `rating`;
  - `input-border`;
  - the retuned `gray-500` and `muted-foreground`.

  The `.badge-*` classes use them.
- **No raw palette classes:**
  - `web/src` (excluding tests) has no Tailwind palette class (`text-red-600`, `bg-emerald-500/10`, `from-blue-950`, …);
  - no hex color outside the small allowlist of files that must hold literal colors (decision 6).

  A vitest guard enforces both and names each offender `file:line`.
- **Contrast is pinned:** a vitest test reads the token values from `globals.css` for both themes and checks every pair in COLOR_SYSTEM.md's table against its threshold: 4.5 for text, 3 for boundaries, focus and graphics.
- **axe in both themes on the role pages too:** `a11y.spec.ts` runs light and dark with zero serious or critical violations on:
  - its current pages;
  - `/teach`, an own course's editor `/teach/courses/[id]`, `/institution`, `/admin` (each tab), `/qa`, `/preview/[id]`;
  - the seeded quiz's exam route `/learn/[courseId]/exam/[id]`, on its intro screen before Start (Start begins the camera checks, which headless Chromium can't pass).
- **The existing suites stay green:** vitest, Playwright and the CI e2e scripts.
- **Before and after:** screenshots, light and dark at 375 and 1440 px, of:
  - Home, the catalog and a course page;
  - the dashboard and login;
  - the teach editor, admin and an exam page.

  They go in `docs/plans/2026-10-02-refinement-audit/screenshots/after-phase7c/` (git-ignored). The planner publishes a before/after page for the user.
- COLOR_SYSTEM.md loses its "7c" marks (whichever of 7c and 11d merges second does this).

## Non-goals
- New hues, a rebrand, or changing the category cover or flag colors. Those all pass already.
- Redesigning layouts, surfaces or the dark palette's backgrounds.
- Motion (Phase 12), fonts (Phase 10), Amharic strings.
- The OG image and `global-error.tsx` palettes. They render outside Tailwind and pass today; they're allowlisted.
- A design-token package, Storybook, or a Tailwind ESLint plugin. Two vitest files are the guard.
- Charts beyond today's single-series `Bars`. The doc gives the rule for multi-series charts when one is needed.

## Current state (at `origin/main` `f8e70bc`; Phase 10 changes some of these files first)
- `web/src/app/globals.css`:
  - brand and gray scales as RGB channels (`:root` and `.dark`);
  - `--muted-foreground` `#64748b` / `#94a3b8`;
  - `.input` border `var(--border)` (blue at 14% / 22%: 1.17:1 in light);
  - `.badge-success|warn|danger|info|neutral` with literal hex and rgba values;
  - `.btn` (a `#1d4ed8`→`#2563eb` gradient) and `.btn-danger` (`#b91c1c`);
  - the flag gradient `.gradient-ethiopia`.
- `web/tailwind.config.ts`: `primary`, `brand.*` and `gray.*` read the channels. There are no status colors.
- **Raw palette classes:** 362 in 51 files (`git grep -E '(text|bg|border|from|to|via|fill|ring|…)-(red|amber|emerald|green|blue|sky|slate|…)-[0-9]+'`). The top files:
  - `home-client.tsx` 22;
  - `preview/[id]/page.tsx` 19;
  - the exam page 16;
  - `teach/courses/[id]/page.tsx` 14;
  - `structure-generator.tsx` 10;
  - `video-upload.tsx` 7;
  - `admin/page.tsx` 7.

  The common shapes, by line:

  | Lines | Classes today | Becomes |
  |---|---|---|
  | 30 | `text-red-600 dark:text-red-400` | `text-danger` |
  | 23 | `text-amber-700 dark:text-amber-400` | `text-warning` |
  | 9 | `text-emerald-700 dark:text-emerald-400` | `text-success` |
  | 6 | `bg-amber-500/10 border-amber-400/40 text-amber-700 dark:text-amber-300` | `bg-warning-soft border-warning-line text-warning` |
  | 4 | the same callout in red and emerald | the danger and success equivalents |
  | 13 | `text-red-600`, `text-amber-700` or `text-green-700` with no dark variant (3.3–3.7:1 in dark) | the status text token |
  | 3 | `fill-amber-400 text-amber-400` (stars) | `fill-rating text-rating` |
  | 2 | `text-amber-500` (2.15:1 on white) | `text-warning` |
  | 1 | `bg-red-600` with white text on a button (`account/page.tsx`, delete) | `.btn-danger` (never text on a `*-solid` fill; dark danger solid is 3.76 with white) |
  | 2 | `bg-red-600` with white text on a count bubble (`NotificationBell`, `messages/page.tsx`) | `.badge-count`: a fixed `#b91c1c` with white text (6.47:1 in both themes). It sets only the colors, so the bubbles keep their own size classes. |
  | ~15 | `blue-*` washes and gradients (`dark:from-blue-950/30`, `from-sky-200 via-blue-100`, `from-blue-700 to-blue-900`) | `brand-*` tokens. Dark `brand-50` is `blue-950`. Always-dark brand panels use one `.brand-panel` class. |
  | 2 | `text-slate-900` | `text-foreground` |
  | 1 | `text-gray-400` text | `text-gray-500` |
- `web/src/components/Bars.tsx:46`: `bg-brand-500/80` (2.78:1 in light).
- Progress bars:
  - `.progress-fill` is a `#2563eb`→`#60a5fa` gradient on `.progress-track` (blue at 12%). Its light end is 2.21:1 on the track, and its dark start is 2.99:1. It is used in 6 places.
  - The lesson list draws its own `bg-brand-500` bar on `bg-gray-200` (2.98:1), with no printed number.
- `bg-gray-200` carries text in places (the educators page's rank badges). Today's muted text there is under 4.5:1 in light.
- `teach/courses/[id]/video-upload.tsx` (Phase 8b's `UploadVideoButton`): `text-brand-600` at `opacity-90` ("upload video") and `opacity-70` ("replace") fails axe color-contrast. It only renders on a lesson row. The suite's shared editor draft has no lessons, so it never ran there; Phase 10's run with a lesson found it.
- `web/e2e/a11y.spec.ts`: axe at zero serious or critical, light and dark, on the public, learner and account pages only. Role pages have no axe run.
- Literal hex lives in:
  - `categories.ts` (cover and band colors);
  - `brand-art.tsx` and `courses/[id]/opengraph-image.tsx` (Satori);
  - `global-error.tsx` (inline CSS, by design);
  - `manifest.ts` and `theme-script.ts` (browser-bar colors).

## Design and key decisions
1. **Status tokens as CSS variables.**
   - The text and solid roles are RGB channels, like `brand` and `gray`, so Tailwind alpha modifiers keep working. The soft and line roles are full `rgba()` values.
   - Tailwind: `success: { DEFAULT, soft, line, solid }`, and the same for `warning`, `danger` and `info`, plus `rating` and the `input-border` border color.
   - Classes: `text-success`, `bg-success-soft`, `border-success-line`, `bg-success-solid` / `fill-success-solid`.
   - Rejected: Tailwind's palette with `dark:` pairs. That is today's state, and 13 lines already forgot the dark half.
2. **Values are 11d's** (decision 4 there; the computed table is `../2026-10-03-contributor-docs/contrast/palette-table.md`). Status text and solid colors equal today's badge colors, so badges look the same.
3. **Retune `gray-500` rather than edit 287 call sites.**
   - `--gray-500` and `--muted-foreground` become `91 107 128` (`#5b6b80`) in light and `154 168 189` (`#9aa8bd`) in dark.
   - The scale stays ordered (light 400 `#94a3b8` < 500 < 600 `#475569`; dark 400 < 500 < 600 `#b2bfd2`).
   - Muted text passes on the page, secondary background, cards and gray-100 (min 4.97 light, 6.07 dark). It is a darker shade of the same slate.
   - On `gray-200`, `brand-100` or a stronger tint, helper text uses `gray-600` (COLOR_SYSTEM.md's rule). The migration applies it where text sits on those fills.
4. **Inputs:**
   - `.input`'s border becomes `var(--input-border)` (`#7c8ba1` / `#64748b`), and the focus border and ring are unchanged.
   - Native checkboxes and radios get `accent-color: rgb(var(--brand-600))`, so they match.
   - The catalog search box (`explore-client.tsx`) is a bare input inside a `glass-secondary` wrapper, so the wrapper takes `border-input-border`. The Home hero search stays `white/20`, because it sits on the always-dark brand panel.
   - Card and divider borders stay decorative blue (no 3:1 rule applies to them).
5. **Charts and progress:**
   - `Bars` uses solid `bg-brand-600` (5.00 light, 5.75 dark).
   - `.progress-fill` becomes solid `rgb(var(--brand-600))`, with no gradient (4.50 light and 6.07 dark on the track).
   - The lesson-list bar uses `.progress-track`/`.progress-fill` instead of its own `bg-brand-500` on `bg-gray-200`.
   - A bar in a status color (a failed upload, password strength) always prints its label.
   - A second series, when one is added, uses the category cover colors in a fixed order with direct labels. That rule is written down; nothing is built for it.
6. **The guard:** two vitest files in `web/src/lib/` (about 90 lines together).
   - `color-tokens.test.ts` parses the `:root` and `.dark` blocks of `globals.css` into a value map. It computes WCAG contrast (the standard formula, about 10 lines) for the documented pairs, compositing rgba soft colors over the page background first.
     - The pair list is a small table in the test that mirrors COLOR_SYSTEM.md's table.
     - A token change that breaks a pair fails with the pair, the ratio and the threshold.
   - `no-raw-colors.test.ts` walks `web/src/**/*.{ts,tsx}` except tests and fails on the Tailwind palette regex and on `#rgb`/`#rrggbb` literals outside an allowlist:
     - `lib/categories.ts`, `lib/brand-art.tsx`, `lib/theme-script.ts`;
     - `app/manifest.ts`, `app/global-error.tsx`, `app/(public)/courses/[id]/opengraph-image.tsx`.

     The message names `file:line` and points to COLOR_SYSTEM.md.
   - Rejected: an ESLint Tailwind plugin (a new dependency and config for one rule) and a Stylelint setup.
7. **Migration is mechanical where the table above covers it, and judged elsewhere.**
   - The impl does the table's shapes with careful search and replace, file by file, then reviews each remaining hit by hand against COLOR_SYSTEM.md's rules: decorative, brand panel, status, or text.
   - `.brand-panel` (the `#1d4ed8`→`#1e3a8a` gradient, white text, `text-blue-100` → `text-white/85`) replaces the always-dark hero and banner panels.
8. **axe on the role pages** reuses `a11y.spec.ts`'s `prefer(theme)` and `revealAll`, logged in with the stored educator, admin, QO and institution states. If Phase 11b has changed login to a per-test fixture by then, use that instead.

## Steps
- [x] 1. Branch `feat/color-system` (see Base).
- [x] 2. Tokens (decisions 1–4): `globals.css` variables in both themes, `tailwind.config.ts`, the `.badge-*` and `.input` rework, `accent-color`. · `pnpm -C web build`.
- [x] 3. `color-tokens.test.ts` (decision 6). Write it first against today's values and watch it fail on the missing tokens and today's five failing pairs (muted on gray-100, input border, chart bar, progress fill, star), then pass after step 2.
- [x] 4. `no-raw-colors.test.ts` (decision 6). Watch it fail with the 51-file list.
- [x] 5. Migrate the shared components first (`Bars`, the progress bars, `PasswordStrength`, `Field`, `PanelError`, `UploadProgress`, `Header`, `Footer`, `NotificationBell`, `CourseCard`, `CommentsSection`, `SkipLink`, `SearchPicker`, `RequireRole`, `CoursePreviewPlayer`), then each route group. Commit per group. · Step 4's test goes green at the end.
- [x] 6. axe on the role pages, light and dark (decision 8). Fix what it finds.
  - The editor run uses a draft with at least one lesson, so lesson-row controls like `UploadVideoButton` are checked.
  - Its fix is full-opacity text: `text-brand-600`, with `text-muted-foreground` for "replace", and no opacity on text.
- [x] 7. Gate:
  - `pnpm -C web test`, `pnpm -C web typecheck`, `pnpm -C web build`;
  - the Playwright suite on the shared stack (in its window);
  - `node scripts/lint-check.mjs`.
- [x] 8. Screenshots before (from `origin/main`) and after, light and dark at 375 and 1440 px (see the acceptance list). Record anything that looks off and fix it.
- [x] 9. COLOR_SYSTEM.md (11d is the base branch): remove the "7c" marks, and add the `.badge-count`, `.brand-fill` and dark `.brand-panel` rows.
- [ ] 10. Code review. Then PR, and merge on green CI.

## Test plan
- vitest: the two guards, and the existing component tests updated for renamed classes. Assert on behavior and roles, not on class strings, where a test checks color today.
- Playwright: axe light and dark on the public, learner, account and role pages; the rest of the suite unchanged.
- Manual: the screenshot pass, both themes, with a check for washed-out or invisible states (disabled, hover, selected tab, error field).

## Rollout and ops
Web only. Vercel deploys on merge, and the API is untouched, so there is no deploy skew. Nothing for the owner to do.

## Risks and open questions
- **Phase 10 and Phase 12 touch the same files.** 7c merges `origin/main` after 10. 12a/12b start from the stack tip after 11c and inherit the tokens, and their audit step uses COLOR_SYSTEM.md.
- **Darker helper text changes the feel slightly.** It is the approved direction's "readable helper text" principle. The before/after page shows it to the user.
- **A guard that is too strict blocks legitimate uses.** The allowlist is files, not lines, and is kept short. A new exception is a one-line review discussion.

## Progress and deviations (implementer)

The first build (2026-10-07, worktree `../ethi0-7c`, code review round 1 APPROVED) was never committed and was lost with the worktree. This is the rebuild of 2026-10-18 on `feat/color-system` from `docs/contributor-docs` (11d, PR #34), in the main checkout, with every fix from [code-review.md](code-review.md) folded in (S1 `text-white` timestamp, N1 `hover:brightness-105`, N2 plain stat objects).

### What was built (steps 1–9)
- **Tokens** (`globals.css`, `tailwind.config.ts`): the four status roles (text and solid as channels, soft and line as rgba), `rating`, `input-border`, `gray-500`/`muted-foreground` retuned, `.badge-*` on the roles with no `.dark` overrides, `.input` on `--input-border`, solid `.progress-fill`, `accent-color` on checkboxes and radios, `.badge-count`, `.brand-panel` (with a dark variant) and `.brand-fill`.
- **Guards**: `web/src/lib/color-tokens.test.ts` (the COLOR_SYSTEM.md table, both themes, plus white on every fixed fill and cover) and `web/src/lib/no-raw-colors.test.ts` (palette classes and hex outside the six-file allowlist, named `file:line`). Against the base, the raw-colour guard failed on 176 lines in 51 files (363 classes).
- **Migration**: a mechanical pass (a scratch script with the table's shapes) changed 144 lines in 43 files; the rest by hand. 3 component tests now assert on the role (`text-success`, `text-danger`).
- **axe**: `a11y.spec.ts` gains the editor of a draft **with a lesson** (`draftWithLesson` in `e2e/support.ts`) and the seeded quiz's exam intro (`seededExamPath`), light and dark.
- **Step 9**: COLOR_SYSTEM.md lost its "7c" marks and gained `.badge-count`, `.brand-fill` and the `.brand-panel` dark variant.

### Deviations from the plan
1. **`.brand-panel` has a dark variant** (`#172554`→`#1e1b4b`, the old dark hero) and pins `--brand-50`/`--brand-700` to their light values. The plan's single fixed gradient would have made the dark Home hero bright blue, which the non-goals rule out, and without the pin the white hero controls' `text-brand-700` is light blue on white in dark mode. The class sits on the hero container, not a backdrop div, so the pin reaches the controls.
2. **`.brand-fill`** (`.btn`'s stops, colours only) for the small fills the plan sent to `.brand-panel`: stat tiles, the header avatar, the follow button, the selected preference chip, chat bubbles, the skip link. The navy panel gradient nearly vanished on dark cards.
3. **The hero's gradient phrase** is `from-white/75 to-white` (no role is light on the panel in both themes); the hero chips are `bg-white/95 text-brand-700` (`text-foreground` is near-white in dark mode).
4. **Educator ranks**: first `bg-warning-soft text-warning`, third `bg-gray-100 text-gray-600` (no orange role; the number is printed).
5. **CourseCard tags** are one pill, `bg-gray-50/95`, with `text-success` (Free) or `text-foreground`: text never sits on a solid, and one class holds in both themes.
6. **The exam camera tag**: REC and OK are `bg-black/75 text-white`; the problem states use `.badge-count`.
7. **Decorative swaps**: the Footer heart is `danger-solid`; the hero photo overlay is `from-black/30`; the preview diff's block tints are `bg-*-soft`, and the inline marks inside them stack a second soft tint (4.85:1 or better for the text on the doubled tint).
8. **Commits**: a few logical commits on the branch (tokens and guards, migration, e2e and docs), not one per route group.

### Gate (2026-10-18)
- `vitest run`: 84 files, 743 passed (52 in the two guards). Mutation check: light `--rating` set to `#fbbf24`, `text-red-600` and `#ff0000` added to `PanelError.tsx` → 3 failures naming the pair and `file:line`; restored.
- `tsc --noEmit` clean; `next build` exit 0, first-load JS unchanged (`/` 128 kB, shared 87.7 kB); `node scripts/lint-check.mjs` exit 0 (the api "lower than baseline" note predates 7c); no palette class left in `web/src` (grep).
- Playwright, full suite: 128 passed, 2 skipped, 2 failed. Both failures came from the local `web/.next/cache/fetch-cache`: `/search` entries dated 2026-10-03 (course ids the API now 404s) made `catalog-and-404.spec.ts:7` render the old catalog, and the stale, cold server put `a11y.spec.ts:102` (light) at 33.8 s (dark: 16.9 s). With that cache removed both pass (catalog 3.2 s, a11y light 21.5 s, dark 19.1 s). The two new a11y scans (editor with a lesson, exam intro) pass in both themes. CI starts from a clean checkout, so it never has the stale cache.
- Screenshots: `docs/plans/2026-10-02-refinement-audit/screenshots/{before,after}-phase7c/` (git-ignored), 8 pages × 2 themes × 2 widths each.
