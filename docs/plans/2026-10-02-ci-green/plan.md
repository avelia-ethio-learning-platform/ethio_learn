# Phase 1: CI green and repo baseline

Status: code review approved (round 1), waiting for the user to approve push and PR
Size: S (sessions: 2 — ethio-planner implements, ethio-plan-review reviews plan and code)
Base branch: `origin/main` · Feature branch: `fix/ci-green`
Roadmap: [../2026-10-02-refinement-audit/roadmap.md](../2026-10-02-refinement-audit/roadmap.md) · Audit: `../2026-10-02-refinement-audit/audit.md` (local only until phases 3–4 ship)

## Goal
GitHub CI has been red on every run since 2026-09-13, so the last four PRs merged without e2e protection. Make CI green and trustworthy before any other phase, so every later PR is really gated. Also move Node 20 (EOL since 2026-04-30) to Node 22, which local dev already uses.

Acceptance criteria:
- `docker compose up -d postgres redis rabbitmq minio minio-init` works on a clean machine again: the bucket exists, `thumbnails/*` is anonymously readable and everything else is private (P0-07).
- The `secret-scan` job actually scans the full git history with the free gitleaks CLI and passes (P0-08).
- `.gitleaks.toml` no longer allowlists the production env-file pattern or whole test-file globs, and history still scans clean (P1-27).
- CI, both Dockerfiles, README and `engines` all say Node 22; runner pinned to `ubuntu-24.04` (P1-25).
- The wall-clock assertions in `api/packages/ai/src/index.spec.ts` no longer flake on a loaded runner while still catching a catastrophic-backtracking regression (P1-31).
- On the PR, every CI job that runs for pull requests (`secret-scan`, `api`, `web`, `e2e`) is green.

## Non-goals
- Docker publish jobs (`docker-api`, `docker-web`) and whether GHCR images are needed at all (P2-19, phase 9). They only run on `main`, so their actions stay at their current versions here.
- Branch protection, Dependabot, GitHub secret scanning (P1-24, P1-26; phase 9).
- Playwright/browser E2E (phase 4), ESLint (P2-17), Dockerfile layer-caching polish (P2-18), root clutter and the broken `./HANDOFF.md` ignore lines (P2-16).
- Replacing MinIO with a different object store. The Chainguard build is the same MinIO server, maintained.
- Any application code change.

## Current state
- `docker-compose.yml:64` `minio/minio:latest` and `:78` `minio/mc:latest`: both repositories were removed from Docker Hub ("pull access denied … repository does not exist"). CI `e2e` fails at "Start infrastructure" (`.github/workflows/ci.yml:77-80`); the log-dump step then also fails because `.devlogs/` doesn't exist (`ci.yml:98`).
- `ci.yml:12-20` uses `gitleaks/gitleaks-action@v2`, which requires a paid `GITLEAKS_LICENSE` for organization repos; the repo has 0 Actions secrets, so the job has never scanned.
- `.gitleaks.toml:12-14` allowlists `\.env\..*\.local$` (the gitignored file that holds production secrets) and every `*.spec.ts` / `*.test.ts`.
- Node 20: `api/Dockerfile:3,5,17`, `web/Dockerfile:2,4,25`, `ci.yml` (`node-version: 20` ×3), `README.md:50,106`, `DEPLOYMENT.md:15`, `api/package.json` `engines >=20`; no `.nvmrc`. Local dev uses Node 22. Render builds the API from `api/Dockerfile` (`render.yaml` `runtime: docker`); Vercel builds web with its project Node setting.
- `api/packages/ai/src/index.spec.ts:147` asserts `< 50 ms` for 12 ReDoS cases and `:159` `< 250 ms`; one case measured 57 ms under `--coverage` on a loaded machine. The old quadratic code took 1.5–3 s.
- `.claude/settings.local.json` (a personal Claude Code permissions file) is tracked in this public repo. It holds no secrets.
- Audit screenshots (~60 MB) live in `docs/plans/2026-10-02-refinement-audit/screenshots/` and must not be committed.
- The repo is **public** and production is live. `audit.md` contains reproduction details for unfixed vulnerabilities (fixed in phases 3–4), so it must not be pushed yet.

