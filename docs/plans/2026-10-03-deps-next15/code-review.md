# Phase 11c code review (ethio-plan-review)

## Round 1 (2026-10-07) · Verdict: APPROVED (no blockers; S1–S3 to fix or defer; merge only once step 9's e2e and Playwright are green)
I reviewed the **uncommitted** worktree `../ethi0-11c` (branch `chore/deps-next15`, base `origin/main` `40c40f2`): `git diff` (24 files) plus the untracked `api/AGENTS.md`. I checked it against the plan, its Amendments, Progress, deviations and `plan-review.md` (drift check D1–D2, N1).

**What I ran** (my detached snapshot `../ethi0-11c-review`: `40c40f2` plus the diff; both lockfiles byte-identical to the impl's; frozen installs, clean env):
- **api:**
  - build: 12/12, restored from turbo's cache, keyed on the same inputs;
  - typecheck clean;
  - `pnpm test`: 73 suites passed, 1 skipped, 1417 tests passed.
- **web:**
  - `typecheck` clean, also with **no `.next` directory**, as CI's fresh checkout runs it before the build. The new `/// <reference path="./.next/types/routes.d.ts" />` in `next-env.d.ts` doesn't break it;
  - vitest: 82 files, 691 tests pass;
  - `next build` exit 0.
- **lint-check:** web 4 against a baseline of 4; "No rule above its baseline". api is lower than its baseline (S3).
- **Audits:**
  - `pnpm -C web audit --prod --audit-level high`: 1 moderate (sprintf-js), so the gate is clean.
  - api: only axios is left at high, as Progress says (9c removes `chapa-nestjs`).
- **Not run by me:** the CI e2e scripts and Playwright, which are the impl's step 9, still pending. The PR's required CI runs both anyway.

### Blockers
None.

### Should-fix
- **S1. `api/AGENTS.md` is a turbo file, not this phase's.** Turbo 2.11.7 writes it before repo commands "when an AI agent is detected", and re-adds it if it's deleted. Left as is, it either rides into the commit unreviewed or shows up as untracked in every agent session's worktree. Pick one:
  - **(simplest)** add `"agentGuidance": false` to `api/turbo.json` and delete the file. The block itself names this opt-out;
  - or commit it on purpose.

  Either way, say which in Progress.
- **S2. "Security updates still come through" is no longer true.** The user turned Dependabot **security-update PRs off** on 2026-10-07: their failed jobs put red checks on `40c40f2`, and Render skipped the 9a+9b deploy (memory `render-checks-dependabot`). Dependabot *alerts* stay on.
  - `.github/dependabot.yml`'s header and `docs/DEPLOYMENT.md` "Dependencies" both promise security PRs. A reader would assume advisories get PRs on their own, when today they surface only as alerts and as CI's `audit` job summary.
  - **Fix the wording:** alerts and the CI audit summary report advisories; security-update PRs are off until the alerts can actually be fixed (re-enable them then).
- **S3. api lint dropped from 211 to 166 with no code change, and nobody has explained it.** lint-check names `@typescript-eslint/no-floating-promises` as the rule that fell. 11a measured it at 55 with the api build present.
  - A type-aware rule losing most of its hits after a dependency bump can mean the types stopped resolving (the rule then sees `any`, not `Promise`), and that silently weakens the gate.
  - Run `eslint` on api with that rule, before and after, and name the files whose hits disappeared. If the drop comes from real type changes (for example in jest 30.5's `expect` typings or typeorm 0.3.31), say so in Progress and run `node scripts/lint-check.mjs --update`, so the baseline ratchets down. If it's lost type information, fix that.

### Nits
None.

### Checked, no finding
- **Next 15 request APIs:**
  - the codemod covered every server page that reads `params` or `searchParams` (`courses`, `courses/[id]`, `educators/[id]`, `verify/[uid]`, including both `generateMetadata` functions);
  - the four client pages with dynamic segments read them through `useParams()`, which is unaffected;
  - nothing in `web/src` imports `next/headers`;
  - `opengraph-image`'s synchronous `params` is correct for 15 (it becomes a Promise in 16, as DEPLOYMENT.md's P2-44 notes);
  - the test passes `Promise.resolve(...)`.
- **Config:**
  - `outputFileTracingIncludes` is at the top level (N1);
  - `eslint.ignoreDuringBuilds` is fine (deviation): lint is its own required check, and the `lint` script is already `eslint .`;
  - `tsconfig` gains only `target`.
- **Caching:** decision 3's two proofs are in Progress, and the runtime table covers S2's waking `/educators/<id>` (`private, no-store`). The bounded `stale-while-revalidate` was accepted by the planner.
- **First Load JS:** +7.8% / +7.8% / +8.1%, under the 10% budget.
- **The braces ignore:**
  - `pnpm why braces --prod` shows a single path: gateway → `http-proxy-middleware` 3.0.7 → micromatch.
  - The gateway's `createProxyMiddleware` has `router` and no `pathFilter`. HPM's `matchPathFilter` then defaults to `'/'`, a string path matched with `indexOf`, and never reaches micromatch (`dist/path-filter.js`).
  - Using `ignoreCves` rather than `ignoreGhsas` for pnpm 9.4.0 is fine.
- **AWS SDK** 3.1081 → 3.1147: the old lock was already past 3.729's checksum change, and `storage/src/index.ts:99` sets `requestChecksumCalculation: 'WHEN_REQUIRED'`. So presigned PUTs don't change.
- **Overrides:**
  - every api override stays inside its major;
  - `next>postcss` is D1;
  - Dependabot's `'*'` major hold is D2.
- **nodemailer 10, class-validator 0.15, pdfkit 0.20, cookie 0.7:** the impl's drill covers each runtime path: SMTP to mailpit, a 400 with all four messages, a rendered certificate PDF. `email.provider.ts` compiles unchanged against nodemailer's own types.
- **No over-engineering:** no new scripts, config layers or abstractions. Only manifests, overrides, one ignore, the codemod and the docs.

### Before the merge
- Step 9: the CI e2e scripts and Playwright (chromium) green, recorded in Progress.
- After 9c merges: merge `origin/main`, regenerate the lockfile, confirm `pnpm -C api why axios` is empty, then rerun the api audit (Progress already plans this).
- **After the merge:** this PR changes `.github/dependabot.yml`, so Dependabot reruns its jobs against the merge commit. List every check run on the merge SHA, not just the required five, and confirm the Render Events show it deployed (memory `render-checks-dependabot`). If they don't, the user does a manual "Deploy latest commit".
- **Commits:** per today's cap, this file stays uncommitted. Please include it in 11c's commit.

### Implementer answers (rebuild 2026-10-18/19)
- **S1 fixed:** `"agentGuidance": false` in `api/turbo.json`; no `api/AGENTS.md` after a full build.
- **S2 fixed:** wording in `.github/dependabot.yml` and `docs/DEPLOYMENT.md` "Dependencies".
- **S3 explained:** the drop is on unchanged main (no-floating-promises 55 → 10, the rest are `main.ts` bootstraps), cross-package types resolve (probe reported), baseline updated. See plan.md "Rebuild 2026-10-18".
