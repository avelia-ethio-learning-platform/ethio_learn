# Phase 11a code review (ethio-plan-review)

## Round 1 (2026-10-07) · Verdict: APPROVED (no blockers; S1 to fix or defer, N1–N2 optional)
I reviewed `git diff f8e70bc...d899230`: 38 files, all of them against the plan, its Progress and Deviations, `plan-review.md` and `handoff.md`. `8987efc..d899230` changes only `plan.md` (verified). Nothing unplanned: every new file traces to a plan item. The `docker-build` job living in its own `docker.yml` is the logged deviation, and it's needed because path filters work per workflow.

**What I ran** (detached review worktree at `d899230`, frozen installs; since removed):
- `node scripts/lint-check.mjs` on a fresh checkout (no api `dist`): api 204 and web 4, matching the baseline, so it passes. That's the state CI's `lint` job runs in.
- `pnpm -C api build --force` (12 tasks OK), then `node scripts/lint-check.mjs` again: api 211, so it **fails**, with `no-floating-promises` 48 → 55 (S1).
- `pnpm -C web build`: OK. Next now prints "Linting and checking validity of types" but no lint output and no new warnings; Vercel's preview check passes.
- **CI:** 8987efc green per the impl (e2e 12 m 49 s). Run `37595636316` on `d899230` (08:43Z): api, web, lint, audit, secret-scan and the nine `docker-build` jobs pass; e2e was still running when I wrote this. I didn't rerun api jest or Playwright: the only api change is a comment (`notification/src/controllers.ts:54`).
- **Sampled doc claims against `render.yaml` and the code:**
  - `DB_POOL_MAX`/`DB_POOL_MIN`, `COOKIE_SAMESITE`, SMTP 2525, and the `generateValue` secrets;
  - the `.env.example` defaults: `REQUIRE_INTERNAL_TOKEN` (`common/src/bootstrap.ts:40`), `DB_POOL_*` and `DB_SLOW_QUERY_MS` (`typeorm.ts:58-63`), `PROXY_*` (`gateway/src/main.ts:23,139`), `INTERNAL_HTTP_TIMEOUT_MS`, `MAX_VIDEO_UPLOAD_BYTES` and `SERVICE_NAME`.

  All match. No stale link to the five moved notes, and no Node 20, GHCR or private-network claim is left in the README or `docs/DEPLOYMENT.md`.
- **Checked by reading:**
  - the ruleset JSON: five contexts, each with `integration_id: 15368`; strict mode; `RepositoryRole` 5 with `bypass_mode: pull_request`;
  - top-level `permissions: contents: read` in both workflows, and no `pull_request_target`;
  - concurrency and timeouts as planned;
  - both wait loops in `e2e` now fail their step (`ci.yml:111-112,117-119`);
  - audit `pipefail` (`fe89fca`) with step-level `continue-on-error`;
  - the api runtime image copies only `package.json`, `node_modules` and `dist`. No service reads a file outside `dist` at runtime (grep for `readFile`, `__dirname` and `process.cwd()`: only `load-env.ts`, which tolerates no `.env`).

### Blockers
None.

### Should-fix
- **S1. CI's `lint` can't see promises from the workspace packages, and the baseline count depends on whether api was built.**
  - **Cause:** the four `api/packages/*` declare `"types": "dist/index.d.ts"`, and the `lint` job (`ci.yml`, `lint`) installs but never builds. So in CI, type-aware `no-floating-promises` sees every import from `@ethiopialearn/common`, `storage`, `ai` and `contracts` as an unresolved type, and never flags it.
  - **Proof:** with `dist` present, the count is 55, not 48. The seven extras are the unawaited `bootstrapService(...)` calls in `services/*/src/main.ts:5` (financial `:10`).
  - **Scenario 1:** the gate misses the case decision 4 added the rule for. `EventBusService` is in `@ethiopialearn/common` (`packages/common/src/events/event-bus.service.ts:43`). So a new unawaited `this.bus.publish(...)` in a service, the 9a-style bug, passes CI's lint.
  - **Scenario 2:** your pre-merge step "regenerate the lint baseline (`--update`)", run in a worktree where api was built (as for the step 9 gate), writes 55. CI then counts 48, so seven new floating promises of any kind get through. The other way round, anyone who runs `node scripts/lint-check.mjs` locally after a build gets a red result for findings that aren't new.
  - **Fix:**
    - add `- run: pnpm -C api build` to the `lint` job, before `node scripts/lint-check.mjs` (turbo; about 30 s here);
    - regenerate the baseline with api built (`no-floating-promises: 55`);
    - add one line to the `lint-check.mjs` header: "needs api built (pnpm -C api build), so package types resolve".

    Fixing the seven `main.ts` lines with `void` is optional; the baseline covers them.

### Nits (optional)
- **N1.** The `docker` ecosystem entries in `.github/dependabot.yml:45-48` have no `ignore`. Dependabot bumps the `22-alpine` tag to newer majors (24, 25…), not just the digest. That's a runtime-major PR with no plan behind it. Add `ignore: [{ dependency-name: node, update-types: [version-update:semver-major] }]`, as the npm entries do for Next and React.
- **N2.** `scripts/lint-check.mjs:12`: `new URL('..', import.meta.url).pathname` stays percent-encoded, so a checkout path with a space or non-ASCII character breaks every `join`. `fileURLToPath(new URL('..', import.meta.url))` is the fix.

### Note for ethio-planner (cross-phase, not an 11a finding)
- **The problem:** with `autoDeployTrigger: checksPass`, Render waits for every check on the commit (`docs/DEPLOYMENT.md:110`).
  - 9c's `jobs.yml` (`../ethi0-9c/.github/workflows/jobs.yml:17-22`, a cron every 4 h plus two daily runs) runs against the head of `main`, so its check runs attach to that commit.
  - If a scheduled run fails (say a wake times out) while a fresh merge commit is still waiting on CI, Render skips that commit's deploy. The new web, already live on Vercel, then runs against the old API until the next merge.
- **What to do:** whichever of 11a and 9c merges second should either make `jobs.yml` report a job failure without failing the check (as `audit` does), or say this in "Gates". I'd pick the first.

### Round 1 response (impl, ethio-impl [5d9058], 2026-10-07)
- **S1: fixed.** The `lint` job runs `pnpm -C api build` before `node scripts/lint-check.mjs`. The baseline was regenerated with api built (`no-floating-promises` 48 → 55; the seven `bootstrapService(...)` lines stay in the baseline). The `lint-check.mjs` header, the README test table and DEPLOYMENT's Lint section now say api must be built first. Local: `pnpm -C api build --force` (12 tasks), then `node scripts/lint-check.mjs`: "No rule above its baseline".
- **N1: taken.** The docker entries ignore `node` semver-major bumps.
- **N2: taken.** `ROOT = fileURLToPath(new URL('..', import.meta.url))`.
- **Note for ethio-planner:** relayed as Amendment #3 in 9c's handoff (the planner's message, 2026-10-07).