## Design and key decisions
1. **MinIO server image → `cgr.dev/chainguard/minio` pinned by digest** (`sha256:0f95aa41…e915b`). Same MinIO server, same `server /data --console-address :9001` command and env vars, maintained by Chainguard. Pinned by digest because Chainguard's free tier only publishes `:latest`, and CI should be reproducible. Rejected: `bitnamilegacy/minio` (frozen, unmaintained); switching to SeaweedFS/LocalStack (new tech for no gain).
2. **Bucket init → `amazon/aws-cli:2.37.8` with a `/bin/sh` entrypoint** instead of `mc`. Chainguard's `minio-client` image has no shell, and the init needs a wait loop. The script: wait until `s3api list-buckets` succeeds, then `set -e`, `head-bucket || create-bucket`, then `put-bucket-policy` granting anonymous `s3:GetObject` on `ethiopialearn/thumbnails/*` only. No trailing `|| true; exit 0`: a broken init must fail. In CI the init runs as `docker compose run --rm minio-init`, which blocks and returns the script's exit code (`up -d` ignores it). Already tried against the pinned server in an isolated network: thumbnail object → 200, video object → 403, identical to today's `mc anonymous set download …/thumbnails`. Rejected: a Node init script (needs node_modules inside a one-shot container).
3. **Secret scan → gitleaks CLI in Docker, pinned `ghcr.io/gitleaks/gitleaks:v8.30.1`**, `git /repo --config /repo/.gitleaks.toml --redact --no-banner`, with `fetch-depth: 0`. Free, no license, same rule set. Already ran locally with the tightened config over all history: no leaks.
4. **Allowlist tightening:** delete the `.env.*.local` path and the `*.spec.ts` / `*.test.ts` globs. The specific placeholder `regexes` stay; nothing else needed adding because history still scans clean.
5. **Node 22 everywhere:** `node:22-alpine` in both Dockerfiles, `node-version: 22` in CI, `.nvmrc` with `22`, `engines.node` `>=22` in `api/package.json` and `22.x` in `web/package.json` (Vercel reads `engines` to pick the build Node version). Docs updated. Node 22 is the active LTS; 24 is possible but nothing needs it, and local dev is already on 22.
6. **CI actions:** bump only the actions that run in PR jobs, so the PR itself proves them: `actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6`. Their major-release notes list no breaking change for our usage (setup-node v5+ auto-caching is already explicit via `cache: pnpm`). `runs-on: ubuntu-24.04` on every job, ahead of the `ubuntu-latest` → Ubuntu 26 move on 2026-10-19.
7. **e2e diagnostics:** the failure step dumps `docker compose logs --tail 50` and `tail -n 80 .devlogs/*.log`, each `|| true`, so a red run shows the real cause instead of a second error.
8. **Flaky test:** raise the per-case budget from 50 ms to 500 ms and the linear cases from 250 ms to 750 ms. Both stay at least 2× under the fastest known regression (1.5–3 s), so a reintroduced catastrophic regex still fails. Rejected: comparing against a baseline run (more code, and the same noise). Also look once for the open handle jest reported (`--detectOpenHandles`); fix it only if it's in this spec, otherwise note it.
9. **Repo hygiene that blocks nothing but belongs to "baseline":** `git rm --cached .claude/settings.local.json` and ignore it; ignore `docs/plans/*/screenshots/`. Commit `roadmap.md` only (finding IDs, no exploit detail). `audit.md` stays local and git-ignored (`docs/plans/2026-10-02-refinement-audit/audit.md`) until phases 3 and 4 are deployed; it is committed then. Each security phase describes its vulnerabilities in the PR that fixes them. Review files committed with this phase must not contain reproduction steps either (plan-review B1).

## Steps
- [x] 1. Branch `fix/ci-green` from `origin/main`.
- [x] 2. `docker-compose.yml`: pinned Chainguard MinIO; `minio-init` on `amazon/aws-cli:2.37.8` with the sh script above (env `AWS_ACCESS_KEY_ID/SECRET` = the existing local `minioadmin` dev values, region `us-east-1`); keep the comments accurate. · Verify: `docker compose config -q`; recreate `minio` and run `minio-init` against the local stack; check logs, then a public thumbnail returns 200 and a video key returns 403.
- [x] 3. `.github/workflows/ci.yml`: gitleaks CLI step; action bumps; `ubuntu-24.04`; Node 22; failure-log step with `|| true` and `docker compose logs`. · Verify: `actionlint` (Docker image `rhysd/actionlint`) is clean.
- [x] 4. `.gitleaks.toml`: remove the three path entries; update the header comment. · Verify: gitleaks v8.30.1 over full history → no leaks; in a throwaway clone, a committed fake token in a `*.spec.ts` file is flagged (proves the glob is gone).
- [x] 5. Node 22: Dockerfiles, `.nvmrc`, `engines`, README (plus the MinIO volume `chown` note in the quick start), DEPLOYMENT.md. · Verify: `docker build` gateway and web images; `docker run --rm <img> node --version` → v22; remove the test images.
- [x] 6. `api/packages/ai/src/index.spec.ts` budgets; one `--detectOpenHandles` look. · Verify: `pnpm -C api test` passes, then `pnpm -C api exec jest --coverage` (the run that flaked) passes.
- [x] 7. Hygiene: back up `.claude/settings.local.json` to the scratchpad, untrack it, `.gitignore` entries (screenshots, `audit.md`, the settings file); add `roadmap.md` and this phase's plan folder. · Verify: `git status --ignored` shows `audit.md` and the screenshots as ignored; `git ls-files .claude` is empty; a keyword grep over the docs being committed finds no reproduction steps.
- [x] 8. Full local gate: api build + tests, web typecheck + tests + build, the three e2e scripts against the running stack.
- [ ] 9. Code review by ethio-plan-review; then ask the user to push and open the PR; confirm every PR job is green on GitHub, and that the `secret-scan` log reports `N commits scanned` with N ≥ 46 (a scan of 0 commits also passes), before calling it done.

