# Code review: Phase 1, CI green and repo baseline

## Round 1 (2026-10-02) · Verdict: APPROVED
Reviewed: branch `fix/ci-green` (5 commits, 247cb1f), base `origin/main`, against the approved plan (round 2) and its three logged deviations.
Checks run (read-only; working tree and the running stack untouched):
- `docker compose config -q` → OK.
- `rhysd/actionlint` 1.7.12 on `.github/workflows/ci.yml` → clean (exit 0).
- gitleaks v8.30.1 with the branch's `.gitleaks.toml` over the full history → 51 commits scanned, no leaks.
- `minio-init` in an isolated compose project (`-p planreview-minio`, host ports reset, torn down with `down -v` afterwards) → `docker compose run --rm minio-init` exits 0, and a second run is a no-op. Anonymous `thumbnails/t.txt` → 200, `videos/v.txt` → 403, anonymous bucket listing → 403. Listing is stricter than the old `mc anonymous set download` policy, which allowed listing the prefix.
- `jest packages/ai/src/index.spec.ts` (Node 22.23.1) → 46/46 pass.
- `git check-ignore` → `.claude/settings.local.json`, `audit.md` and `docs/plans/*/screenshots/` are ignored. `audit.md` and the screenshots appear in no commit, and the committed `docs/plans` hold no reproduction details. The settings file is still on disk.
- No leftover Node 20 references on the branch (outside lockfiles). No Claude attribution in the commit messages.

Against the plan: every step matches. The three deviations are sound and stay in scope:
- The init wait loop is bounded at 60 s, then fails with the real error.
- `checkout@v7` is also used in the two main-only docker jobs.
- The shellcheck fix for the unused loop variable.

The plan-review findings (S1 chown note in README and compose, S2 blocking init with `set -e`, S3 restore note, N1 750 ms, N2 the "N commits scanned" comment in ci.yml) are all present in the code.

### Blockers
None.

### Should-fix
None.

### Nits (optional)
- **N1.** `.gitignore:16`: the original file had no trailing newline, so the new comment got glued onto the previous pattern (`./PRODUCT_ROADMAP.md# personal Claude Code permissions …`). It's harmless: that `./` pattern never matched anyway (P2-16), and the rules below it work. But the comment is lost inside a pattern. Add a newline before `# personal …`.
