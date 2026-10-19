# Phase 11c: Dependencies and Next 15

Status: code review APPROVED WITH NITS (PR #54, draft). Merges after 9c (#56): then regenerate `api/pnpm-lock.yaml`, confirm no axios, re-run audit, lint-check and the SMTP drill. Progress: [progress.md](progress.md). Binding drift amendments: [drift.md](drift.md). The full 2026-10-03 plan text and the lost 2026-10-07 run are in git history (`git show cf8c956:docs/plans/2026-10-03-deps-next15/plan.md`).

Finding: P1-08. Branch: `chore/deps-next15`. Size M.

## Goal
No production dependency has a reachable critical or high advisory, and the web runs on a Next line that still gets security fixes, without changing what any page renders, how it's cached, or what the API returns.

## Acceptance criteria
- **Audit:** `pnpm audit --prod --audit-level high` clean for `web` and `api`. Anything left is ignored in pnpm's audit config with a "not reachable because…" line in `docs/DEPLOYMENT.md` "Dependencies".
- **Web:** `next` = npm's `backport` tag (15.5.28), React/React DOM 19 with matching types and `eslint-config-next`.
  - every `params`/`searchParams`/`cookies()`/`headers()` read is awaited;
  - the `next build` route table keeps every route's marker and revalidate time;
  - runtime `Cache-Control`/`x-nextjs-cache` match Next 14 on the caching-sensitive routes (accepted deviation: bounded `stale-while-revalidate`);
  - `lint` passes against `.github/lint-baseline.json`.
- **API:** nodemailer on its latest major (own types, `@types/nodemailer` gone); `@nestjs/*` at the latest of their current majors; no axios in the lockfile; transitive fixes via `pnpm.overrides` within majors.
- **Dependabot:** one `*` semver-major hold per npm entry (majors are planned work: P2-44 Next 16, P2-45 Nest).
- **No regression:** api specs, web vitest, CI e2e scripts and Playwright (chromium) pass; First Load JS of `/`, `/courses`, `/courses/[id]` ≤ +10%.

## Non-goals
- Next 16 (P2-44), Nest 11/12 (P2-45), Tailwind 4, TypeORM 1.x, pnpm 10, any feature or refactor.

## Decisions
1. **Next 15.5, not 16:** 15 keeps sync-API fallbacks with warnings; the build must end with none.
2. **API fixes inside the current majors:** overrides pinned from audit output; no-fix advisories ignored only if unreachable, with the reason; a reachable one goes back to the planner.
3. **Caching stays:** every SSR fetch states `next: { revalidate }` (`web/src/lib/server-api.ts`); segment exports kept; client router cache keeps 15's default. Proof: route table + runtime headers before/after (`snapshots/`).
4. **Codemods:** `@next/codemod@15 next-async-request-api` (pinned major, never bare `upgrade`), then `types-react-codemod preset-19`, then hand fixes.
5. **Dependabot:** see acceptance; security-update PRs are off, advisories arrive as alerts and in CI's `audit` summary.
6. **Measured, not assumed:** audits, route table, First Load JS, headers and lint counts before and after.

## Steps
- [x] 1. Branch (from 7c, then merged main).
- [x] 2. Before snapshot (reused from `snapshots/before/`, drift A2).
- [x] 3. API deps, overrides, braces ignore.
- [x] 4. Web: Next 15 + React 19 + codemod + hand fixes.
- [x] 5. Caching proof.
- [x] 6. Dependabot.
- [x] 7. `docs/DEPLOYMENT.md` "Dependencies".
- [x] 8. After snapshot.
- [ ] 9. Full gate after 9c merges: lockfile regenerated, `pnpm -C api why axios` empty, audit, lint-check, SMTP drill (mailpit), CI green.
- [x] 10. Code review (APPROVED WITH NITS, 2026-10-19).

## Rollout (user, after merge)
- Vercel builds with Next 15: watch the build log.
- `curl -sI https://ethio-learn.vercel.app/ | grep -i cache-control` prints `public, max-age=0, must-revalidate`.
- One course share image (`/courses/<id>/opengraph-image-10l7fm`) returns 200 `image/png`.
- Render rebuilds every service: one real email (sign-up or reset) still arrives; Render deployed the merge SHA.
