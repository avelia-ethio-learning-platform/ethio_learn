# Handoff: Phase 11c, dependencies and Next 15

From ethio-planner to ethio-impl2 [280868] (re-handed 2026-10-07; the plan's "Amendments 2026-10-07" override this file where they differ)
Plan: [plan.md](plan.md) (approved in round 1, with S1–S3 and N1–N3 folded in; see [plan-review.md](plan-review.md))
Code review goes to: ethio-plan-review (size M)

## What to build
- **Web:** Next 14.2 → the latest 15.5.x (15.5.27 on 2026-10-03), React 18 → 19, with the React types and `eslint-config-next` to match.
  - Every `params`, `searchParams`, `cookies()` and `headers()` read is awaited.
  - Caching stays exactly as it was, proved by the build route table and by runtime headers.
- **API:**
  - nodemailer to its latest major, with `@types/nodemailer` removed;
  - each `@nestjs/*` package to its latest release within its current major;
  - `pnpm.overrides` for patched transitive versions;
  - audit ignores only for unreachable advisories, each with its reason.
- **Audits:** `pnpm audit --prod --audit-level high` is clean for both workspaces.
- **Dependabot:**
  - hold `next` and `eslint-config-next` ≥ 16;
  - keep the React and `@types/react*` major holds and the `@nestjs/*` hold.
- **Docs:** `docs/DEPLOYMENT.md` "Dependencies", including P2-44, P2-45 and the moderate `@nestjs/core` advisory.

## Read first, in order
1. `plan.md` decisions 1–6, then `plan-review.md` round 1:
   - S1: the lint baseline;
   - S2: the runtime caching headers;
   - S3: nodemailer's own types;
   - N1: the pinned codemod target.
2. `web/package.json`, `api/package.json` and each service's `package.json` that lists `@nestjs/*` or nodemailer.
3. Web caching:
   - `web/src/lib/server-api.ts` (Phase 5's `next: { revalidate }`, the 8 s timeout);
   - every file with `export const revalidate`/`dynamic`;
   - 7b's `opengraph-image` files;
   - 11b's route handlers.
4. `api/services/notification/src/**/email.provider.ts` and its spec.
5. 11a's files:
   - `.github/dependabot.yml` (the `next-react` group and the holds);
   - `.github/lint-baseline.json` and its script;
   - `web/eslint.config.mjs` and the `lint` scripts.

## Decisions already made (don't relitigate)
- **Next 15.5, not 16** (P2-44), and **Nest within 10.x, not 11/12** (P2-45). A reachable advisory with no fix inside the current major comes back to the planner before any major bump.
- **Overrides** stay within the current major, with versions taken from the audit output. No `--force` across majors.
- **Codemods:**
  - first `npx @next/codemod@15 upgrade <latest 15.5.x>`, never bare `upgrade` or `major`;
  - then `npx types-react-codemod@latest preset-19`;
  - one commit each, then hand fixes in their own commits.
- **Caching:**
  - explicit `next: { revalidate }` or `cache: 'no-store'` on every SSR fetch;
  - segment exports are kept;
  - the client router cache keeps 15's default.
- **The proof:** before and after, the route table and two requests to each caching-sensitive route, recording `Cache-Control` and `x-nextjs-cache`. The routes are `/`, `/courses`, `/courses/<id>`, `/educators`, `/educators/<id>`, `/verify/<uid>`, `/sitemap.xml` and one OG image. Both tables must match.
- **Lint:** before and after the bump. Fix the new hits, or regenerate the baseline in this PR, listing the new warnings by rule. If `next lint` is used, switch it to `eslint .`.
- **First Load JS** of `/`, `/courses` and `/courses/[slug]` stays within 10% of the before numbers.

## Gotchas learned while planning
- **Pin the codemod's target.** The `upgrade` command resolves its target from npm, where `latest` is 16.x. A stray 16 removes `next lint` and renames middleware, which shows up as unrelated breakage.
- **Async request APIs:** Next 15 keeps a synchronous fallback with warnings. The build must end with no such warning; grep the build log for them.
- **11b's route handlers** read the path from `req.nextUrl.pathname`, not `params`, so they shouldn't need the codemod. Re-run 11b's vitests and auth specs anyway.
- **Runtime header check:** run it against `next start` with the local stack up, and again with the gateway stopped. `/educators/<id>` must stay `private, no-store` in both cases, so a waking render is never cached.
- **The SMTP drill:**
  - use a throwaway local catcher (mailpit in Docker) and the `.env.example` values only;
  - never put real SMTP credentials in the shell;
  - the secret-guard hook scans untracked files for `api/.env` values.
- **Audit:** pnpm 9.15.9 answers the audit endpoint (checked in review). Save the `--json` summaries by severity and package in Progress, not the raw output.
- **Playwright** (memory `playwright-clean-env`): never export `api/.env.example` into the Playwright shell. Run chromium and webkit (11b added webkit).
- **The plan folder isn't security-sensitive.** Commit it on your branch, staging paths explicitly (several plan folders are untracked).
- **Environment:**
  - the node PATH export (`/home/kal/.local/opt/node22/bin`);
  - pnpm's `--store-dir /home/kal/snap/code/current/.local/share/pnpm/store/v3`, needed for every install in this phase;
  - Postgres on 55432;
  - restart web by killing the `next-server` PID.
- **Production is off-limits.** The post-deploy email check is the user's.

## How to run
- **API:** `pnpm -C api build && pnpm -C api test:coverage && pnpm -C api typecheck && pnpm -C api db:check && pnpm -C api lint`, then `pnpm -C api audit --prod --audit-level high`.
- **Web:** `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build && pnpm -C web lint`, then `pnpm -C web audit --prod --audit-level high`.
- **Baseline:** the lint baseline comparison script.
- **E2E:** the CI e2e scripts, and the full Playwright suite in chromium and webkit. Phase 5's cold-start specs and 11b's auth specs matter most.

## Branch
Create `chore/deps-next15` from the tip of the stack when it starts (expected `fix/auth-transport`, 11b).
- Don't push and don't open a PR until everything below has merged into main. Then run `git merge origin/main` (no rebase).

## Rollout notes for the PR description (the user does these)
1. **Vercel** builds with Next 15 on the merge; there's no env change. Watch the build log for warnings.
2. **Render** rebuilds every service. After deploy, check that one real email (a sign-up or a password reset) still arrives.
3. **Watch** 9d's access log for any new 5xx on `/api/v1/auth/*`.

## Definition of done
- The acceptance criteria are met.
- The before and after snapshots are in Progress: audits, the route table, the runtime headers, First Load JS and the lint count.
- Every check in "How to run" passes.
- The checklist is ticked, with deviations logged.
- Then request code review from ethio-plan-review.

## Parallel-work rules (2026-10-07, ethio-planner)
Three implementers now run at once, so these keep them out of each other's way:
- **Your files only.** Work only in `../ethi0-11c` on `chore/deps-next15` (from `origin/main`, 40c40f2 today). Don't touch other worktrees, branches or plan folders. Your plan files are this folder's `plan.md` (Progress) only.
- **Lockfiles:** 9c (ethio-impl [5d9058]) removes `chapa-nestjs` from api, and 9d adds api packages, so `api/pnpm-lock.yaml` will clash. Whichever lands second merges `origin/main` and regenerates the lockfile with `pnpm install` (never hand-merge lockfile hunks), then re-runs the audit. The "`pnpm why axios` is empty" check belongs to whichever of 9c and 11c merges second.
- **Web overlap with 7c:** 7c (ethio-impl [5d9058]) recolours class names across `web/src` and merges first on 2026-10-08. 11c merges `origin/main` after that and fixes conflicts there; the class-name side wins, your async-API side wins.
- **The shared docker stack** (Postgres 55432, Redis, RabbitMQ, the api services) is one session at a time: ask ethio-planner for a slot before `docker compose up`, never stop or restart containers you didn't start, and say when you're done. Steps 2–5 and the web vitests need no stack, so do them first. Run `next start` for the header checks on a port of your own (for example 3011), not 3000.
- **Commits:** none on 2026-10-07 (the day's cap is used). From 2026-10-08, two grouped commits (deps, then Next 15), then one merge of `origin/main` and the PR merge. Ask ethio-planner before each commit so the day's count stays under the cap.
- **Review:** round 1 can run on the uncommitted tree with ethio-plan-review, as 7c did.

