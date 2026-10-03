# Refinement roadmap — 2026-10-02

Source: `audit.md` in this folder (129 findings as of 2026-10-03: 19 P0, 63 P1, 47 P2). It is kept local and git-ignored until the security phases (3, 4 and 6a–6c) are deployed, because the repo is public and it describes unfixed vulnerabilities. Visual direction: https://claude.ai/artifact/1KNuTFQ4NeRfsnuAJTxj5k

Status: approved by the user on 2026-10-02 (check-in answers below). Phases re-cut on 2026-10-02 and 2026-10-03; see the change log.

One plan, one branch and one PR per phase. Each phase runs through the team workflow (plan → plan review → implement → code review → user approval to push). With one backend implementer, branches stack: each phase branches from the previous phase's tip and merges `origin/main` back in once the phases below it have merged. The web phases 7a and 7b run alongside in a second worktree from `origin/main`.

## Ordering rules
- CI goes green first, so every later PR is actually gated.
- Schema migrations come before any phase that changes a table. With `synchronize` on, adding a unique constraint in production would fail at boot or silently rewrite tables.
- P0s before polish. Backend and web P0s are separate phases because they touch different layers and reviewers.
- Accessibility and page titles are fixed in the same pass as the page's visual polish, not in a separate sweep.
- A security phase is pushed only when it can be merged and deployed the same day.

## Phases

