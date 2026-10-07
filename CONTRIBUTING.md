# Contributing to EthiopiaLearn

Thanks for helping. This guide covers how work is planned, built, reviewed and shipped here. It describes what the project already does, so following it keeps your change easy to review and safe to deploy.

**Start with these:**
- [README](README.md): run the stack locally.
- [Features and roadmap](docs/FEATURES_AND_ROADMAP.md): what exists and what's next.
- [Color system](docs/COLOR_SYSTEM.md): before you touch UI.
- [Deployment](docs/DEPLOYMENT.md): how a merge reaches production.

## Contents
- [Ground rules](#ground-rules)
- [Setup](#setup)
- [How work is organised](#how-work-is-organised)
- [Branches, commits and pull requests](#branches-commits-and-pull-requests)
- [Reviews](#reviews)
- [Definition of done](#definition-of-done)
- [Backend rules](#backend-rules)
- [Frontend rules](#frontend-rules)
- [Tests](#tests)
- [Security](#security)
- [Production](#production)
- [Proposing a change](#proposing-a-change)

## Ground rules

- **Merging to `main` deploys to production.** Vercel deploys the web at once, and Render deploys the API once CI passes. Merge only what may go live.
- **Keep it simple.** Pick the boring, proven option, and follow the patterns already in the code. Every extra layer, option or abstraction needs a reason in the plan.
- **The repo is public.** Never commit secrets, real user data or details of an unfixed vulnerability.
- **Be kind and specific.** In reviews, say what breaks and when, not just that something "feels off".

## Setup

Follow the [README quick start](README.md#quick-start-local-dev):
- Node 22 (`.nvmrc`), pnpm 9 (`corepack enable`) and Docker;
- `cp api/.env.example api/.env`;
- `docker compose up -d …`, then `pnpm -C api seed`;
- `pnpm -C api dev` and `pnpm -C web dev`.

Everything runs with no external accounts. Chapa, email and AI fall back to local mocks.

- **Use the example values for local work and tests.** Don't put real Chapa, SMTP or Groq keys in your `api/.env` while running the end-to-end suites: they would send real email or call paid APIs.
- `.env` files are git-ignored. Keep them that way.
- **Low-memory machine?** Use the compiled backend (`pnpm -C api build`, then `bash scripts/start-backend.sh`), as the README describes.

## How work is organised

**Phases.** Larger work is cut into numbered phases. Each one is one plan, one branch and one PR.
- The tracker, with status and PR numbers, is [`docs/plans/2026-10-02-refinement-audit/roadmap.md`](docs/plans/2026-10-02-refinement-audit/roadmap.md).
- A plain-language summary is in [FEATURES_AND_ROADMAP.md](docs/FEATURES_AND_ROADMAP.md#roadmap).

**Plans.** A non-trivial change starts with a plan in `docs/plans/<YYYY-MM-DD>-<slug>/`:

| File | Written by | Holds |
|---|---|---|
| `plan.md` | the planner | Goal and acceptance criteria, non-goals, current state, decisions (with the alternative rejected), steps, test plan, rollout. The implementer ticks steps and logs deviations here. |
| `plan-review.md` | the plan reviewer | Review rounds, with the planner's answer to each finding. |
| `handoff.md` | the planner | What to read first, decisions not to reopen, gotchas, how to run. |
| `code-review.md` | the code reviewer | Review rounds, with the implementer's answer to each finding. |

Some plan folders stay local until their phase has shipped (for example, when a plan describes a hole that isn't fixed yet). They're committed with the phase's PR.

**Sizes** decide how many people are involved:

| Size | When | Who |
|---|---|---|
| **S** | Contained: about 5 files or fewer, one layer. No migration, no public API, auth or payment change. | The planner implements; one reviewer checks the plan and the code. |
| **M** | Several layers (database, API and UI), a migration or new endpoints, within one feature. | Planner, implementer, and one reviewer for the plan and the code. |
| **L** | Cross-cutting, migrating existing data, auth, payments or money, concurrency or idempotency risk. | Planner, implementer, plan reviewer, and a separate code reviewer. |

When unsure between two sizes, pick the smaller, unless data, security or money pushes it up.

**The flow:**
1. **Plan.** Write the plan. The non-goals are the main defence against scope creep.
2. **Plan review.** A reviewer adds a round to `plan-review.md`. The planner answers each finding: fixed, deferred or disagree, each with a reason. Repeat until approved, at most three rounds; after that the owner decides what's still open.
3. **Implement** on a branch, ticking steps and logging deviations in `plan.md`. Don't reopen decisions the plan settled. If one is wrong, raise it with the planner and keep going on the rest.
4. **Code review** in `code-review.md`, with the same rules and the same three-round cap.
5. **Ship:** open the PR, CI goes green, merge. The phase's roadmap row and its plan status become `done`.

A small fix (a typo, a one-line bug with a test) doesn't need a plan folder. A clear PR description is enough.

## Branches, commits and pull requests

**Branches:** `<type>/<slug>` from `main`, for example `fix/payment-integrity`, `feat/role-dashboards-a`, `docs/contributor-guide`. The types are `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore` and `ci`.

**Commits:** [Conventional Commits](https://www.conventionalcommits.org/), with a scope:
- **Scopes in use:** `api`, `web`, `common`, `gateway`, a service name (`financial`, `outcomes`, …), `plans`, `ci` and `env`.
- **The subject says what now behaves differently,** in plain words. For example:
  - `fix(api): a duplicated course keeps measured video lengths; a stale open attempt can't be submitted`
  - `perf(web): hls.js loads when playback starts`
- One logical change per commit. Commit tests with the code they cover.

**Pull requests:**
- One PR per phase or fix. Fill in the [PR template](.github/pull_request_template.md), especially the deploy checks:
  - Does the web still work against the previous API until Render deploys? There's a window of up to about 45 minutes after each merge.
  - Does the previous web still work against this API?
  - Are new environment variables listed for the owner before the merge?
  - Do schema changes ship as migrations?
- **Required checks** come from [`.github/rulesets/main.json`](.github/rulesets/main.json). Today they are `api`, `web`, `e2e`, `secret-scan` and `lint`, and the branch must be up to date with `main`.
- **Bring `main` in with a merge,** not a rebase: `git merge origin/main`.
- **Merge with a merge commit** once checks are green and the code review is approved.

**Never:**
- force-push;
- push straight to `main`;
- rewrite history that's already pushed;
- merge past failing checks.

## Reviews

Reviews of plans and code use the same scale, so they end:

| Kind | Meaning | What the author does |
|---|---|---|
| **Blocker** | A realistic failure, stated as a scenario ("when X happens, Y breaks"): a bug, data loss, a security hole, an unmet requirement, a broken build or deploy, or a migration that locks tables or can't roll back. | Must fix before approval. |
| **Should-fix** | A real issue that doesn't block release. | Fix it, or defer it with a one-line reason. |
| **Nit** | Optional polish. At most 3 per round, and never a reason for another round. | Your call. |

**Not findings:**
- one-in-a-billion hypotheticals;
- speculative future needs;
- anything the plan lists as a non-goal;
- abstraction or configuration "for flexibility";
- style the codebase doesn't follow.

**Approval:**
- **Approved** means no open blockers.
- From round 2 on, a reviewer checks the earlier findings and only what changed. A new issue in unchanged code must be a blocker.
- The author may push back with reasons. A reasoned disagreement stands unless it's a blocker with a concrete scenario.

Useful tools for reviewers:
- `git diff main...<branch>`;
- running the build and tests yourself, without changing the author's working tree.

## Definition of done

**Before you ask for code review:**
- [ ] It does what the plan or issue says, and nothing unplanned.
- [ ] The build passes: `pnpm -C api build`, and `pnpm -C web build` (`pnpm -C web typecheck` for a quick check).
- [ ] The relevant tests pass (see [Tests](#tests)), including new ones for new behavior and a regression test for a bug fix.
- [ ] `pnpm -C api build && node scripts/lint-check.mjs` passes: no rule's count above the baseline. The type-aware rules need api's build to see the workspace packages.
- [ ] A schema change ships as a migration, applies on a fresh database, reverts, and `pnpm -C api db:check` says "No drift".
- [ ] UI changes have screenshots at 375 and 1440 px, light and dark, and axe stays at zero serious or critical issues.
- [ ] New environment variables are in the `.env.example` files and the PR description.
- [ ] Docs are updated where behavior changed: the README, `docs/DEPLOYMENT.md`, and for a phase its roadmap row and its line in `docs/FEATURES_AND_ROADMAP.md`.

## Backend rules

**Services own their data.**
- Each service has its own Postgres schema.
- **Writes across services** happen through events on RabbitMQ.
- **Reads across services** go through the internal API.
- Never query another service's schema.

**Migrations.**
- Write them as described in the README's [Changing the schema](README.md#changing-the-schema).
- Read the generated SQL every time.
- Enum values, renames and indexes on tables with data are written by hand.

**Money and entitlements.**
- **Anything that moves money or grants access is idempotent.** A retried webhook, a double click or a redelivered event must not pay, refund or enrol twice. Use the existing patterns: unique keys and conditional updates that make a repeat a no-op.
- Payments are confirmed only after the server re-checks them with Chapa.
- Only the enrollment service grants access.

**Validate at the edge.**
- DTOs validate every request.
- Route parameters that are ids are UUIDs.
- List endpoints are paged, with a bounded `limit`.

**Authorization on every endpoint.**
- Check both the role and ownership ("is this your course?").
- Internal routes need the internal token.
- Never trust identity headers from the client: the gateway sets them.

**Errors.**
- Return a proper status code (400, 403, 404, 409, 503) with a message that leaks nothing internal.
- Don't swallow errors.
- Log with context, but never log emails, tokens, links or secrets.

**Queries.**
- No query inside a loop over rows (N+1): batch it.
- Add an index with the query that needs it.

**Configuration.**
- Configuration comes from environment variables.
- Production refuses to boot with a missing or weak secret. Keep it that way when you add one.

## Frontend rules

**Colors.**
- Use the roles in [COLOR_SYSTEM.md](docs/COLOR_SYSTEM.md) (`text-danger`, `bg-brand-50`, `text-muted-foreground`), never Tailwind palette classes (`text-red-600`) or hex values.
- Check both themes.
- Never use color as the only signal.

**Building blocks.** Use the shared components before writing new ones:
- `PageShell` and `PageHeader` (`components/PageChrome.tsx`) for every page;
- `Field` (`components/form/`) for labelled inputs with errors;
- `FormStatus` for results;
- `useConfirm` (`components/confirm/`) for money-moving and destructive actions;
- the status-label map for enums in `web/src/lib/labels.ts` (people see "Payment not finished", not `pending`);
- the date and price formatters in `web/src/lib/format.ts`.

**Accessibility is part of the feature.**
- Keyboard works everywhere, and focus is visible.
- Every input has a label, and images have alt text (or are marked decorative).
- Text is at least 4.5:1.
- Touch targets are at least 44 px on phones.
- No horizontal scroll at 375 px.
- Respect reduced motion.

**Language.**
- Learner-facing strings go through `web/src/lib/i18n.tsx`, with the key added to both `en` and `am`. The key-parity test fails otherwise.
- New Amharic strings are listed for a native speaker's review.

**Sleeping servers.**
- Public pages must not show "not found" or "invalid" just because the API is waking up. Use the existing waking-up handling.
- Prefer static or ISR rendering for public pages.

**Performance.**
- Load heavy libraries only when needed.
- Images have a size.
- No layout shift on load.

## Tests

| What | Command | Notes |
|---|---|---|
| Backend unit (jest) | `pnpm -C api test` | Fast. Run it always. |
| Web unit and component (vitest) | `pnpm -C web test` | Includes the i18n key-parity test. |
| Typecheck | `pnpm -C api typecheck` · `pnpm -C web typecheck` | |
| Lint against the baseline | `pnpm -C api build && node scripts/lint-check.mjs` | Build api first, as CI does, so the counts match. `--update` rewrites the baseline after a PR lowers it. |
| Schema drift | `pnpm -C api db:check` | Read-only. Run it against a database you migrated. |
| End-to-end API flows | `node scripts/demo-seed.mjs`, `node scripts/e2e-*.mjs` | Need the stack running and seeded. CI runs all of them. |
| Browser (Playwright, axe) | `pnpm -C web build && pnpm -C web e2e` | Runs against a production build with the stack up and seeded. See the login-budget note below. |

**Test behavior, not implementation.** A test should fail when the feature breaks. Don't mock the code under test, and don't add snapshot tests that stand in for assertions.

**Playwright's login budget.** The gateway allows 10 credential calls a minute per IP (log in, sign up, verify, resend, reset), and the suite spends 8 of them. A new spec reuses a stored login (`e2e/.auth/<role>.json`) instead of logging in. Run the full suite at most once a minute.

## Security

**Secrets.**
- Never commit a secret or a real `.env`. `gitleaks` scans every PR (the `secret-scan` check).
- If you committed one by mistake, tell the owner. Don't just delete it in a new commit, because it stays in the history.

**Reporting a vulnerability.**
- Use GitHub's private reporting: the repo's **Security** tab → **Report a vulnerability**.
- Don't open a public issue or PR, or describe the problem in a discussion.
- Fixes for reported issues are planned privately and published once deployed.

**Writing about security in this public repo.**
- PR descriptions, commit messages and committed docs describe the outcome ("payments are confirmed exactly once"), not how to exploit what was fixed.
- Details stay in local notes until the fix is live.

## Production

Production is one environment: Render's free tier for the API (the gateway and seven services), Vercel for the web, and Neon Postgres. See [DEPLOYMENT.md](docs/DEPLOYMENT.md).

**Only the owner (`@Kalkidan-Amare`):**
- accesses the production database;
- sets production environment variables and secrets on Render, Vercel and Neon;
- changes repository settings;
- runs the post-deploy checks.

**A PR that needs one of those** (a new env var, a data check before a migration) lists the exact steps under "Deploy checks". The owner does them before the merge.

**Free-tier constraints are real.** Services sleep when idle and share 750 instance-hours a month. Anything scheduled or always-on needs a plan.

## Proposing a change

- **A bug:** open an issue with steps to reproduce, what you expected and what happened. Add a screenshot for UI.
- **A feature or a bigger change:** open an issue describing the problem first. If it's accepted, it gets a plan (and a phase, if it's large).
- **A small fix:** a PR with a clear description is fine.

Questions go in an issue as well. Security problems are the exception: they go through private reporting, as described above.
