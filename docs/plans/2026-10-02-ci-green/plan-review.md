# Plan review: Phase 1, CI green and repo baseline

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)"), against `origin/main` (tree identical to `deploy/render-vercel` HEAD 5f2d044) and audit findings P0-07, P0-08, P1-25, P1-27, P1-31.

Checked and OK (no action needed):
- All pinned versions exist: `actions/checkout` v7.0.1, `actions/setup-node` v7.0.0, `pnpm/action-setup` v6.1.0, gitleaks v8.30.1, `amazon/aws-cli` 2.37.8. The Chainguard digest `sha256:0f95aa41…e915b` is the image the local stack runs now.
- The major-release notes for checkout v5–v7, setup-node v5–v7 and action-setup v5–v6 contain nothing that breaks our usage. There is no root `package.json`, so action-setup's `packageManager` conflict check can't trigger.
- The gitleaks v8.30.1 image runs as root with `safe.directory=*`, so a runner-owned checkout won't hit git's "dubious ownership" error.
- I ran the tightened config (the three path entries removed) over the full history with the pinned image: 46 commits scanned, no leaks. That confirms decision 4.
- The API has no native dependencies (`bcryptjs` is pure JS; `better-sqlite3` is only an optional TypeORM peer), so moving to `node:22-alpine` is low risk.
- The app never creates the bucket itself (no CreateBucket/PutBucketPolicy calls in `api/`), so `minio-init` is the only thing that does.

### Blockers
- **B1. Committing `audit.md` publishes unfixed, live-confirmed exploits** at Design decision 9 / Step 7
  Scenario: the repo is **public**, and production is live. As soon as `fix/ci-green` is pushed (even before it merges), anyone can read `audit.md`. It contains reproduction steps, with endpoints, payloads and file:line references, for several unfixed P0 security findings. The fixes land in phases 3–4, weeks later, and a later `git rm` won't remove the text from history. *(Reworded generically in round 2 at the planner's request, because this file is committed with the phase.)*
  Suggested fix: commit only `roadmap.md`, which has finding IDs and no exploit detail. Keep `audit.md` local and git-ignored, next to the screenshots rule (e.g. `docs/plans/*/audit.md`), until phases 3 and 4 are deployed, and commit it then. Each phase plan describes its vulnerabilities in the PR that fixes them, which is normal practice.
  Response: fixed. Agreed, good catch. Decision 9 and step 7 now commit `roadmap.md` only; `audit.md` is git-ignored until phases 3 and 4 are deployed, and roadmap.md no longer links it. Step 7 adds a `git grep` check that no reproduction steps are committed. One follow-on: this review file is committed with the phase, and the B1 scenario above spells out the P0-03 request sequence. Please reword it generically (e.g. "reproduction steps for unfixed P0 security findings") in round 2.

### Should-fix
- **S1. Existing MinIO volumes stop working with the non-root Chainguard image** at Rollout and ops: the rollout note only says `docker compose pull`. The Chainguard server runs as uid 65532. The old `minio/minio` ran as root, so its `.minio.sys` is root-owned. I reproduced this in a throwaway volume: the pinned image exits 1 with `unable to rename (/data/.minio.sys/tmp …) file access denied`. Anyone who ran the README quick start before (any existing clone) is stuck at step 1. Fresh machines and CI are unaffected, and your local volume was created by Chainguard today, so it's fine. Suggested: add one line to the Rollout notes and the README quick start: "If `minio` exits with *file access denied*, fix the old volume once with `docker run --rm -v ethiopialearn_miniodata:/data alpine chown -R 65532:65532 /data`." This keeps local files. Removing the volume also works.
  Response: fixed. Added the chown one-liner to Rollout and ops; the README quick start gets the same line in step 5.
- **S2. Make `minio-init` blocking and fail-visible in CI** at Design decision 2 / `ci.yml` "Start infrastructure": `docker compose up -d minio-init` ignores the container's exit code. No e2e script touches the public-thumbnail policy (thumbnails use placehold.co/example.com URLs). So if the new aws-cli script breaks (bad policy JSON, wrong endpoint flag), CI stays green or fails later as a confusing NoSuchBucket in the upload step. The one-off manual check in step 2 is then the only guard for the P0-07 acceptance criterion. Suggested: `set -e` after the wait loop (the old `|| true; exit 0` pattern shouldn't carry over), and in CI `docker compose run --rm minio-init`, which blocks and returns the exit code.
  Response: fixed. Decision 2: `set -e` after the wait loop, no `|| true; exit 0`, and CI runs `docker compose run --rm minio-init`.
- **S3. Untracking `.claude/settings.local.json` will delete it from the shared working tree later** at Design decision 9 / Step 7. Once a commit stops tracking a file, git removes it from disk when you move from a commit that tracks it to one that doesn't. After the merge, `git checkout main && git pull` deletes the file, and switching between `fix/ci-green` and `deploy/render-vercel`/`main` before then does the same. All sessions in this repo then lose the project permission allowlist. It's recoverable from history, so this isn't a blocker. Suggested: add a Rollout line ("after pulling the merge, restore with `git show 5f2d044:.claude/settings.local.json > .claude/settings.local.json`"), or back the file up to the scratchpad before switching branches.
  Response: fixed. Step 7 backs the file up to the scratchpad before any branch switch, and Rollout and ops plus the PR description carry the `git show 5f2d044:… >` restore command.

### Nits (optional)
- **N1.** (Taken: linear cases now 750 ms; wording fixed.) Decision 8 says the new budgets are "3× faster than the slowest known regression". That holds for the 500 ms per-case budget. For the linear cases it's 1000 ms against the 1.5–3 s the old code took, about a 1.5× margin. That still catches the regression, especially on slower runners, so just fix the wording (or use 750 ms).
- **N2.** (Taken: step 9 checks `N commits scanned` ≥ 46.) For acceptance criterion 2, check in step 9 that the `secret-scan` log shows `N commits scanned` with N ≥ 46, not only that the job is green. A scan that covers 0 commits also passes, and that is the P0-08 failure this phase fixes.

FYI (not a finding): the running local MinIO volume (`ethiopialearn_miniodata`) holds only `.minio.sys` and no `ethiopialearn/` bucket directory. Uploads on the running stack probably fail until step 2 re-runs the init. Keep that in mind when you read the step 8 e2e results.

## Round 2 (2026-10-02) · Verdict: APPROVED
Reviewed: `plan.md` (status "in review (round 2)"), the round-1 responses above, and `roadmap.md`.

Round-1 findings, all resolved:
- **B1** resolved. Decision 9 and step 7 commit only `roadmap.md`. `audit.md` is git-ignored until phases 3–4 are deployed. `roadmap.md` no longer links it and holds only finding IDs, and the "Current state" note in `plan.md` is generic. I reworded this file's B1 scenario as requested, so step 7's `git grep` check comes back clean on it.
- **S1** resolved. The chown one-liner is in Rollout and ops and goes into the README in step 5.
- **S2** resolved. `set -e` after the wait loop, no trailing `|| true; exit 0`, and CI uses `docker compose run --rm minio-init`.
- **S3** resolved. The file is backed up before untracking, and the restore command is in Rollout and ops and the PR description.
- **N1, N2** taken. The 750 ms linear budget stays 2× under the 1.5 s low end, and step 9 checks `N commits scanned`.

No new blockers in the changed sections. Ready to implement; the code review comes back to ethio-plan-review.
