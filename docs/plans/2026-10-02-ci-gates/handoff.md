# Handoff: Phase 11a, CI/CD gates and repo hygiene

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 1, with S1–S3 and N1–N3 folded in; see [plan-review.md](plan-review.md))
Code review goes to: ethio-plan-review (size M)

## What to build
- A repository ruleset on `main`, as reviewed JSON the user applies.
  - It requires a PR and five checks from GitHub Actions: `api`, `web`, `e2e`, `secret-scan` and `lint`.
  - Direct pushes are refused for everyone, the admin included.
- `autoDeployTrigger: checksPass` on every Render service, so Render deploys only after CI passes.
- Dependabot for npm, GitHub Actions and the Docker base images, plus an `audit` job that never fails.
- ESLint in both packages, with a `lint` job that fails only when the warning count rises above a stored baseline.
- CI hygiene:
  - read-only permissions, concurrency and timeouts;
  - a build-only Docker check instead of the unused GHCR pushes;
  - wait loops that fail on timeout.
- Cache-friendly, digest-pinned, production-only Docker images.
- Complete env examples.
- One true `docs/DEPLOYMENT.md`, including the web-before-API deploy skew.
- Repo clean-up: `docs/history/`, a PR template and CODEOWNERS.

## Read first, in order
1. `plan.md` decisions 1–8, then `plan-review.md` round 1:
   - S1: `bypass_mode: "pull_request"`;
   - S2: `lint` is required, and `audit` always concludes `success`;
   - S3: the web-before-API skew goes in the docs and the PR-template question;
   - N1: Dependabot's `docker` ecosystem;
   - N2: `integration_id: 15368` on each required check;
   - N3: links updated on the `docs/history/` move.
2. `.github/workflows/ci.yml` in full, including what Phases 5, 7a and 9a changed in the `e2e` job, and the 9c jobs workflow.
3. `render.yaml`, `docker-compose.yml`, `api/Dockerfile`, `web/Dockerfile` and both `.dockerignore` files.
4. `DEPLOYMENT.md` (root), `docs/DEPLOYMENT.md` and `README.md`. The root `DEPLOYMENT.md:123-141` holds Phase 2's first-rollout steps, which move verbatim.
5. `api/.env.example` and `web/.env.example`.

## Decisions already made (don't relitigate)
- **A ruleset, not legacy branch protection:**
  - `.github/rulesets/main.json`: a pull request with 0 required approvals;
  - required checks `api`, `web`, `e2e`, `secret-scan` and `lint`, strict (up to date), each with `integration_id: 15368`;
  - `non_fast_forward` and `deletion`;
  - the admin bypass uses `"bypass_mode": "pull_request"`;
  - `audit` and `docker-build` are not required. Neither is the 9c jobs workflow.
- **Render:** `autoDeployTrigger: checksPass` per service, confirmed against Render's current Blueprint reference, with the source logged. If the Blueprint doesn't support it, the fallback is the dashboard setting, listed in Rollout for the user.
- **Dependabot:**
  - ecosystems: `npm` in `/api` and `/web`, `github-actions` in `/`, `docker` in `/api` and `/web`;
  - weekly on Monday, with the groups from decision 3 and `open-pull-requests-limit: 5`;
  - majors of `next`, `react` and `@nestjs/*` are ignored until 11c.
- **`audit` never fails:** step-level `continue-on-error`, then a summary step and a warning annotation.
- **Lint:**
  - flat configs: `next/core-web-vitals` for web; `typescript-eslint` recommended plus `no-floating-promises` for api;
  - `.github/lint-baseline.json` and a script to regenerate it when a PR lowers the count;
  - no Prettier, and no big-bang fix of existing warnings.
- **CI hygiene:**
  - top-level `permissions: contents: read`;
  - `concurrency: ci-${{ github.ref }}`, cancelling in progress for PRs only;
  - timeouts: `api` 15, `web` 15, `e2e` 40, `secret-scan` 10 minutes;
  - delete `docker-api`/`docker-web`, and add a `docker-build` job (no push) on PRs touching a Dockerfile, `.dockerignore` or a lockfile.
- **Vercel isn't gated on CI** (Non-goals). The skew is handled by the docs and the PR template.
- **The user decides:** the license (none is added), the `SUPPORT_EMAIL` role mailbox (the value stays until they create one), and every outward-facing setting.
- **One environment, documented:** the hard-coded `onrender.com` URLs stay, because free services have no private network.
- **Non-goals hold:** no coverage thresholds (11b), no dependency bumps (11c), no staging environment, and no changes to what CI tests.

## Gotchas learned while planning
- **Only read-only GitHub calls.** The agent runs `gh api` GETs (step 1, and the auth check in step 6). Applying the ruleset, the `security_and_analysis` PATCH and Render's trigger are the user's (Rollout).
  - GitHub has no dry-run for creating a ruleset, so a `POST` would apply it. Validate `main.json` locally instead: `jq` plus a check of each field against GitHub's REST docs for rulesets. Never `POST`.
