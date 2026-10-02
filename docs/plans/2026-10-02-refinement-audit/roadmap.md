# Refinement roadmap — 2026-10-02

Source: `audit.md` in this folder (117 findings: 18 P0, 58 P1, 41 P2). It is kept local and git-ignored until the security phases (3 and 4) are deployed, because the repo is public and it describes unfixed vulnerabilities. Visual direction: https://claude.ai/artifact/1KNuTFQ4NeRfsnuAJTxj5k

Status: approved by the user on 2026-10-02 (check-in answers below).

One plan, one branch and one PR per phase, all based on `origin/main`. Each phase runs through the team workflow (plan → plan review → implement → code review → user approval to push). While impl builds one phase, the planner plans the next.

## Ordering rules
- CI goes green first, so every later PR is actually gated.
- Schema migrations come before any phase that changes a table. With `synchronize` on, adding a unique constraint in production would fail at boot or silently rewrite tables.
- P0s before polish. Backend and web P0s are separate phases because they touch different layers and reviewers.
- Accessibility and page titles are fixed in the same pass as the page's visual polish, not in a separate sweep.

## Phases

| # | Phase | Findings | Size | Implements / reviews code |
|---|---|---|---|---|
| 1 | CI green and repo baseline | P0-07, P0-08, P1-25, P1-27, P1-31, `.gitignore` fixes | S | planner / plan-review |
| 2 | Schema migrations, `synchronize` off | P0-06, P2-14 (indexes as the first additive migration) | L | impl / review |
| 3 | Backend security and money integrity | P0-03, P0-04, P0-05, P1-01, P1-02, P1-03, P1-05, P1-12, P1-13, P1-14 | L | impl / review |
| 4 | Web P0 fixes and a browser E2E harness | P0-01, P0-02, P0-09 (code part), P0-10 to P0-18, P1-30 | M | impl / plan-review |
| 5 | UI polish I: design foundations, public and learner pages (with their a11y and titles) | P1-32 to P1-40, P1-43, P1-45, P1-48 to P1-54, P1-57, P1-58, related P2 UI items | M (broad, web only) | impl / plan-review |
| 6 | UI polish II: role dashboards | P1-41, P1-42, P1-44, P1-46, P1-47, dashboard a11y, P2-38, P2-39, P2-41 | M | impl / plan-review |
| 7 | Reliability and observability | P1-15 to P1-23, P2-03, P2-04, P2-15 | L | impl / review |
| 8 | Performance, SEO, security headers, i18n | P1-06, P1-53 (rest), P1-55, P1-56, P2-26, P2-28, P2-34 | M | impl / plan-review |
| 9 | Tests, CI/CD gates and launch ops | P0-09 (ops part), P1-07, P1-08, P1-24, P1-26, P1-28, P1-29, P2-17 to P2-21 | M | impl / plan-review |

Remaining P2s are picked up opportunistically inside the phase that touches the same files, or left for after launch.

## User decisions (2026-10-02 check-in)
- **Hosting:** stay on the free tier (Render free for the API, Vercel for web). So P0-09 is handled in code: fetch timeouts, ISR where possible, a friendly "waking up" state, and crons triggered by an external free scheduler instead of in-process timers on sleeping instances.
- **Amharic:** English-first launch. Translate the new-learner path (shell, auth, catalog, course page, checkout, dashboard); everything else stays English for now. A native speaker should review the strings.
- **Brand:** the visual direction in the artifact is approved as shown (blue + Inter kept, generated course covers, flag band as structure, calmer motion, contrast and focus fixes).
- **Allowed when their phase comes:** Next.js 14 → 15 upgrade, GitHub repo settings (branch protection, secret scanning), Render config changes. Anything outward-facing is still confirmed with the user before it is applied.