| # | Phase | Findings | Size | Implements / reviews code | Status |
|---|---|---|---|---|---|
| 1 | CI green and repo baseline | P0-07, P0-08, P1-25, P1-27, P1-31, `.gitignore` fixes | S | planner / plan-review | done (#17) |
| 2 | Schema migrations, `synchronize` off | P0-06, P2-14 (indexes as the first additive migration) | L | impl / review | done (#19) |
| 3 | Access control and exploitable web holes | P0-01, P0-02, P0-03, P0-10, P1-02 | L | impl / review | done (#20) |
| 4 | Payment integrity | P0-04, P0-05, P1-03, P1-12, P1-14 | L | impl / review | done (#21) |
| 5 | Web P0 fixes and a browser E2E harness | P0-09 (code part), P0-11 to P0-18, P1-30, P1-58 | M | impl / plan-review | done (#22) |
| 6a | Security hardening I: platform | P0-19, P1-01, P1-05, P1-11, P1-13 | L | impl / review | done (#24) |
| 6c | Money integrity II | P1-59, P1-60, P1-61, P1-62, P2-42, P2-46 | L | impl / review | done (#26) |
| 6b | Security hardening II: learning integrity | P1-04, P1-09, P1-10 | L | impl / review | planned |
| 6d | Money integrity III: pay-request writes, refunds of duplicate purchases | P1-63, P2-47, 6c review nits N1–N3 | L | impl / review | planned |
| 7a | UI foundations and accessibility | P1-33, P1-37, P1-38, P1-40, P1-43, P1-45, P1-47 (bell panel), P1-48 to P1-52, P1-53 (titles, robots, site OG image), P1-54, P1-57, P2-23, P2-24, P2-27, P2-29 (shared chrome), P2-33, P2-40 | M (web only) | planner / plan-review | done (#25) |
| 7b | Public and learner pages | P1-32, P1-34, P1-35, P1-36, P1-39, P2-22, P2-25, P2-30, P2-32, P2-35 | M (web and one auth endpoint) | planner / plan-review | done (#27) |
| 8 | UI polish II: role dashboards (two PRs, 8a and 8b) | P1-41, P1-42, P1-44, P1-46, P1-47 (rest), the role-page parts of P1-43, P1-45 and P1-48, P2-38, P2-39, P2-41, member "Leave institution" | M | planner (8a), impl (8b) / plan-review | 8a in progress |
| 9a | Event bus resilience and safe consumers | P1-15, P1-16, P1-20 | L | impl / review | planned |
| 9b | Transactional outbox | P1-17 | L | impl / review | planned |
| 9c | Outbound calls, scheduled jobs and status codes | P0-09 (ops part: jobs on sleeping instances), P1-18, P1-19, P1-23, P2-03 (rest), P2-15 | L | impl / review | planned |
| 9d | Observability | P1-21, slow-query log parameters (Phase 2 review) | L | impl / review | planned |
| 9e | Read paths | P1-22, P2-04 | L | impl / review | planned |
| 10 | Security headers, performance, SEO and Amharic for new learners | P1-06, P1-53 (rest), P1-55, P1-56, P2-26, P2-28, P2-34 | M | impl / plan-review | planned |
| 11a | CI/CD gates and repo hygiene | P0-09 (ops docs), P1-24, P1-26, P1-28, P2-16 to P2-21 | M | impl / plan-review | planned |
| 11b | Auth transport and tests for the high-risk paths | P1-07, P1-29 | L | impl / review | planned |
| 11c | Dependencies and Next 15 | P1-08 | M | impl / plan-review | planned |
| 12a | Motion system, shared primitives, shell, Home and Explore | user request (2026-10-03): calmer, consistent motion and UI polish | M (web only) | impl / plan-review | planned |
| 12b | Motion and polish: course page, checkout, learner path, certificates, dashboards | same request | M (web only) | impl / plan-review | planned |

The rows are in build order: 6c goes before 6b. When a phase merges, its row's status becomes `done (#PR)` and its `plan.md` status becomes `done`.

Remaining P2s are picked up opportunistically inside the phase that touches the same files, or left for after launch.

## Change log
- **2026-10-02:** the original phase 3 was split into 3 (access control, plus the exploitable web holes P0-01, P0-02 and P0-10, moved from the web P0 phase) and 4 (payment integrity). Reasons: a reviewable PR size, and the most exploitable holes first. The old phases 4–9 became 5 and 7–11.
- **2026-10-02:** phase 6 was added for the security P1s: P1-01, P1-05 and P1-13 came out of the old phase 3, and P1-04, P1-09, P1-10 and P1-11 had no phase. It was split into 6a (platform) and 6b (learning integrity), because seven findings across every service would make one unreviewable PR.
- **2026-10-02:** 6c was added for three money gaps found in the Phase 4 code review (P1-59, P1-60, P2-42), so Phase 4 didn't grow mid-review. P1-61, P1-62 and P2-46, found during 6a, joined it on 2026-10-03.
- **2026-10-02:** the old phase 5 was split into 7a (shared foundations and app-wide sweeps) and 7b (page-level UX). About 30 findings across the shared chrome and every public and learner page was too broad for one PR. P1-58 moved to Phase 5.
- **2026-10-02 and 2026-10-03:** for the same reason, phase 8 ships as two PRs (8a, 8b), phase 9 was split into 9a–9e and phase 11 into 11a–11c.
- **2026-10-03:** 6a gained P0-19, found during Phase 5.
- **2026-10-03:** 6d was added for two money gaps found in the Phase 6c code review (P1-63, P2-47) plus its three nits, so 6c didn't grow mid-review. It goes after 6b.
- **2026-10-03:** 7b merged (#27). The planner implements 8a in the web worktree while ethio-impl runs 6b and 6d.
- **2026-10-03:** phase 12 (motion and UI polish, the user's request) was added after 11c, at the user's choice, so it builds on Phase 10's `LazyMotion` and 11c's Next 15 instead of redoing them. It ships as 12a and 12b, with a before/after for the user between them.

## User decisions (2026-10-02 check-in)
- **Hosting:** stay on the free tier (Render free for the API, Vercel for web). So P0-09 is handled in code: fetch timeouts, ISR where possible, a friendly "waking up" state, and crons triggered by an external free scheduler instead of in-process timers on sleeping instances.
- **Amharic:** English-first launch. Translate the new-learner path (shell, auth, catalog, course page, checkout, dashboard); everything else stays English for now. A native speaker should review the strings.
- **Brand:** the visual direction in the artifact is approved as shown (blue + Inter kept, generated course covers, flag band as structure, calmer motion, contrast and focus fixes).
- **Allowed when their phase comes:** Next.js 14 → 15 upgrade, GitHub repo settings (branch protection, secret scanning), Render config changes. Anything outward-facing is still confirmed with the user before it is applied.
