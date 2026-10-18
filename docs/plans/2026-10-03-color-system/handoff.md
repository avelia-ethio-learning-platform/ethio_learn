# Handoff: Phase 7c, color system

From ethio-planner to ethio-impl (3) [688c71], after Phase 10.
Plan: [plan.md](plan.md) (approved in round 1, see [plan-review.md](plan-review.md))
Code review goes to: ethio-plan-review [f903ba] (size M)

## What to build
- The web uses named color roles only: `success`, `warning`, `danger`, `info` (text, `soft`, `line`, `solid`), `rating`, `input-border`, and the brand and gray scales. There are no Tailwind palette classes and no stray hex.
- Every text, boundary and graphic pair passes WCAG AA in light and dark.
- Two vitest guards keep it that way.
- axe runs light and dark on the role pages too.

## Read first, in order
1. The spec: `docs/COLOR_SYSTEM.md` on `docs/contributor-guide` (worktree `../ethi0-11d`) until 11d merges, then on `main`. Its contrast table is the pair list for `color-tokens.test.ts`.
2. `plan.md` decisions 1–8 and the migration table, then `plan-review.md` round 1:
   - S1: `.badge-count` for the two count bubbles;
   - N1: the catalog search wrapper takes `border-input-border`;
   - N2: axe on the exam route's intro screen, before Start;
   - N3: step 3 fails on the missing tokens first.
3. `web/src/app/globals.css` (the `:root` and `.dark` blocks, `.input`, `.badge-*`, `.btn-danger`, `.progress-*`) and `web/tailwind.config.ts`.
4. `web/e2e/a11y.spec.ts` (`prefer(theme)`, `revealAll`) and `web/e2e/auth.setup.ts` (the stored role logins).

## Decisions already made (don't relitigate)
- **The values are final.** They're the values in COLOR_SYSTEM.md's table:
  - muted is `#5b6b80` light and `#9aa8bd` dark;
  - `gray-200` is unchanged in both themes.
- **Retune `gray-500`/`muted-foreground`**, and don't edit its call sites. On `gray-200`, `brand-100` or a stronger tint, helper text is `gray-600`.
- **Status text and solid colors are RGB channels.** Soft and line are `rgba()` values. The badges look the same as today.
- **Never put text on a `*-solid` fill.**
  - Buttons use `.btn-danger`.
  - Count bubbles use `.badge-count`, which is colors only.
- **Bars and progress fills are solid `brand-600`.** The lesson list uses `.progress-track`/`.progress-fill`. A status-colored bar prints its label.
- **The guards are two vitest files and nothing else:** no ESLint plugin, no token package. The hex allowlist is the six files in decision 6, and the reviewer confirmed it matches the code.
- **Always-dark hero and banner panels** use one `.brand-panel` class.

## Gotchas
- **Phase 10 is in the same files** (CourseCard, PasswordStrength, the auth pages, the course page). Start from `origin/main` after 10 merges. An early start from `feat/web-hardening` merges `origin/main` once 10 lands. Merge only, never rebase.
- **The Playwright login budget is 10 credential calls a minute, and the suite uses 8.** The role-page axe tests reuse `e2e/.auth/<role>.json`, and add no logins. Run the suite at most once a minute.
- **Use the shared stack window for Playwright** (ask the planner), with `api/.env.example` values only.
- **Before/after screenshots:** take the "before" set from `origin/main` before you migrate.
- **Docs must not quote `.env` values** (the secret-guard hook scans untracked files).

## How to run
- `pnpm -C web test` (the guards included);
- `pnpm -C web typecheck` and `pnpm -C web build`;
- `node scripts/lint-check.mjs`;
- Playwright: `pnpm -C web build && pnpm -C web e2e`, with the stack up and seeded.
