# Phase 11a: CI/CD gates and repo hygiene

Status: approved (round 1, S1–S3 and N1–N3 folded in)
Size: M (sessions: 3 — ethio-impl implements, ethio-plan-review reviews plan and code). CI config, repo files and docs, plus GitHub and Render settings that only the user can apply.
Base branch: `origin/main` (amended 2026-10-03: runs in parallel with 9a–9e and 10; docs cover what is on `main` when it merges, and later phases add their own sections). Earlier: the tip of the stack, expected `feat/web-hardening` (Phase 10). · Feature branch: `chore/ci-gates`
Roadmap: phase 11, split into 11a (this plan), 11b (auth transport and tests for high-risk code) and 11c (dependencies and Next 15). See "Roadmap change" at the end.
Findings: P1-24, P1-26, P1-28, P2-16, P2-17, P2-18, P2-19, P2-20, P2-21, and the documentation half of P0-09's ops part. The scheduling half went to 9c.

## Goal
Nothing reaches production without passing CI and review. Dependencies and leaked secrets are watched automatically. The repo's docs describe the deployment that actually exists. CI itself is fast, bounded and honest about failures.

Acceptance criteria:
- **Gates (P1-24):**
  - a ruleset on `main` requires a pull request, the `api`, `web`, `e2e`, `secret-scan` and `lint` checks (from GitHub Actions only), and an up-to-date branch, and blocks force-pushes and deletion. Nobody can push to `main` directly, the admin included; the admin can only merge a PR past the rules;
  - Render deploys only after checks pass (`autoDeployTrigger: checksPass` on every service in `render.yaml`, confirmed against Render's current Blueprint spec);
  - these settings are applied by the user from the commands in Rollout.
- **Watching (P1-26):**
  - `.github/dependabot.yml` covers npm in `/api` and `/web`, GitHub Actions, and the Docker base images in `/api` and `/web`, weekly, grouped, with an open-PR limit;
  - a non-blocking `audit` job runs `pnpm audit --prod --audit-level high` for both workspaces;
  - the user enables secret scanning and push protection (free on public repos).
- **Lint (P2-17):**
  - ESLint runs in CI for `web` (`eslint-config-next` core-web-vitals) and `api` (`typescript-eslint` recommended);
  - warnings don't fail it; a stored baseline count does: `lint` is a required check that fails only when a PR raises the count.
- **CI polish (P2-19):**
  - top-level `permissions: contents: read`, `concurrency` per ref with cancel-in-progress for PRs, and `timeout-minutes` on every job;
  - the GHCR image pushes nothing deploys are replaced by a build-only Docker check on PRs that touch Dockerfiles;
  - every wait loop fails its step on timeout.
- **Docker (P2-18):**
  - dependencies are installed before sources are copied, so code changes don't reinstall;
  - `.dockerignore` excludes `.turbo`, `coverage`, `.next` and test files;
  - base images are pinned by digest;
  - the runtime image ships `dist` and production dependencies only;
  - 9c's `tini` entrypoint stays.
- **Env examples (P2-20):** `api/.env.example` and `web/.env.example` list every variable the code reads in production, with one-line comments and obviously fake values. The variables added by Phases 2–10 are included.
- **Docs (P1-28, P0-09):**
  - one `docs/DEPLOYMENT.md` describes the real Render-plus-Vercel setup: public services behind the internal token; the SMTP port; the cold-start behaviour and Phase 5's wake; the jobs schedule from 9c; logs from 9d; migrations and the first-rollout steps from Phase 2, kept verbatim;
  - the root `DEPLOYMENT.md` becomes a pointer;
  - the README stops claiming a private network, GHCR deploys, Node 20 and a self-healing sweep;
  - "Gates" says plainly that the web deploys on Vercel as soon as a PR merges, while Render waits for CI (up to about 45 minutes), so every merge runs new web against the old API for that long.
- **Repo hygiene (P2-16):**
  - historical notes move to `docs/history/`, with every link to them updated;
  - the empty root `package-lock.json` is removed;
  - a PR template (including "Does the web still work against the previous API until Render deploys?") and CODEOWNERS are added;
  - the license and the support address are left to the user (decision 6).
- **Single environment (P2-21):** documented as a deliberate free-tier choice, with what a staging environment would need. No new services.

## Non-goals
- **Making every lint warning an error** in this phase (later, once the baseline is zero). The `lint` check blocks only a rising count.
- **Gating Vercel's production deploy on CI.** It would need a Vercel token in GitHub and a deploy workflow in place of the Git integration. The web-before-API skew is handled by the PR-template question and the docs instead.
- **Test coverage thresholds** (11b adds the tests; a threshold can follow).
- **A staging or preview environment** (decision 7).
- **Changing what CI tests.** Phases 1, 2, 5, 7a and 9a already shaped the `api`, `web` and `e2e` jobs.
- **Bumping dependencies** (11c).

## Current state
From the Phase 11 research; GitHub settings are unverified, so the implementer checks them read-only with `gh api`.

- **CI** `.github/workflows/ci.yml`:
  - triggers on push to `main` and every pull request;
  - no top-level `permissions`, no `concurrency`, no `timeout-minutes`;
  - jobs: `secret-scan` (gitleaks v8.30.1 in Docker, full history), `api`, `web`, and `e2e` (`needs: api`; Phase 5 adds Playwright, 7a axe, and 9a changes the wait to `/ready`);
  - `docker-api` and `docker-web` push GHCR images on `main` (`ci.yml:120-178`) that nothing consumes, because Render builds from the repo;
  - the gateway health loop exits 0 on failure (`:92`), unless 9a has already changed it.
- **Render** (`render.yaml`):
  - eight free Docker web services on `branch: main` with no `autoDeploy`/`autoDeployTrigger`, so each one deploys on every push;
  - `CHAPA_MODE: live`;
  - hard-coded `onrender.com` URLs (`:111-112,162-174`);
  - `SUPPORT_EMAIL` is a personal address (`:91-92`).
- **GitHub:** per the audit and the Phase 1 plan, `main` has no protection or rulesets, and Dependabot, secret scanning and push protection are off. The repo is public.
- **Lint:** none. No ESLint or Prettier config or script.
- **Docker:**
  - `api/Dockerfile` copies sources before install;
  - floating `node:22-alpine` tags (Phase 1 moved off 20);
  - the runtime ships `src`, `tsbuildinfo` and `@types`;
  - `.dockerignore` misses `.turbo` and `coverage`;
  - `web/Dockerfile` is for self-hosting only.
- **Docs that contradict reality:**
  - `DEPLOYMENT.md:11,24` (web on Render), `:20,34` (GHCR deploys), `:33` (`SMTP_PORT=587`, but `render.yaml` uses 2525), `:37` versus `:67-79` (keep-alive), `:108` (private network), `:149` (the payouts schedule), `:18` (standalone);
  - `docs/DEPLOYMENT.md:17,31-32,34-38,53,78-79` (private-network claims), `:57` (single replica);
  - `README.md:46` (GHCR), `:41,160` (automatic sweep).
  - `DEPLOYMENT.md:123-141` holds Phase 2's first-rollout steps, which must survive.
- **Repo clutter (P2-16):**
  - tracked `HANDOFF.md`, `PRODUCT_ROADMAP.md`, `FEATURES_ADDED.md`, `UPDATES_2026-09-24.md` and `TESTING_AND_FIXES_2026-09-18.md`;
  - an empty root `package-lock.json`;
  - no LICENSE, CONTRIBUTING, CODEOWNERS or PR template.
  - Phase 1 already fixed the `.gitignore` prefixes and untracked `.claude/settings.local.json`.

## Design and key decisions
1. **A repository ruleset, not legacy branch protection:**
   - one ruleset on `main`, as JSON in `.github/rulesets/main.json`, versioned so it's reviewable and re-applicable;
   - **rules:** pull request (0 required approvals, because the user is the only human; the agents' reviews are recorded in the plan folders), required status checks `api`, `web`, `e2e`, `secret-scan` and `lint` with strict (up-to-date) mode, each with `integration_id: 15368` (GitHub Actions) so a status posted under the same name by anything else can't satisfy it, `non_fast_forward`, `deletion`;
   - `audit` (never fails, decision 3) and the path-filtered `docker-build` (it doesn't run on every PR) aren't required;
   - **bypass:** the repository admin role with `"bypass_mode": "pull_request"`. Every session pushes as the user, who is the admin, so the default `always` would let any `git push origin main` land without a PR or checks, and Render would deploy it once CI went green. With `pull_request`, direct pushes are refused for everyone, and an emergency goes through a PR the admin can merge past the rules, visible in the audit log;
   - **apply:** the user runs `gh api -X POST repos/<owner>/<repo>/rulesets --input .github/rulesets/main.json`. It's outward-facing, so the agent doesn't.
   - The jobs workflow from 9c runs only on `schedule`/`workflow_dispatch`, so it doesn't need to be a required check.
2. **Render deploys after checks:**
   - each service in `render.yaml` gets `autoDeployTrigger: checksPass`. The implementer confirms the exact key against Render's current Blueprint reference, and logs the source;
   - if the Blueprint doesn't support it, the plan falls back to the per-service dashboard setting "Auto-Deploy: After CI checks pass", listed in Rollout for the user.
3. **Dependabot and audit:**
   - `dependabot.yml`: `npm` in `/api` and `/web`, `github-actions` in `/`, and `docker` in `/api` and `/web` (so the digest-pinned base images still get patched), weekly on Monday;
   - groups: `nestjs` (`@nestjs/*`), `typeorm` and `pg`, `testing` (jest, vitest, testing-library), `next-react` (`next`, `react`, `react-dom`, `eslint-config-next`), and everything else minor or patch;
   - `open-pull-requests-limit: 5`;
   - major versions of `next`, `react` and `@nestjs/*` are ignored until 11c has moved them.
   - The `audit` job never fails: its audit steps use step-level `continue-on-error: true`, and a last step writes the findings to the job summary and as a warning annotation. The job's check therefore always concludes `success`, so it can't hold up Render's `checksPass`. P1-08's fixes are 11c's.
4. **Lint without a big-bang cleanup:**
   - **configs:** `web/eslint.config.mjs` (flat config, `next/core-web-vitals`) and `api/eslint.config.mjs` (`typescript-eslint` recommended, plus `no-floating-promises` for services, which catches 9a-style unawaited calls);
   - **scripts:** `lint` in both packages;
   - **CI:** a `lint` job runs both and compares the warning count with `.github/lint-baseline.json`. It fails only if the count went up, and prints the new warnings. It is a required check, so a PR can't merge with a raised count, and `main` never carries a red `lint` that would stop Render's `checksPass` deploys.
   - The baseline is regenerated with a script when a PR lowers it.
   - Rejected: fixing every warning now (a huge mechanical diff over code six phases just reshaped) or Prettier (formatting churn with no correctness value).
5. **CI hygiene:**
   - `permissions: contents: read` at the top; jobs that need more declare it;
   - `concurrency: ci-${{ github.ref }}`, with `cancel-in-progress` for pull requests only;
   - `timeout-minutes` per job: `api` 15, `web` 15, `e2e` 40, `secret-scan` 10;
   - **Docker:** delete `docker-api`/`docker-web`. A `docker-build` job runs on pull requests that touch a Dockerfile, `.dockerignore` or lockfiles, with `docker build` and no push.
6. **Things only the user decides** (Rollout asks them; nothing is assumed):
   - **License:** with no LICENSE file the code stays all-rights-reserved. Adding one is the owner's choice. The plan adds none.
   - **Support address:** `SUPPORT_EMAIL` in `render.yaml` and `docker-compose.yml` should be a role mailbox. The user creates it, then the value is changed. Until then it stays.
   - **CODEOWNERS** names the repo owner's GitHub handle, which is in the git config and the remote.
7. **One environment, documented:**
   - `docs/DEPLOYMENT.md` gets an "Environments" section: production only, why (eight free services already use the instance-hour budget), what a staging setup needs (a second set of services with `CHAPA_MODE=mock` and a separate database branch, or Render's paid preview environments), and that local docker-compose plus CI's e2e stack is the pre-production check.
   - The hard-coded `onrender.com` URLs stay. Free services can't use Render's private network, and the gateway needs public URLs.
8. **Docs: one source of truth:**
   - `docs/DEPLOYMENT.md` becomes the single deployment doc, written from `render.yaml`, `web` on Vercel and the env examples. Sections:
     - Topology: public services and the internal token;
     - Environment variables, linking the two `.env.example` files;
     - Migrations and First rollout, moved verbatim from Phase 2;
     - Cold starts and waking (Phase 5);
     - Jobs (9c);
     - Logs (9d);
     - Outbox (9b);
     - Security headers and CSP (Phase 10);
     - Gates (this phase): the ruleset, `checksPass`, and the deploy skew. Vercel deploys the web on the merge commit at once, while Render waits for CI (`e2e` alone may take 40 minutes). So after every merge the new web runs against the old API for up to about 45 minutes, not the few minutes of a Render build. Every API change must keep the previous web working, and every web change must work against the previous API; the PR template asks the second question;
     - Environments.
   - The root `DEPLOYMENT.md` keeps a three-line pointer, so old links still land.
   - The README's architecture and CI claims are corrected to match.
   - Moving the historical notes to `docs/history/` updates every link to them (`git grep -n` each file name in README and docs), so no link breaks.
   - The implementer reads each claim against the code, not against older docs.

## Steps
- [ ] 1. Branch `chore/ci-gates` from the base above. Check GitHub settings read-only:
  - `gh api repos/<owner>/<repo>/rulesets`;
  - `gh api repos/<owner>/<repo>/branches/main/protection`;
  - `gh api repos/<owner>/<repo> --jq .security_and_analysis`.

  Record the results in Progress.
- [ ] 2. CI hygiene and the Docker build check (decision 5). Check locally (`actionlint` if available, and reading the YAML) that the required job names are exactly `api`, `web`, `e2e`, `secret-scan` and `lint`. The draft-PR run that confirms them comes after the user OKs a push (see the Test plan).
- [ ] 3. Docker (P2-18): reorder layers, `.dockerignore`, digest-pinned bases, a production-only runtime. · Verify: `docker build` for one service and for web succeeds; a rebuild after a source-only change reuses the install layer (timings in Progress).
- [ ] 4. Lint (decision 4): configs, scripts, the baseline file and script, the CI job.
- [ ] 5. Dependabot (including the `docker` ecosystem) and the audit job (decision 3). On the draft-PR run (after the user OKs a push), confirm the `audit` check concludes `success` even with a finding.
- [ ] 6. Ruleset JSON and `autoDeployTrigger` (decisions 1, 2). GitHub's ruleset API has no dry run: a `POST` would apply the ruleset. So validate the JSON with `jq` against the REST reference for rulesets, and never `POST`. A `GET` of the rulesets endpoint confirms auth; the `POST` is the user's. Check that the JSON has `bypass_mode: "pull_request"`, the five required checks and `integration_id: 15368` on each. Confirm from Render's docs which checks `checksPass` waits for, and log it.
- [ ] 7. Env examples (P2-20): grep every `process.env.X` and `env('X'` in `api/` and `web/`, list them, and add any that are missing with comments and fake values. The secret-guard hook scans untracked files for real values, so write names and fake values only.
- [ ] 8. Docs (decision 8) and repo hygiene (P2-16): `docs/history/` with links updated, remove the root `package-lock.json`, add `.github/pull_request_template.md` (with the web-against-previous-API question) and `CODEOWNERS`.
- [ ] 9. Full gate: every CI job on the PR is green, and the `lint` job passes at the baseline. Locally, `pnpm -C api build && pnpm -C api test`, `pnpm -C web build && pnpm -C web test`, and one docker build per image.
- [ ] 10. Code review by ethio-plan-review; the user approves push and PR, then applies Rollout.

## Test plan
- **CI itself** is the test. The branch can't be pushed before the stack below has merged, so impl first verifies what it can locally (the lint baseline script, `docker build`, the YAML) and logs the CI confirmations as pending. Once the user OKs a push, a draft PR shows each job, timeout, concurrency and the Docker build check, and the lint job fails when a deliberate extra warning is added in a scratch commit (then reverted).
- **Docs:** the reviewer samples claims against `render.yaml` and the code.

## Rollout and ops (the user)
1. Merge this PR while `main` is still unprotected.
2. Apply the ruleset: `gh api -X POST repos/<owner>/<repo>/rulesets --input .github/rulesets/main.json`.
3. Enable secret scanning, push protection and Dependabot security updates:
   `gh api -X PATCH repos/<owner>/<repo> -f 'security_and_analysis[secret_scanning][status]=enabled' -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled' -f 'security_and_analysis[dependabot_security_updates][status]=enabled'`
   (or the repository's Settings → Code security).
4. **Render:** if the Blueprint sync didn't apply `autoDeployTrigger`, set each service to "After CI checks pass" in the dashboard.
5. **Optional decisions:** pick a license if you want one; create a role mailbox for `SUPPORT_EMAIL` and tell the planner.

## Risks and open questions
- **The ruleset blocks direct pushes to `main` for everyone,** the admin and the agents' docs-only pushes included (`bypass_mode: pull_request`). Every change goes through a PR, which is the point.
- **`checksPass` on Render** waits for the checks on the commit. `audit` always concludes `success` and `lint` is required, so neither can strand a commit on `main` undeployed. `docker-build` doesn't run on `main` pushes.
- **Web deploys before the API** by up to about 45 minutes after each merge (decision 8, Gates). Phases so far handled that case by case; from here on it's the PR-template question.
- **Dependabot's first run** opens grouped PRs. The limit keeps it to five.

## Roadmap change (planner)
The roadmap's Phase 11 combines CI/CD gates, repo docs, the auth transport (P1-07), the high-risk tests (P1-29) and the dependency and Next 15 upgrade (P1-08). Those carry different risk and reviewers, so it is split into three parts:
- **11a (this plan, M):** CI/CD gates and repo hygiene.
- **11b (L, ethio-reviewer):** same-origin API and in-memory access token (P1-07), plus tests for the highest-risk paths (P1-29).
- **11c (M):** dependencies and Next 15 (P1-08). It goes last, so the upgrade lands with every test already in place.

The jobs scheduler from P0-09's ops part moved to 9c, where the job endpoints live.

## Progress and deviations (implementer)
ethio-impl, worktree `../ethi0-11a`, branch `chore/ci-gates` (from origin/main; merged origin/main at `d8140db`, 8b).

- **Step 1, GitHub settings (read-only `gh api`):**
  - `rulesets` → `[]`;
  - `branches/main/protection` → 404 (not protected);
  - `security_and_analysis`: every feature disabled;
  - the repo is public, owned by an org.
- **Step 3, Docker (`8e1d18b`):**
  - api: `pnpm fetch` from the lockfile, then sources, `install --offline`, build, `pnpm deploy --prod /out`;
  - the runtime copies only `package.json`, `node_modules` and `dist` and runs as a non-root `app` user;
  - both stages use `node:22-alpine@sha256:0a7108bf…`;
  - web: install before the build ARGs and sources, so a source or arg change reuses the install layer;
  - `.dockerignore` files exclude `.turbo`, `coverage`, `.next`, test files and `.env*`.
  - **Timings:**
    - api (auth): 72 s cold, 32 s after a source-only change (`pnpm fetch` CACHED, the offline install 1.3 s);
    - the image is 347 MB, against 348 MB before. `/app` is 93 MB of `dist`, production `node_modules` and `package.json`, and the image boots up to the env check;
    - web: 63 s cold, 57 s after a source-only change (install CACHED).
  - **Deviation:** web's `.dockerignore` excludes `e2e/**/*.spec.ts`, not all of `e2e/`, because `playwright.config.ts` imports `e2e/support` and the build type-checks it.
  - 9c's `tini` isn't on main yet. When it merges, keep it.
- **Step 4, lint (`8def874`):**
  - api: ESLint 9 with `typescript-eslint` 8, recommended rules, plus type-aware `no-floating-promises` on `gateway`/`services`/`packages` sources (not specs);
  - web: ESLint 8.57 with `eslint-config-next@14.2.35` through FlatCompat. ESLint 9 needs eslint-config-next 15, which is 11c;
  - `scripts/lint-check.mjs` compares counts **per rule**, not one total, so fixing one rule can't hide a new finding of another. `--update` rewrites `.github/lint-baseline.json`;
  - baseline: api 204 (any 131, floating-promises 48, unused-vars 13, unsafe-function-type 10, require-imports 1, prefer-const 1), web 4;
  - `web/public/**` is ignored: it's vendored MediaPipe wasm glue, which tripped `rules-of-hooks`;
  - **check:** a scratch `export const probe: any = 1;` made the check exit 1 and print the `no-explicit-any` findings; reverted.
  - The 48 floating promises are worth a look in a later phase.
- **Step 2, CI (`b881fae`):**
  - top-level `permissions: contents: read`;
  - concurrency `ci-${{ github.ref }}`, cancelling only for PRs;
  - timeouts: api 15, web 15, e2e 40, secret-scan 10, lint 10, audit 10;
  - the gateway wait now fails the step if `/health` never answers;
  - `docker-api`/`docker-web` (the GHCR pushes) are deleted;
  - new `lint` and `audit` jobs;
  - `docker-build` lives in its own workflow, `.github/workflows/docker.yml`, because path filters work per workflow. It runs on PRs touching the Dockerfiles, the `.dockerignore` files or the lockfiles, as a 9-image matrix, with no push;
  - **check:** actionlint (Docker image) reports nothing; `ci.yml`'s jobs are `secret-scan`, `api`, `web`, `e2e`, `lint` and `audit`.
- **Step 5 (`77f0e63`):**
  - Dependabot: npm in `/api` and `/web`, github-actions in `/`, and docker in `/api` and `/web` (`directories`);
  - weekly on Monday, limit 5;
  - groups: nestjs, typeorm-pg, testing, next-react, minor-and-patch;
  - ignores majors of `@nestjs/*`, `next`, `eslint-config-next`, `react`, `react-dom`, and also `eslint`, which needs Next 15;
  - validated with `check-jsonschema --builtin-schema vendor.dependabot`.
  - `audit`: step-level `continue-on-error`, and a summary step that writes the findings and a `::warning`.
- **Step 6 (`493ff1c`):**
  - `.github/rulesets/main.json`: deletion, non_fast_forward, pull_request (0 approvals), and required_status_checks (strict) for the five checks, each with `integration_id: 15368`;
  - `gh api apps/github-actions` confirms id 15368;
  - bypass: `RepositoryRole` id 5 (admin; source: terraform-provider-github `docs/resources/repository_ruleset.md`, "base repository roles and their associated IDs"), with `bypass_mode: pull_request`;
  - the fields were checked against GitHub's REST "Create a repository ruleset" reference and with `jq`. Never POSTed.
  - `render.yaml`: `autoDeployTrigger: checksPass` on all 8 services. Sources:
    - render.com/docs/blueprint-spec: values `commit`/`checksPass`/`off`; it replaces `autoDeploy`;
    - render.com/docs/deploys: Render waits for GitHub Actions and Checks API checks. `success`/`neutral`/`skipped` pass. A commit with zero checks or one failed check isn't deployed.
- **Step 7 (`d0168ef`):**
  - `api/.env.example` gained the 16 variables the code read but the example lacked: PORT, SERVICE_NAME, REQUIRE_INTERNAL_TOKEN, CORS_ORIGINS, COOKIE_SAMESITE, PROXY_*, INTERNAL_HTTP_TIMEOUT_MS, DB_POOL_*, DB_LOGGING, DB_SLOW_QUERY_MS, DB_SSL, DB_SSL_STRICT and MAX_VIDEO_UPLOAD_BYTES. All are commented out, with their code defaults;
  - `web/.env.example` gained `GATEWAY_INTERNAL_URL`;
  - left out on purpose: `BUILD_STANDALONE` (set by the Dockerfile), `OG_PROOF_DIR` (test only), and `NODE_ENV`/`NEXT_PHASE` (set by Next).
- **Step 8 (`d442799`):**
  - `docs/DEPLOYMENT.md` was rewritten as the single doc: Topology (public services plus the internal token), Environment variables, Render and Vercel gotchas (SMTP 2525), Cold starts and waking (scheduled work runs only while awake), Gates (with the web-before-API skew), and Environments;
  - "Database migrations", with the first rollout, 6c and 6d, is copied **verbatim** (diffed against the old root file);
  - Images, and Scaling. The root `DEPLOYMENT.md` is a pointer;
  - the README no longer claims a private network, GHCR or an always-on sweep. It gained a Lint row and a Deployment section;
  - five notes moved to `docs/history/`, with a README there;
  - the dead `./HANDOFF.md` and `./PRODUCT_ROADMAP.md` `.gitignore` lines are removed (a `./` pattern never matched);
  - one code comment link was updated;
  - the empty root `package-lock.json` is removed;
  - added the PR template and CODEOWNERS (`* @Kalkidan-Amare`);
  - the planner's ask: roadmap row 8 is set to done, and the 8 plan Status too.
  - Not written, as they aren't on main: the Jobs (9c), Logs (9d), Outbox (9b) and CSP (10) sections.
- **Step 9, local gate (head `d442799` + this note, after merging origin/main):**
  - the lint baseline was regenerated and is unchanged (api 204, web 4); the check passes;
  - api build, typecheck, test: 67 suites, 1281 passed, 1 skipped;
  - web typecheck, test: 76 files, 663 passed; web build OK;
  - `docker build`: gateway 2 m 19 s, 347 MB; web 3 m 15 s, 299 MB. Both cold after the lockfile change.
  - e2e and Playwright are left to CI on the draft PR: nothing in this branch changes runtime code (one comment), and the stack is held for Phase 10.
- **Step 9, CI on draft PR #32:**
  - **First run (`220e2c0`), all green:**
    - `secret-scan` 13 s, `api` 52 s, `web` 1 m 57 s, `e2e` 12 m 03 s, `lint` 40 s, `audit` 14 s;
    - the nine `docker-build (<image>)` jobs, 30 s to 1 m 16 s, in the separate "Docker build" workflow;
    - the job names match the ruleset's five contexts.
  - **Lint gate:** the scratch commit `69997d8` added one `any`, and `lint` **failed** (exit 1, printing the findings). It was reverted in `1398c81`, and `lint` passes again.
  - **Audit (bug found and fixed):**
    - the scratch commit also set `--audit-level low`, and `audit` still reported both audit steps as success with no warning, although the log listed many high advisories (axios, multer, nodemailer, brace-expansion…);
    - **cause:** `pnpm audit … | tee` under the default `bash -e` has no `pipefail`, so tee's exit 0 hid audit's exit code;
    - **fix `fe89fca`:** `shell: bash` (`-eo pipefail`) on both audit steps;
    - **on `1398c81`, at level high:** the `audit` check concludes **success**, with `warning: pnpm audit (api)` and `warning: pnpm audit (web)` annotations and the findings in the job summary;
    - this is P1-08's backlog for 11c.

### In flight / next step (checkpoint 2026-10-03, resume 2026-10-05)
- **State:**
  - steps 1–8 are done; step 9's local gate is green;
  - draft PR #32 is pushed at `8987efc`. CI on `8987efc`: api, web, lint, audit and secret-scan pass; `e2e` was still running at the checkpoint (it passed on `220e2c0`, and the later commits change only `ci.yml`'s audit steps and docs). Check it with `gh pr checks 32`.
- **2026-10-07, ethio-impl [5d9058]:** CI on `8987efc` is all green, `e2e` included (12 m 49 s). The Rollout commands went to ethio-planner [5b0124] for USER-ACTIONS, and code review round 1 was requested from ethio-plan-review [1a4214]. `origin/main` is still `f8e70bc`, the branch's merge base.
- **Next:**
  1. Answer the review findings inline in `code-review.md`, commit and send "Round N addressed".
  3. Before the merge: merge origin/main (keep 9a's `/ready` wait and 9c's `tini` if they've landed), regenerate the lint baseline (`node scripts/lint-check.mjs --update`), then mark the PR ready.
- **Rollout commands to send** (the owner's token has admin and `repo`; all were checked read-only, never run):
  1. After the merge, from an up-to-date `main` checkout: `gh api -X POST repos/avelia-ethio-learning-platform/ethio_learn/rulesets --input .github/rulesets/main.json`. Verify with `gh api repos/avelia-ethio-learning-platform/ethio_learn/rulesets --jq '.[] | "\(.name) \(.enforcement)"'`, which should print `main active`.
  2. `gh api -X PUT repos/avelia-ethio-learning-platform/ethio_learn/vulnerability-alerts` (Dependabot security updates need alerts on first), then `gh api -X PATCH repos/avelia-ethio-learning-platform/ethio_learn -f 'security_and_analysis[secret_scanning][status]=enabled' -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled' -f 'security_and_analysis[dependabot_security_updates][status]=enabled'`. Verify with `gh api repos/avelia-ethio-learning-platform/ethio_learn --jq .security_and_analysis`: each one should be `enabled`.
  3. **Render:** after the deploy, each of the 8 services' Settings → Auto-Deploy should read "After CI checks pass". If the Blueprint didn't sync it, set it there.
