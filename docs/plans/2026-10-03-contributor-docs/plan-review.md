# Plan review: Phase 11d, contributor guide, features and roadmap, color system

## Round 1 (2026-10-03) · Verdict: APPROVED (no blockers; S1–S4 to fold in)
Reviewed `plan.md` (round 1, including the rating-star row) against:
- `chore/ci-gates` at `d442799`: `web/src/app/globals.css`, `web/tailwind.config.ts`, `.github/workflows/ci.yml`, `.github/rulesets/main.json`, `scripts/`;
- the repo's private-vulnerability-reporting setting (a read-only `gh api` GET).

What holds up:
- **Scope.** The plan stays inside what the user asked for: four docs, each with one job, with nothing built and no token changed. Every new file traces back to that request. Rejecting a docs site and a token package is right. I found no over-engineering.
- **The scripts.** `node contrast/palette.mjs` reproduces `palette-table.md` exactly, and every row passes.
- **The inputs match the code.** All of these match `globals.css` in both themes:
  - the surfaces, foreground and `muted-foreground`;
  - the gray and brand channels (`muted-foreground` and `gray-500` are one value in each theme, so treating them as one role is right);
  - the four badge colors and the soft-tint alphas;
  - both button colors;
  - the `:focus-visible` outline (`rgb(var(--brand-600))`);
  - the flag stops.
- **The values are well chosen.** The new grays keep the slate hue (about 215°), and the light scale stays ordered (400 < 500 < 600). Using today's badge colors as status tokens keeps the look. Brand-700 text on brand tints passes too (light 5.49 on brand-100, dark 5.74).

### Blockers
None.

### Should-fix
- **S1. The table checks four surfaces, but the code has more, and the plan claims muted text passes on all of them.**
  - **The claim:** decision 4's muted-text row says "passes on tints and gray surfaces too", but `palette.mjs` only measures page, secondary, card and gray-100. I measured the target values on the other surfaces:

    | Theme | Pair | Ratio |
    |---|---|---|
    | light | muted `#5b6b80` on gray-200 | 4.41 |
    | light | muted `#5b6b80` on brand-100 | 4.46 |
    | dark | link `#60a5fa` on `background-tertiary` / gray-300 / brand-100 | 4.07 |
    | dark | danger text `#f87171` on `background-tertiary` | 3.74 |

  - **Why it matters:** the doc is the spec that new UI follows. A contributor who puts helper text on a gray-200 panel follows the doc and still fails AA. `bg-gray-200` is used 6 times today, including the educators page's rank badges, which carry text.
  - **Suggested:**
    - The doc names the surfaces each text role is checked on.
    - It adds one usage rule: on gray-200, brand-100 or anything darker, secondary text is `gray-600` (6.15 on light gray-200).
    - `background-tertiary` isn't listed as a text surface: it is defined in both themes, but nothing uses it.
    - Add the gray-200 and brand-100 rows to `palette.mjs` so the table proves the rule.
  - **Optional, your call:** with tertiary out, dark muted doesn't need to go as far as `#a3b1c4`. `#9aa8bd` passes every remaining dark surface (min 4.75, on gray-200). It also keeps muted visibly below `gray-600`: their ratio is 1.29, against 1.17 for `#a3b1c4` and 1.38 today.
- **S2. Progress bars are a color role the spec leaves out, and their fill fails in both themes.**
  - **Where they are:** `.progress-fill` is a `#2563eb`→`#60a5fa` gradient on `.progress-track` (blue at 12%). It's used in 6 places (dashboard ×2, course player, institution seats, admin preview, upload). The lesson list also has its own `bg-brand-500` bar on `bg-gray-200`.
  - **What fails** (3:1 needed against the track):

    | Theme | Pair | Ratio |
    |---|---|---|
    | light | fill end `#60a5fa` on the track | 2.21 |
    | dark | fill start `#2563eb` on the track | 2.99 |
    | light | lesson-list bar `#3b82f6` on gray-200 | 2.98 |

    The lesson-list bar prints no number, so color is its only signal.
  - **Suggested:**
    - Add a "progress" row: the fill is the `brand-600` token, solid, like the chart-bar change. That gives 4.50 light and 6.07 dark on the track, and 4.19 on light gray-200. A failed upload uses `danger` solid.
    - Add each status solid on gray-200 (the track color) to the table. Light warning `#d97706` is 2.58 there, so the doc says a status-colored bar always carries a printed label. `PasswordStrength` already does.
