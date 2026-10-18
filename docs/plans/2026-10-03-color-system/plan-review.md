# Plan review: Phase 7c, color system

## Round 1 (2026-10-03) · Verdict: APPROVED (no blockers; S1 to fold in)
Reviewed `plan.md` (draft, round 1) against `docs/COLOR_SYSTEM.md` on 11d's branch (`a4add0e`, code review APPROVED) and the code at `origin/main` `f8e70bc` (`../ethi0-verify-main`, read only).

**Faithful to the spec.** The plan builds exactly what COLOR_SYSTEM.md specifies:
- the four statuses with text, soft, line and solid;
- `rating` and `input-border`;
- `gray-500`/`muted-foreground` retuned;
- solid `brand-600` bars and progress fills;
- the lesson-list bar moved onto `.progress-track`;
- the gray-200 rule.

**Values checked:** `91 107 128` = `#5b6b80` and `154 168 189` = `#9aa8bd`. The scale stays ordered in both themes.

**The facts I spot-checked hold:**
- The hex-literal allowlist in decision 6 is exactly the set of non-test files that hold hex today: `brand-art.tsx`, `categories.ts`, `manifest.ts`, `global-error.tsx`, `theme-script.ts`, `opengraph-image.tsx`. So the guard won't trip on something the plan didn't foresee.
- Nearly every text field already uses `.input`, so decision 4's one-line border change reaches them.
- `.input:focus-visible` already replaces the outline with a `brand-500` border (3.68:1 on white) and the glow, so "focus unchanged" is fine.

**No over-engineering:**
- two vitest files and no new dependency;
- `.brand-panel` replaces about 15 hand-written blue gradients;
- every token traces to COLOR_SYSTEM.md;
- the ESLint and Stylelint options are rightly rejected.

### Blockers
None.

### Should-fix
- **S1. Two of the three `bg-red-600 text-white` lines are count bubbles, not buttons, and no role fits them.**
  - **Where:** the current-state table counts "2 | `bg-red-600` with white text | `.btn-danger`". There are three:
    - `account/page.tsx:207`, the delete button. `.btn-danger` is right here.
    - `components/NotificationBell.tsx:76`, the unread count: an 18 px circle, `absolute -right-1 -top-1`.
    - `messages/page.tsx:168`, the per-thread unread count.
  - **The failure:** the guard flags all three. On the two bubbles, the planned `.btn-danger` brings `px-4 py-2 rounded-xl text-sm`, so the bell's 18 px badge becomes a pill hanging off the icon. The doc's other options don't fit either:
    - `bg-danger-solid` with white text is 3.76:1 in dark, and the doc says never to put text on a solid;
    - `bg-danger` (`#f87171` in dark) with white text fails too.
  - **Suggested:** one fixed class next to `.btn-danger` in `globals.css`, for example `.badge-count { background: #b91c1c; color: #fff }`. It gives 6.47:1 in both themes and keeps the bubbles' own sizing classes. Add a "count bubble" row to COLOR_SYSTEM.md's components table when the 7c marks come off.

### Nits (optional)
- **N1.** The catalog search box (`explore-client.tsx:161`, the site's main text field) isn't an `.input`. It's a bare input inside a `glass-secondary` wrapper, whose border is blue at 12% (about 1.15:1), so decision 4 doesn't reach it. Its icon and placeholder arguably identify it. If you want it consistent with "inputs get a visible border", the wrapper takes `border-input-border`. The Home hero search sits on the always-dark brand panel and is fine with `white/20`.
- **N2.** "An exam page" in the axe list needs a named state. `layout.spec` and `titles-and-robots.spec` already load `/learn/<course>/exam/<unknown id>` (the not-found state). A real attempt would start the camera checks in headless Chromium. Say which one: the seeded quiz's exam route before the start screen, or the not-found state.
- **N3.** Step 3: "watch it fail on the four failing pairs". Before step 2, the status, `rating` and `input-border` tokens don't exist, so the test fails on missing tokens first. Today's real failures are five pairs, not four: muted on gray-100, input border, chart bar, progress fill and star. "Fails on missing tokens and today's failing pairs" is enough.

### Planner responses (round 1, ethio-planner [31d0d2], 2026-10-03)
- **S1: fixed.**
  - The table splits the delete button (`.btn-danger`) from the two count bubbles.
  - The bubbles get `.badge-count`: a fixed `#b91c1c` with white text (6.47:1 in both themes), colors only, so they keep their own sizes.
  - Step 9 adds a "count bubble" row to COLOR_SYSTEM.md.
- **N1: fixed.** The catalog search wrapper takes `border-input-border`. The Home hero search stays `white/20` on the brand panel.
- **N2: fixed.** axe runs on the seeded quiz's exam route, on its intro screen before Start. The acceptance list names that state.
- **N3: fixed.** Step 3 fails on the missing tokens and today's five failing pairs.

### Reviewer check of the responses (ethio-review-plan, 2026-10-03)
S1 and N1–N3 are resolved as answered. The verdict stays APPROVED, so no round 2 is needed.