## Test plan
- Infra: step 2 checks (bucket created, public/private policy) against the real pinned images.
- Secret scan: positive (history clean) and negative (planted fake token in a spec is caught) runs of the pinned CLI with the new config.
- CI syntax: `actionlint`.
- Regression: `pnpm -C api build && pnpm -C api test`; `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`; `node scripts/demo-seed.mjs`, `node scripts/e2e-revisions.mjs`, `node scripts/e2e-smoke.mjs`.
- Images: both Docker images build on `node:22-alpine` and report v22.
- The real proof is the PR's CI run; the phase is not done until it is green.

## Rollout and ops
- No runtime config or env var changes. Render will build the API images on `node:22-alpine` at the next deploy after merge; Vercel will build web on Node 22 because of `engines`. If Vercel's project setting pins a different Node major, the build log will show the override warning; the user may need to set Node 22 in the Vercel project settings (outward-facing, confirm with the user).
- Local developers: `docker compose pull minio minio-init` once (the README already lists the same `up` command). The Chainguard server runs as uid 65532; a volume created by the old root `minio/minio` image makes it exit with *file access denied*. README and rollout note: fix the old volume once with `docker run --rm -v ethiopialearn_miniodata:/data alpine chown -R 65532:65532 /data` (keeps local files), or remove the volume.
- `.claude/settings.local.json`: git deletes it from disk when a checkout moves from a commit that tracks it to one that doesn't (e.g. `git pull` after the merge). PR description and this note: restore with `git show 5f2d044:.claude/settings.local.json > .claude/settings.local.json`.

## Risks and open questions
- Chainguard may garbage-collect old digests. Mitigation: if the pull ever fails, re-pin to the current `:latest` digest (one-line change, comment in the compose file says so).
- Node 22 inside the images could expose a dependency incompatibility. Mitigation: local dev already runs every service on Node 22, and step 5 builds both images.

## Progress and deviations (implementer)
- 2026-10-02 steps 1–8 done (ethio-planner).
  - Step 2: init verified against the recreated local MinIO: `docker compose run --rm minio-init` exits 0, a `thumbnails/` object returns 200 anonymously, a `videos/` object 403; a second run is a no-op. Deviation: the wait loop is bounded to 60 s and then fails with the real error, instead of an unbounded `until`, so a dead MinIO can't hang a CI job for hours.
  - Step 3: `actionlint` clean. Deviations: `actions/checkout@v7` is also used in the two docker publish jobs (same action the PR jobs prove; the docker/* actions are unchanged). Fixed one pre-existing shellcheck warning (unused loop variable in the health wait) so actionlint is clean.
  - Step 4: gitleaks v8.30.1 with the new config: 46 commits scanned, no leaks. Negative test in a throwaway clone: a fake `ghp_…` token in `api/leak-check.spec.ts` and in a force-added `.env.production.local` are both reported (2 leaks).
  - Step 5: both images build on `node:22-alpine` and report v22.23.3. Gateway image 303 → 347 MB and web 249 → 293 MB (larger Node 22 base). `pnpm install --frozen-lockfile` still passes with the new `engines`.
  - Step 6: `--detectOpenHandles` on the ai spec shows no open handle, so the jest "worker failed to exit" warning comes from another suite; left for phase 9 (test work). `pnpm -C api test`: 33 suites / 649 tests pass; the `--coverage` run also passes.
  - Step 8: api build OK; web typecheck OK, 255 tests pass, build OK; demo-seed, e2e-revisions and e2e-smoke all pass against the local stack.

