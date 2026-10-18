# Phase 11d: Contributor guide, features and roadmap, color system

Status: code review APPROVED (round 1); step 9 under way (2026-10-07): squashed onto main after 11a (#32) merged, in PR. S1–S4, N1 and N2 folded in, N3 declined (see plan-review.md)
Size: S (sessions: 2). ethio-planner writes it; ethio-review-plan reviews the plan and the docs. Docs only: no code, API, migration or env change.
Base branch: `chore/ci-gates` (11a) tip `d442799`, or `origin/main` once 11a has merged. 11a rewrites the README and `DEPLOYMENT.md` and moves the old notes to `docs/history/`, so this phase builds on its versions. · Feature branch: `docs/contributor-guide` in the worktree `../ethi0-11d`.

## Goal
The user asked for four things on 2026-10-03:
- collaboration guidelines for people joining EthiopiaLearn;
- an updated README;
- one document that covers every feature and everything still to do, including the phases;
- the UI colors documented as a system that is "the best".

People joining the project should be able to set up, pick up work, open a PR that gets merged, and build UI that looks and reads right, all without asking the owner. The color system is the spec. Phase 7c (planned next to this one) brings the code up to it.

Acceptance criteria:
- `CONTRIBUTING.md` (repo root, so GitHub links it from the PR and issue pages) covers:
  - setup;
  - how work is planned and reviewed (plans, sizes, the review rules);
  - branches, commits and PRs as this repo practises them;
  - the definition of done;
  - the backend and frontend rules;
  - tests;
  - security, including private vulnerability reporting;
  - who owns production.
- `docs/FEATURES_AND_ROADMAP.md` lists:
  - what each role can do today, with routes;
  - the cross-cutting features;
  - what is stubbed or mock-only;
  - every phase (done, in progress, planned) in plain language;
  - the after-launch backlog;
  - a short "UI and color" section that links to the color system.
- `docs/COLOR_SYSTEM.md` defines:
  - every color role (surfaces, text, brand, status, borders, focus, charts, category covers, flag);
  - light and dark values;
  - usage rules;
  - a computed contrast table where every pair meets WCAG 2.2 AA: 4.5:1 for text, 3:1 for UI boundaries, focus and graphics;
  - the gap between that spec and today's code, which Phase 7c closes.
- The README stays the front door. It gets:
  - a short "what it does";
  - a documentation map;
  - project status;
  - Contributing;
  - stale claims corrected against the code.

  It keeps its setup, testing and schema sections.
- `roadmap.md` gains the rows 11d and 7c and a change-log line.
- Every relative link in the changed files resolves, and every command shown exists. Commands that are cheap to run are run.
- The public repo gets nothing that helps an attacker:
  - no unfixed-vulnerability detail;
  - no secrets or production identifiers beyond the public site URL;
  - no personal email addresses.

  gitleaks is clean.

## Non-goals
- Changing any code, token or class. Phase 7c does that.
- A docs site, Storybook, or a design-token package.
- A `CODE_OF_CONDUCT`, `LICENSE` or `SECURITY.md`. A license is the owner's legal choice. Vulnerability reporting lives in one section of CONTRIBUTING.
- Rewriting `docs/DEPLOYMENT.md` or `docs/API_REFERENCE.md`. 11a owns the first; the second is linked as it is.
- Issue templates and labels.
- Translating the docs into Amharic.

## Current state
- `README.md` (202 lines; 11a edits 15). It has:
  - architecture, services, a long Features list, quick start, testing, schema changes, Amharic, mock providers, spec highlights, layout and env.

  Gaps:
  - no documentation map, project status or contributing section;
  - the testing table omits Playwright (`pnpm -C web e2e`, CI "Browser smoke") and the CI e2e scripts;
  - the Amharic section predates 7b and Phase 10.
- No `CONTRIBUTING.md`. 11a adds `.github/pull_request_template.md` (deploy-skew checks) and `CODEOWNERS` (`* @Kalkidan-Amare`).
- Conventions in practice (`git log origin/main`):
  - Conventional Commits with a scope (`fix(web)`, `fix(api)`, `docs(plans)`, `feat(web)`, `test(web)`, `ci`), and subjects that state the behavior ("a duplicated course keeps measured video lengths");
  - branches `<type>/<slug>`;
  - PRs merged with a merge commit; `origin/main` is merged into feature branches (no rebase);
  - Vercel deploys web on merge, and Render deploys the API after CI.
- Plans live in `docs/plans/<date>-<slug>/` (`plan.md`, `plan-review.md`, `handoff.md`, `code-review.md`). Some folders are tracked and some stay local until their phase ships. `roadmap.md` is the phase tracker.
- Colors (`web/src/app/globals.css`, `web/tailwind.config.ts`, `web/src/lib/categories.ts`):
  - a blue brand scale and a slate gray scale as RGB-channel CSS variables that flip under `.dark`;
  - `.btn` (a `#1d4ed8`→`#2563eb` gradient) and `.btn-danger` (`#b91c1c`);
  - five status badge classes;
  - five category cover colors and the flag band.

  Contrast computed today (`contrast/contrast.mjs` in this folder, `node` it). It fails:
  - helper text `gray-500` `#64748b` on blue tints (4.26) and gray-100 (4.34);
  - dark `muted` `#94a3b8` on gray-200 (4.47);
  - input borders at 1.17:1 (light);
  - the bar chart fill at 2.78:1 (light);
  - 13 light-only status classes (`text-red-600`, `text-amber-700` with no `dark:` variant) at 3.6–3.7 in dark.

  And there are 362 raw palette classes (`text-red-600`, `text-amber-700`, `bg-emerald-500`, …) with no shared status tokens.

## Design and key decisions
1. **Four files, each with one job.**
   - The README is the front door: what it is, run it, where to read next.
   - `CONTRIBUTING.md` is how to work here.
   - `docs/FEATURES_AND_ROADMAP.md` is what it does and what's next.
   - `docs/COLOR_SYSTEM.md` is how it looks.

   Rejected: one long guide, because readers come with different questions, and a docs site, which is more machinery than four markdown files need.
2. **One home per fact.**
   - The full feature list moves from the README to `FEATURES_AND_ROADMAP.md`. The README keeps eight one-line bullets and a link.
   - Phase status with PR numbers stays in `roadmap.md`. `FEATURES_AND_ROADMAP.md` groups the phases as done, in progress and planned, with one plain-language outcome each and no PR numbers.
   - CONTRIBUTING's definition of done says a phase's PR moves its line in both files.
3. **Safe for a public repo.**
   - Phases are described by outcome ("payments survive a missed webhook"), never by the hole they close.
   - Phases not yet deployed (9a–9e, 10, 11b, 11c) get neutral wording. The audit stays local.
   - No production database, Render or Neon identifiers. The live site URL is already public.
   - Contact goes through GitHub (CODEOWNERS handle, private vulnerability reporting), never an email address.
   - **The stub list and the after-launch backlog follow the same rule (review S4).** They name features and outcomes only, and any unfixed security finding stays in the local audit. Step 3's safety read covers both, and this plan folder too if it is committed.
4. **The color system is a spec with numbers.** Roles, not raw hues: pages use tokens and never Tailwind palette classes. The target values below were chosen so that every documented pair passes AA in both themes. The changes against today are marked "7c" in the doc.

   | Role | Light | Dark | Change |
   |---|---|---|---|
   | Muted text (`muted-foreground`, `gray-500`) | `#5b6b80` | `#9aa8bd` | 7c (from `#64748b` / `#94a3b8`). Checked on page, secondary, card and gray-100. On gray-200, brand-100 or a stronger tint, secondary text is `gray-600` (review S1). |
   | Input border | `#7c8ba1` | `#64748b` | 7c (from blue at 14% / 22%): 3:1 boundary |
   | Chart bar | `brand-600` solid | same | 7c (from `brand-500/80`) |
   | Progress fill (`.progress-fill`, the lesson-list bar) | `brand-600` solid | same | 7c (from a `#2563eb`→`#60a5fa` gradient and `brand-500`). It must be 3:1 on its track: 4.19 light, 4.50 dark (review S2). A status-colored bar always carries a printed label. |
   | Status `success` / `warning` / `danger` / `info`: text | `#047857` / `#b45309` / `#b91c1c` / `#1d4ed8` | `#34d399` / `#fbbf24` / `#f87171` / `#93c5fd` | 7c adds them as tokens. They are today's badge colors, so the look doesn't change. |
   | Status soft background | the hue at 12% (danger and info 10%) | the hue at 14% | as above |
   | Status solid (dots, bars, icons on their own) | `#059669` / `#d97706` / `#dc2626` / `#2563eb` | `#10b981` / `#f59e0b` / `#ef4444` / `#60a5fa` | as above |
   | Rating star fill (the number is always printed beside it) | `#d97706` | `#fbbf24` | 7c (from `amber-400`, 1.67:1 on white) |
   | Foreground, surfaces, brand scale, buttons, category covers, flag | as today | as today | none |

   The computed results are in `contrast/palette-table.md` (regenerate with `node contrast/palette.mjs`). Each row names the surfaces it is checked on, and the ratio is the lowest of them. Every row passes. `background-tertiary` is not a text surface: it is defined but unused.
   - Lowest text pair: light warning text on its own tint, 4.58.
   - Lowest boundary or graphic pair: light warning solid on the secondary background, 3.08.
   - **Why tune `gray-500` itself rather than swap 287 `text-gray-500` uses to `gray-600`:** one token change fixes every helper text at once, and the scale stays ordered (400 < 500 < 600).
   - **Flag colors stay decorative:**
     - used only on the band, certificates, section edges and the logo underline;
     - never text, never a status (flag red is not "error"), never behind text.

     Yellow on white is 1.36:1.
   - **Color is never the only signal.** Status shows a word or an icon too, and chart values are printed.
5. **The README's corrections are checked against the code.** The testing table gets Playwright and the CI e2e scripts. The Amharic section says what is translated today (from `web/src/lib/i18n.tsx`) and points to Phase 10 for the new-learner path. "What it does" is checked against the feature inventory.
6. **CONTRIBUTING describes the process this repo already runs**, so it is not aspirational:
   - plan, then plan review, implement, code review;
   - sizes S/M/L;
   - blocker, should-fix and nit, each with a concrete-scenario rule;
   - a merge commit, with `origin/main` merged in rather than a rebase;
   - no force-push, no direct push to `main`, no rewriting pushed history;
   - CI must be green, with the required checks taken from `.github/rulesets/main.json` (today `api`, `web`, `e2e`, `secret-scan` and `lint`; review N2), and the review approved;
   - merging deploys, so only merge what may go live;
   - the PR template's deploy-skew questions;
   - migrations by hand-reviewed TypeORM files (it links the README's schema section rather than repeating it).
7. **Private vulnerability reporting.** CONTRIBUTING points reporters only to GitHub's "Report a vulnerability" on the Security tab. It is off today (`{"enabled":false}`), and GitHub has no private messages, so turning it on **blocks 11d's merge** (review S3). It is a repo setting, so the owner does it with one `gh api` call, in USER-ACTIONS "Start here" as a 🟥 item (Rollout). There is no fallback sentence.

## Steps
- [x] 1. Worktree `../ethi0-11d`, branch `docs/contributor-guide` from `chore/ci-gates`.
- [x] 2. `docs/COLOR_SYSTEM.md`, covering:
  - principles;
  - the token tables (light and dark, with the "7c" marks);
  - usage rules with do and don't;
  - status, charts, category covers and flag;
  - the contrast table generated by `contrast/palette.mjs`;
  - how to add a color;
  - the gap list for 7c.
  · Verify: regenerate the table, then compare every hex value in the doc with `globals.css`, `categories.ts` and the target list.
- [x] 3. `docs/FEATURES_AND_ROADMAP.md`, covering:
  - features by role, from the explorer's inventory, with each route checked to exist in `web/src/app`;
  - the cross-cutting features;
  - stubbed and mock-only;
  - the phase roadmap (done, in progress, planned, including 7c, 11d, 12a and 12b);
  - the after-launch backlog;
  - UI and color.
  · Verify: a route-existence check, and a public-safety read of the phase lines.
- [x] 4. `CONTRIBUTING.md` (decision 6). · Verify: each command exists in a `package.json` or `scripts/`.
- [x] 5. `README.md` (decisions 2 and 5). · Verify: the claims are checked against the code.
- [x] 6. `roadmap.md`: rows 11d and 7c, plus a change-log line.
- [x] 7. Checks:
  - a relative-link check over the changed files;
  - the commands that are cheap to run (`pnpm -C web test`, `node scripts/lint-check.mjs --help` or equivalent);
  - gitleaks over the branch, from the main repo path (memory `gitleaks-in-worktree`);
  - a grep for `@` emails and secret-shaped strings.

  Commit.
- [x] 8. Code review by ethio-review-plan (APPROVED round 1; the three nits are fixed).
- [x] 9. After 11a merges: onto `origin/main`, push, PR, merge on green CI. Deviation (2026-10-07, the user's commit cap): the branch's commits went in as ONE squashed commit on `docs/contributor-docs` from `origin/main` 8c511b5, not as a merge. The local `docs/contributor-guide` branch is kept as the reviewed history. The same commit points CONTRIBUTING's lint command at `pnpm -C api build &&` (11a's review S1), marks 11a and 11d done in the roadmap, and moves both to Done in FEATURES_AND_ROADMAP.

## Test plan
Docs only. Checks:
- the link check;
- a command-existence check;
- regenerating the contrast table;
- the route-existence check for every route named;
- gitleaks;
- reading each file rendered on GitHub's markdown (tables, code blocks), once on the PR.

## Rollout and ops
- No deploy effect: Vercel and Render rebuild on merge, but nothing changes at runtime.
- **Owner, before the merge (it blocks it; a minute):** turn on private vulnerability reporting. The check: `gh api repos/avelia-ethio-learning-platform/ethio_learn/private-vulnerability-reporting` prints `{"enabled":true}`.

  ```
  gh api -X PUT repos/avelia-ethio-learning-platform/ethio_learn/private-vulnerability-reporting
  ```

  It goes in USER-ACTIONS "Start here" as a 🟥 item now, because nothing else waits on it.

## Risks and open questions
- **The roadmap drifts after each merge.** The definition of done names both files, and the planner updates them on its docs-touching branches, as it does now.
- **11a changes again in review.** This branch merges `chore/ci-gates` again before review and `origin/main` before the PR.

## Progress and deviations (implementer)
- **2026-10-03 (planner):** steps 1–7 done.
  - **Checks run:**
    - every relative link and `#anchor` in the five touched files resolves;
    - all 34 routes named in the docs exist under `web/src/app`;
    - every command in CONTRIBUTING and the README exists (in `api`/`web` package scripts or `scripts/`);
    - the cited helpers exist (`components/PageChrome.tsx`, `components/form/`, `components/confirm/`, `lib/labels.ts`, `lib/format.ts`, the common `ValidationPipe`);
    - an email and secret grep over the new docs and this folder found nothing;
    - gitleaks (main repo mounted) reported 10 commits scanned, no leaks.
  - **Deviations:**
    - The README's "Features" list became a shorter "What it does", and the full list moved to FEATURES_AND_ROADMAP (decision 2).
    - The README's email row now lists Brevo and SMTP as well as Resend, matching `email.provider.ts`.
    - Its Amharic section now says what is translated today, and that Phase 10 extends it.
    - Its Testing table adds typecheck, the `e2e-*.mjs` flows and Playwright.
- **Checkpoint 2026-10-03 (paused until Monday 2026-10-05, at the user's request):**
  - The branch is committed locally at the commit after `d11bb0d` and is not pushed.
  - Next: once 11a merges, `git merge origin/main` (expect conflicts only in README and roadmap.md, which 11a also edits), re-run the link and gitleaks checks, push, open the PR, and merge on green.