- **Draft-PR checks wait for the user.** Steps 2, 5 and 9 and the Test plan want a draft PR run. Pushing needs the user's OK and the branch rule below, so:
  - verify everything you can locally first: `actionlint` if available, YAML parse, the lint baseline script, the docker builds;
  - log the draft-PR confirmations as pending in Progress: job names unchanged plus `lint`, `audit` concluding `success` with a finding, the lint job failing on a scratch extra warning, timeouts and concurrency;
  - ask the user before pushing a draft.
- **Secrets:**
  - the secret-guard hook scans untracked files for `api/.env` values, which reuse the `.env.example` dev defaults;
  - env examples and docs get variable names and obviously fake values only. Never copy a value from `api/.env`, `render.yaml` secrets or the dashboard;
  - CODEOWNERS uses the owner's GitHub handle from the remote, not an email.
- **Docker digests:** pin `node:22-alpine` by digest, and keep 9c's `tini` entrypoint. Measure a rebuild after a source-only change, to show the install layer is reused (timings in Progress).
- **Docs:** read each claim against `render.yaml` and the code, not older docs. Phase 2's first-rollout steps move verbatim. The root `DEPLOYMENT.md` becomes a three-line pointer.
- **The plan folder isn't security-sensitive.** Commit it on your branch, staging paths explicitly (several plan folders are untracked).
- **Environment:**
  - the node PATH export (`/home/kal/.local/opt/node22/bin`);
  - Postgres on 55432;
  - the pnpm `--store-dir /home/kal/snap/code/current/.local/share/pnpm/store/v3` flag (needed when adding the ESLint devDependencies to each package's own lockfile);
  - e2e on `.env.example` values only;
  - production is off-limits.

## How to run
- **API:** `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck`, plus `pnpm -C api lint`.
- **Web:** `pnpm -C web build && pnpm -C web test`, plus `pnpm -C web lint`.
- **Lint baseline:** the comparison script passes at the baseline and fails with one extra warning added locally (then reverted).
- **Docker:** one `docker build` per image (an api service and web).
- **E2E:** the CI e2e scripts and Playwright still pass locally, since the workflow's `e2e` job changes only in timeouts and wait-loop exits.

## Branch
Create `chore/ci-gates` from the tip of the stack when it starts (expected `feat/web-hardening`). Don't push until everything below has merged; then `git merge origin/main`.

## Rollout notes for the PR description (the user does these)
1. Merge this PR while `main` is still unprotected.
2. Apply the ruleset with the `gh api -X POST …/rulesets` command in the plan.
3. Enable secret scanning, push protection and Dependabot security updates (the plan's `PATCH`, or Settings → Code security).
4. If the Blueprint didn't apply `autoDeployTrigger`, set each Render service to "After CI checks pass".
5. Optional: a license, and a role mailbox for `SUPPORT_EMAIL`.

## Definition of done
- The acceptance criteria are met.
- Every local check passes, and the draft-PR confirmations are done or logged as pending the user's push OK.
- The checklist is ticked, with deviations logged.
- Then request code review from ethio-plan-review.

## Amendment 2026-10-03 (ethio-planner [aeff2b]): parallel track, overrides "Branch" and the push gotcha above
- **Base:** create `chore/ci-gates` from `origin/main` now, in its own worktree `../ethi0-11a`. It runs in parallel with the backend stack (9a–9e) and Phase 10.
- **Docs and env examples describe what is on `main` when 11a merges.** Write the Jobs (9c), Logs (9d), Outbox (9b) and CSP (10) sections only if that phase has merged by then; each later phase adds its own section (their handoffs say so). Don't write docs for code that isn't on `main`.
- **Pushing a draft PR is now authorized** (standing authorization in `~/.claude/CLAUDE.md`): push the draft for the CI confirmations (steps 2, 5, 9 and the Test plan) without asking. Never POST the ruleset or PATCH repo settings; those stay the user's (Rollout).
- **Merge `origin/main`** before the gate and before the PR; other tracks will have touched `ci.yml` (9a's `/ready` wait) and the Dockerfiles (9c's `tini`), so resolve those by keeping both.
- **Lint baseline:** generate it on the head you'll merge, after the last `origin/main` merge.
- **Before the merge:** send ethio-planner [aeff2b] the Rollout steps as exact, tested commands (ruleset POST, `security_and_analysis` PATCH, the Render trigger if the Blueprint can't set it). They go into USER-ACTIONS for the user to run right after the merge.
- **Stack window:** one local stack for every track. Builds, unit tests, lint and `docker build` run any time; the e2e scripts and Playwright only in your window. Ask the holder and hand it on when done.