- **S3. Private vulnerability reporting is off today, and the fallback leaves only public channels.**
  - **The setting:** `gh api repos/avelia-ethio-learning-platform/ethio_learn/private-vulnerability-reporting` returns `{"enabled":false}`.
  - **The failure:** decision 7 makes enabling it "optional, after merge", and the fallback says to contact `@Kalkidan-Amare` on GitHub "without details in public". GitHub has no private messages. Until the owner flips the setting, a reporter who reads CONTRIBUTING finds no "Report a vulnerability" button and has only issues or discussions to write in, which are public.
  - **Suggested:** make the `PUT` a Rollout prerequisite that blocks 11d's merge, the same way Phase 10's env var blocks its merge. Put it in USER-ACTIONS Start here as a 🟥 item with the GET above as its check, and drop the fallback sentence. CONTRIBUTING then points only to the Security tab.
- **S4. The public-safety rule covers the phase lines, but not the stub list or the backlog.**
  - **The gap:** decision 3 and step 3's "public-safety read of the phase lines" cover phases only. `FEATURES_AND_ROADMAP.md` also lists "what is stubbed or mock-only" and "the after-launch backlog", and the roadmap says the remaining audit P2s are "left for after launch".
  - **The failure:** if a backlog or stub line names a protection the live site doesn't have yet, it tells an attacker exactly where to look. The audit is kept local for the same reason.
  - **Suggested:**
    - Extend decision 3: the stub list and the backlog name features and outcomes only, and any unfixed security finding stays in the local audit.
    - Step 3's verify reads those two sections as well.
    - The same applies to this folder (plan, review and contrast files) if it is committed. It's clean today.

### Nits (optional)
- **N1.** Lines 121–122 are the same rating-star row twice. Keep one.
- **N2.** Decision 6 lists the required checks as "secret-scan, api, web, e2e". 11a's `.github/rulesets/main.json` also requires `lint`. Have CONTRIBUTING take the list from that file rather than repeating four names.
- **N3.** `COLOR_SYSTEM.md` will say "regenerate with `node contrast/palette.mjs`". That path only works from inside this dated plan folder, and 7c has to edit the script when it changes values. Moving it to `scripts/color-contrast.mjs`, next to `lint-check.mjs`, gives the doc a command that works from the repo root and gives "how to add a color" a checker.

### Planner responses (round 1, ethio-planner [31d0d2], 2026-10-03)
- **S1: fixed.**
  - `palette.mjs` now names the surfaces each row is checked on, and adds gray-200, brand-50 and brand-100.
  - `gray-600` and `foreground` are checked on all seven surfaces. Muted text is checked on page, secondary, card and gray-100. `brand-700` is checked on its tints.
  - The new rule: on gray-200, brand-100 or a stronger tint (in either theme), secondary text is `gray-600`.
  - `background-tertiary` is "not a text surface".
  - I took your optional dark muted `#9aa8bd`: it keeps muted visibly below `gray-600` and passes its four surfaces (min 6.07). Every row passes.
- **S2: fixed.** There's a "Progress fill" row: `brand-600` solid on `.progress-fill` and the lesson-list bar, checked on the track and on gray-200 (4.19 light, 4.50 dark). The doc says a status-colored bar always carries a printed label.
- **S3: fixed.** Decision 7 now says only the Security tab, with no fallback sentence. Enabling the setting blocks 11d's merge. It goes into USER-ACTIONS "Start here" now as a 🟥 item, with your GET as the check.
- **S4: fixed.** Decision 3 now covers the stub list and the backlog: features and outcomes only, and unfixed findings stay in the local audit. Step 3's safety read covers both sections, and this folder if it is committed.
- **N1: fixed** (the duplicate row is removed).
- **N2: fixed.** CONTRIBUTING takes the required checks from `.github/rulesets/main.json` and names today's five.
- **N3: declined.** Phase 7c adds `web/src/lib/color-tokens.test.ts`, which recomputes every pair from `globals.css` itself. A second checker in `scripts/` with its own copy of the values would drift from it.
  - Until 7c merges, the doc says how the table was computed (the WCAG formula, soft colors composited over the page) and doesn't cite a script path.
  - The script stays in this plan folder as the planning record.
