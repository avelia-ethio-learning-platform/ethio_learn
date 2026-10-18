# Phase 11c: Dependencies and Next 15

Status: rebuilt 2026-10-18/19 on `chore/deps-next15` (draft PR, CI is the e2e/Playwright gate); waits on 9c for the api lockfile regeneration and the axios check. The 2026-10-07 Progress below is reference only (that worktree was lost); see "Rebuild 2026-10-18" and `drift.md` (binding amendments A1-A6, S1-S3).

## Amendments 2026-10-07 (planner, from the drift check and today's security alerts; these override the text below)
- **Owner (2026-10-07, changed ~15:20):** ethio-impl2 [280868] implements 11c (the user added it to run more in parallel), in parallel with ethio-impl [5d9058]'s 9c. Code review by ethio-plan-review. See "Parallel-work rules" in handoff.md.
- **Order and base:** 11c no longer goes last. Next 14.2.35 has open high-severity alerts with no 14.x fix, among them a Server Components DoS and SSRF in rewrites, and Dependabot rates two Next alerts critical (AVIF optimizer RCE, Windows RCE). Neither critical is reachable on Vercel/Linux, but the highs are, on an App Router site. So 11c starts now from `origin/main`, after 9a+9b merge, in `../ethi0-11c` on `chore/deps-next15`, and merges before 11b. The specs from Phases 5–10 are already in, and 11b's come later, written against Next 15. 12a/12b still follow 11c, as the user chose.
- **D1 (web audit):** in step 4 add `web/package.json` `pnpm.overrides` `"next>postcss": "^8.5.28"`, plus `nanoid@3` and `source-map-js@1` entries if step 2's audit still names them, with versions taken from the audit (decision 2). Check with `pnpm -C web why postcss`.
- **D2 (Dependabot):** in both npm entries of `.github/dependabot.yml`, replace the per-package major holds with one rule, `dependency-name: '*'` with `update-types: [version-update:semver-major]`. Comment it: "majors are planned work (P2-44 Next 16, P2-45 Nest)". Security updates still come through.
- **Dependabot PRs:** the planner closed #33, #35, #40, #41, #42, #43 and #44 (unplanned majors) and #45 (superseded) on 2026-10-07. 11c **absorbs** #36, #38, #39, #46 and #47 into its own lockfile changes instead of merging them one by one, which saves commits and keeps one reviewed dependency change. Dependabot closes them once main has their versions. Since #38 brings class-validator 0.15 and pdfkit 0.20 (0.x "minors"), the gate also generates one certificate PDF and checks one validation 400.
- **N1:** move `experimental.outputFileTracingIncludes` (OG fonts) to the top-level key in step 4.
- **Security alerts in scope (decision 2's procedure):** proxy-addr ≥ 2.0.8 (critical, not reachable with `trust proxy 1`), multer ≥ 2.3.0, nodemailer ≥ 10.0.6, js-yaml, glob, browserslist, cookie. braces has no fix, so it gets an ignore with its reason if unreachable; otherwise ask the planner. Target: `pnpm audit --prod --audit-level high` clean on api and web, and the Dependabot alerts list down to the documented ignores.
- **`next/font` build fetch:** Phase 10's `next/font/google` downloads at build time and flaked once in `docker-build (web)`. If it flakes during 11c, switch to `next/font/local` with the woff2 files committed. Otherwise leave it.
- **11b references don't apply (new order):** where this plan counts 11b's auth proxy, auth specs or a 5xx watch on `/api/v1/auth/*` as its coverage (the Goal, decision text, the gate and Rollout), strike them. 11c's coverage is the specs and Playwright suite from Phases 5–10, with the CSP fixture. Those checks move to 11b.
- **Commits:** the work stays uncommitted until the day's budget allows. Then it goes in as TWO grouped commits, so a regression can be bisected: (1) the minor-and-patch and security lockfile changes with their overrides; (2) the Next 15 / React 19 upgrade with its codemod changes.

Size: M (sessions: 3 — ethio-impl implements, ethio-plan-review reviews plan and code). Dependency bumps in `api` and `web`, the Next 14 → 15 and React 18 → 19 upgrade, and the code changes they force. No schema or API contract change.
Base branch: the tip of the stack when it starts, expected `fix/auth-transport` (11b), or `origin/main` if everything below has merged. It goes last, so the upgrade lands with every spec and Playwright test from Phases 5–11b in place. · Feature branch: `chore/deps-next15`
Roadmap: phase 11c (see 11a's "Roadmap change"). Finding: P1-08. It also lifts the Dependabot major-version holds that 11a set "until 11c".

## Goal
No production dependency has a reachable critical or high advisory, and the web runs on a Next line that still gets security fixes, without changing what any page renders, how it's cached, or what the API returns.

Acceptance criteria:
- **Audit:** `pnpm audit --prod --audit-level high` reports nothing for `web` and nothing for `api`. Anything left is listed in pnpm's audit ignore config, each with a one-line "not reachable because…" in `docs/DEPLOYMENT.md` ("Dependencies"). An ignore without a reason isn't allowed.
- **Web on Next 15.5.x with React 19:**
  - `next` is the latest `15.5.x` (npm's `backport` tag, 15.5.27 on 2026-10-03), with `react`/`react-dom` 19, `@types/react`/`@types/react-dom` 19, and `eslint-config-next` matching `next`;
  - `next build`'s route table is the same as before the upgrade: the same routes, each with the same static, ISR or dynamic marker and the same revalidate time;
  - at runtime, every caching-sensitive route answers with the same `Cache-Control` and `x-nextjs-cache` as before, on two consecutive requests (decision 3);
  - every page, route handler (11b's auth proxy), `opengraph-image` and metadata function that reads `params`, `searchParams`, `cookies()` or `headers()` awaits them;
  - the required `lint` check (11a) passes: either the bump adds no warnings, or this PR fixes the new ones or regenerates `.github/lint-baseline.json` with each new warning listed by rule in Progress (decision 4).
- **API:**
  - `nodemailer` is on its latest major (`10.x` on 2026-10-03), which ships its own types, so `@types/nodemailer` is removed;
  - each `@nestjs/*` package is on the latest release within its current major (`@nestjs/core` and friends 10.4.x, `@nestjs/typeorm` 10.0.x, `@nestjs/schedule` 4.x);
  - `axios` no longer appears in `api/pnpm-lock.yaml` (9c removed `chapa-nestjs`'s use; this phase confirms it);
  - patched transitive versions (multer, body-parser, path-to-regexp and whatever the audit names) are forced with `pnpm.overrides` within their current majors.
- **Dependabot:** 11a's hold on `next` majors becomes a hold on `next` ≥ 16 and `eslint-config-next` ≥ 16. The `react`, `react-dom` and `@types/react*` major holds stay, and so does the `@nestjs/*` major hold (decision 5).
- **No regression:**
  - every api spec, web vitest and CI e2e script passes;
  - the full Playwright suite passes in chromium and webkit;
  - the First Load JS of `/`, `/courses` and `/courses/[slug]` is no more than 10% above the before numbers.

## Non-goals
- **Next 16.** It's the current line (16.3.8), but the user approved 14 → 15. 15.5 still gets backports, and 15 is the required stop anyway: 16 removes the synchronous request APIs that 15 only deprecates. Moving to 16 is logged as audit P2-44, a follow-up for the user to approve.
- **Nest 11 or 12.** A Nest major brings Express 5: new route-pattern syntax, a different query parser, and changed error handling across eight services. That's a migration of its own. The advisories reachable today are fixed within 10.x by patches and overrides (decision 2). Logged as audit P2-45.
- **Tailwind 4, TypeORM 1.x, pnpm 10,** and other majors no advisory requires.
- **New features or refactors** riding along with the upgrade.

## Current state
At `62e29a1` (Phase 5), plus the later phases on the stack.

- **web** (`web/package.json`): `next ^14.2.4` (14.2.35 locked), `react`/`react-dom ^18.3.1`, `@types/react ^18.3.3`, `@types/node ^20`. `@tanstack/react-query 5`, `framer-motion 12`, `@testing-library/react 16`, `lucide-react`, `hls.js`, `pdfjs-dist`, `mammoth` and `@mediapipe/tasks-vision` are client-side.
  - **Caching-sensitive pages:** `export const revalidate`/`dynamic` appear in `app/layout.tsx`, `(public)/page.tsx` (Phase 5's static home), `(public)/educators/page.tsx` and `educators/[id]/page.tsx`. 7b adds per-course `opengraph-image` files, 10 adds headers and CSP, and 11b adds the first route handler.
  - **SSR fetches:** `lib/server-api.ts` makes the public reads, with an 8 s timeout. It relies on Next 14's default `fetch` caching inside ISR pages.
- **api:**
  - `@nestjs/*` `^10.3.9` (the `old` tag on npm is 10.4.19);
  - `@nestjs/*` majors differ: most are 10.x, `@nestjs/typeorm` is 10.0.x and `@nestjs/schedule` is 4.x;
  - `nodemailer ^6.9.14` (6.10.1 locked) in notification, used only through `createTransport`/`sendMail`/`verify` in `email.provider.ts`, with `@types/nodemailer`;
  - `chapa-nestjs` brought `axios@1.2.1`, which 9c removes;
  - `multer` and `body-parser` come in through `@nestjs/platform-express`. No multipart endpoint is mounted (uploads go straight to storage with signed URLs);
  - no `pnpm.overrides`.
- **The audit at the time of the refinement audit:** web had 2 critical and 11 high (Next: image-optimization RCE, Server Components DoS, rewrites SSRF, and a Windows-only RCE); api had 29 high (axios, nodemailer, multer). Step 2 re-measures, because Phases 9c and 11a change the picture.
- **Dependabot** (11a) ignores major versions of `next`, `react`, `react-dom` and `@nestjs/*` "until 11c".

## Design and key decisions
1. **Next 15.5, not 16, and not the last 14.2:**
   - 14.2 has no maintained line left.
   - 15.5 is the backport line the user's approval covers, and it gets the security fixes.
   - The async request APIs are the main break. 15 keeps a synchronous fallback with warnings, so codemod leftovers show up as warnings rather than crashes. The build must end with none of those warnings (step 4).
2. **API fixes inside the current majors:**
   - nodemailer is a direct dependency, used through three calls, so it takes the major bump. Version 10 declares its own `types` and needs Node ≥ 20 (CI and Render run 22). `@types/nodemailer` (latest 8.0.2) is removed, and `email.provider.ts` is typed against nodemailer's own `Transporter` and `SentMessageInfo`. Its spec and a local SMTP drill (step 3) cover the change.
   - Each `@nestjs/*` package moves to its latest release within its current major (10.4.x for core, common and the platform packages). For transitive advisories, a `pnpm.overrides` entry pins the fixed version within the same major (for example `multer` at its first fixed 2.x version, or `"path-to-regexp@0.1": ">=0.1.12"`), with the exact versions taken from the audit output, not from this plan.
   - **When no fix exists within the major**, the package goes into pnpm's audit ignore config with its reason, and only if it isn't reachable. multer is the expected case: no multipart route is mounted. A reachable advisory without a fix inside the major comes back to the planner before any major bump.
   - Rejected: Nest 11/12 now (Non-goals), and `--force` overrides across majors (silent API breaks at runtime).
3. **Caching stays exactly as it is:**
   - **What changes:** Next 15 no longer caches `fetch` by default, GET route handlers aren't cached by default, and the client router cache keeps pages for 0 s instead of 30 s.
   - **No reliance on defaults:**
     - every `server-api.ts` fetch states its caching explicitly, `next: { revalidate: <the page's value> }` or `cache: 'no-store'`, matching what the page did under 14;
     - each ISR or static page keeps its segment `revalidate`/`dynamic` export.
   - **The proof, build time:** the `next build` route table before and after, saved in Progress. Any route whose marker or revalidate time changed is fixed until the tables match.
   - **The proof, runtime (S2):** the route table can't show how a dynamic segment behaves per request. `/educators/[id]` has `revalidate = 120` but no `generateStaticParams`, and answers `Cache-Control: private, no-store` under 14. If 15 started ISR-caching it, a `<WakingUp />` render (an HTTP 200) would be cached for 120 s, and Phase 5's "recovers on Retry" would break.
     - Against `next start`, before and after, request each of these twice and record `Cache-Control` and `x-nextjs-cache`: `/`, `/courses`, `/courses/<id>`, `/educators`, `/educators/<id>`, `/verify/<uid>`, `/sitemap.xml` and one `opengraph-image` (7b).
     - The before and after tables must match. Phase 5's cold-start specs then cover the waking path on top.
   - **The client router cache** keeps 15's default (fresh data on back and forward navigation). It's a small behaviour change, but it never shows stale data, and Phase 5's waking flow already handles a refetch.
4. **Codemods, then hand fixes:**
   - **Order:** `npx @next/codemod@15 upgrade 15.5.27` (the latest 15.5.x when the step runs; never a bare `upgrade` or `major`, which resolve npm's `latest`, a 16.x that removes `next lint` and renames middleware), or the `next-async-request-api` transform on its own; then `npx types-react-codemod@latest preset-19`.
   - **Then by hand:** remaining type errors (the global `JSX` namespace → `React.JSX`, `useRef` now needing an argument, `ReactElement` props typed `unknown`), any `forwardRef` the codemod flags, and test utilities.
   - **One commit per codemod,** so the review can tell generated changes from hand-written ones.
   - **Lint (S1):** the `eslint-config-next` 14.2 → 15.5 bump brings newer `@next/eslint-plugin-next` and `react-hooks` rules, and React 19's types can surface new hits. 11a's required `lint` check fails if the count rises. So run `pnpm -C web lint` (and the baseline comparison) before and after the bump, then fix the new hits, or regenerate the baseline in this PR and list the new warnings by rule in Progress. If `web`'s `lint` script calls `next lint` (deprecated in 15.5, removed in 16), switch it to the ESLint CLI (`eslint .`) here.
5. **Dependabot after the upgrade:**
   - change the `next` hold to versions `>= 16`, and add the same hold for `eslint-config-next` (11a's `next-react` group would otherwise propose a 16 config against a 15 `next`), with a comment pointing at audit P2-44;
   - keep the `react`, `react-dom` and `@types/react*` major holds: Next 15's peer range is React 18–19, so a React major can't land before Next does;
   - keep the `@nestjs/*` major hold, with a comment pointing at P2-45.
6. **Measured, not assumed:**
   - Step 2 records the before state:
     - `pnpm audit --prod --json` for both workspaces, summarized by severity and package;
     - the `next build` route table;
     - First Load JS for `/`, `/courses` and `/courses/[slug]`;
     - the runtime caching headers (decision 3);
     - the web lint warning count.
   - Step 8 records the same after.

## Steps
- [x] 1. Branch `chore/deps-next15` from the base above.
- [x] 2. Before snapshot (decision 6) in Progress: audit summaries, the route table, the runtime caching headers, First Load JS sizes, the web lint count.
- [x] 3. API (decision 2):
  - `nodemailer` to the latest major; remove `@types/nodemailer` and fix `email.provider.ts` against nodemailer's own types;
  - each `@nestjs/*` package to its latest release within its current major;
  - `pnpm.overrides` from the audit output;
  - the ignore config only for unreachable advisories, with reasons;
  - confirm that `pnpm why axios` is empty.

  Verify:
  - `email.provider.spec.ts`;
  - a local drill: run the stack with `SMTP_HOST` pointing at a throwaway local SMTP catcher (for example `docker run --rm -p 1025:1025 -p 8025:8025 axllent/mailpit`), sign up, and see the verification email arrive. Never use real SMTP credentials; leave `api/.env`'s values out of the shell, as the earlier e2e notes say.
- [x] 4. Web (decisions 1, 4):
  - bump `next`, `react`, `react-dom`, the React types and `eslint-config-next`;
  - run the codemods with the pinned target (one commit each), then the hand fixes;
  - `next build` must finish with no sync-dynamic-API warnings;
  - lint before and after the bump: fix the new hits or regenerate the baseline, listing them by rule (decision 4); switch `next lint` to `eslint .` if it's used.
- [x] 5. Caching (decision 3): confirm every `server-api.ts` fetch states its caching (Phase 5 already passes `next: { revalidate }`, so this is mostly a check); compare the route table and the runtime headers with step 2's and fix until both match.
- [x] 6. Dependabot (decision 5).
- [x] 7. `docs/DEPLOYMENT.md` "Dependencies": the versions and why (15.5 backport line, Nest 10 with overrides), every audit ignore with its reason, and the P2-44 and P2-45 follow-ups. Under P2-45, name the moderate `@nestjs/core` advisory that's fixed only in ≥ 11.1.18, so the Nest-major follow-up carries a concrete reason.
- [x] 8. After snapshot (decision 6), with both audits clean at `high`, the route table and runtime headers matching, and the First Load JS budget checked.
- [ ] 9. Full gate:
  - `pnpm -C api build && pnpm -C api test:coverage && pnpm -C api typecheck && pnpm -C api db:check && pnpm -C api lint`;
  - `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build && pnpm -C web lint`;
  - the CI e2e scripts, and the full Playwright suite in chromium and webkit locally. Phase 5's cold-start specs and 11b's auth specs matter most here: they exercise ISR, the waking states and the route handler.
- [ ] 10. Code review by ethio-plan-review; the user approves push and PR.

## Test plan
- **Existing suites are the test:**
  - every api spec, web vitest, CI e2e script and Playwright spec (chromium and webkit) passes unchanged, apart from mechanical React 19 typing fixes in test files;
  - any assertion that has to change gets a line in Progress saying why.
- **Specific checks:**
  - the route table and the runtime caching headers match (step 5);
  - the `lint` check passes against the baseline (step 4);
  - the audits are clean (step 8);
  - the SMTP drill delivers (step 3);
  - First Load JS is within the budget (step 8).

## Rollout and ops
- **Vercel** builds with Next 15 on the merge. Node 22 is already set. No env change.
- **Render** rebuilds every service. The only runtime change is nodemailer for the notification service: after deploy, the user checks that one real email (a sign-up or a password reset) still arrives.
- **Watching:** Vercel's build log for warnings, and 9d's access log for any new 5xx on `/api/v1/auth/*` (11b's route handler on Next 15).

## Risks and open questions
- **A caching change the route table doesn't show:** a page can keep its marker while a fetch inside it stops being cached, or a dynamic segment can start being cached per request. The explicit fetch caching and the runtime header check (decision 3) close both, and the cold-start specs would catch an ISR page that suddenly needs the API.
- **React 19 inside client libraries:** react-query 5, framer-motion 12 and testing-library 16 support it. `hls.js`, `pdfjs-dist`, `mammoth` and mediapipe don't use React. If a library breaks, the implementer pins its last compatible version and logs it, rather than patching around it.
- **Next 15.5's backport window will close.** P2-44 (Next 16) should be scheduled within a few months of launch.

## Progress and deviations (implementer)

### Rebuild 2026-10-18/19
- **Base:** `feat/color-system` (7c), then `git merge origin/main` once 7c merged (e4b4cde). No rebase.
- **Commits:** web minor/patch + `next>postcss` (#46, #50); Next 15.5.28 + React 19.3.1 + codemod (#47); tsconfig formatting fix; merge main; api manifests + overrides + docs (#49); api lockfile alone (regenerate after 9c).
- **Codemod:** `next-async-request-api` changed the same 4 pages; `types-react-codemod preset-19` changed nothing. Same hand fixes as 2026-10-07.
- **Route table:** markers identical to the before snapshot; First Load JS `/` 128 → 138, `/courses` 128 → 138, `/courses/[id]` 124 → 134 kB (+7.8/7.8/8.1%). Build log: no warnings.
- **Headers (cold, API unreachable, port 3011):** every Cache-Control matches `snapshots/before/headers-cold.txt` apart from the accepted bounded `stale-while-revalidate`; `/educators/<id>` waking render stays `private, no-store`. ISR pages show STALE (not HIT) because the build was over 60 s old and revalidation can't reach the API. Warm pass not re-run (same code as 2026-10-07's matching run).
- **Audits:** web `--prod --audit-level high` clean (1 moderate sprintf-js). api: only axios (12 high, chapa-nestjs, gone with 9c) + braces (ignored).
- **Gate:** web typecheck ✓, vitest 84 files / 743 ✓, build ✓; api build ✓, typecheck ✓, jest 73 suites / 1417 ✓ (1 skipped: real-DB spec); lint-check ✓ (web 4, api 166).
- **S1:** `"agentGuidance": false` in `api/turbo.json`; a full turbo build wrote no `api/AGENTS.md`.
- **S2:** dependabot.yml header and DEPLOYMENT.md "Dependencies" say security-update PRs are off; advisories come as alerts and in CI's audit summary.
- **S3:** measured on the unchanged branch tip first: api 166 vs baseline 211, all from no-floating-promises 55 → 10 (the 10 left are `bootstrap()` in each `main.ts`). A probe file floating `EventBusService.publishCommand` from `@ethiopialearn/common` is reported, so types resolve; `--update` committed.
- **Not done (deviation):** the dev-only `pnpm update -r --depth Infinity` refresh (drift: optional, outside `--prod`).
- **Open:** after 9c merges: `git merge origin/main`, `pnpm -C api install` to regenerate the lockfile, `pnpm -C api why axios` empty, re-run api audit and lint-check (9c may change floating-promise counts). The local SMTP/PDF/400 drill was not re-run (2026-10-07's passed on nodemailer 10.0.15; now 10.1.6); CI's e2e job runs the api flows.


### 2026-10-07 (ethio-impl2 [280868])
Worktree `../ethi0-11c`, branch `chore/deps-next15` from `origin/main` 40c40f2 (no upstream set). Everything is uncommitted (today's cap). Raw before/after files are in this session's scratchpad; the summaries are below.

**Commit split (from 2026-10-08, ask the planner first):**
1. **Deps and security:**
   - api manifests, overrides, audit ignore and lockfile;
   - web minor-and-patch (#39, #46) plus the `next>postcss` override, with web's `package.json` and lockfile taken from the saved intermediate state (Next 14 still);
   - `.github/dependabot.yml`.
2. **Next 15 / React 19:** the bump, the codemod output, the test fix, `next.config.mjs`, `tsconfig.json`, `next-env.d.ts`, plus `docs/DEPLOYMENT.md`, the `ci.yml` comment and this plan folder.

**Step 2 / 8: audits (`pnpm audit --prod`), before → after**

| | critical | high | moderate | low |
|---|---|---|---|---|
| web before | 2 (next) | 12 (next 8, postcss 2, nanoid, source-map-js) | 14 | 2 |
| web after | 0 | 0 | 1 (sprintf-js, no fix) | 0 |
| api before | 1 (proxy-addr) | 31 (axios 12, nodemailer 5, multer 6, brace-expansion 5, nanoid 2, braces) | 38 | 5 |
| api after | 0 | 13: axios 12 (goes with 9c's chapa-nestjs removal) + braces 1 (ignored) | 23 (axios 18; file-type 2, @nestjs/core, uuid) | 1 (axios) |

- `pnpm -C web audit --prod --audit-level high` is clean.
- `pnpm -C api audit --prod --audit-level high` is clean except axios. The planner set the merge order 11d → 7c → 9c → 11c, so after merging origin/main: regenerate the lockfile, confirm `pnpm why axios` is empty, then re-run the audit.
- **All deps, dev included:** jest's browserslist and js-yaml 3, and eslint's brace-expansion 1, were refreshed inside their ranges with `pnpm update -r --depth Infinity`, so no override was needed. What's left: api is axios plus the moderates; web dev is braces (tailwind/eslint globs, no fix), postcss-selector-parser 6 (tailwind 3, fix only in 7) and sprintf-js.

**Step 3: API**
- `nodemailer` ^10.0.15 and `@types/nodemailer` removed. `email.provider.ts` compiles unchanged against nodemailer's own types (`Pick<nodemailer.Transporter, 'sendMail' | 'verify'>`, `info.messageId`).
- `@nestjs/*` were already locked at the latest of each major (10.4.22, typeorm 10.0.2, schedule 4.1.2). No change.
- Absorbed #36 (jest 30.5.2, ts-jest 29.4.14) and #38 (turbo 2.11.7, class-validator ^0.15.1, aws-sdk ^3.1146.0, pdfkit ^0.20.2, @types/pdfkit ^0.17.6).
- Also: typeorm ^0.3.31 (moderate GHSA-2rp8-mm9q-fp49, inside the range) and cookie ^0.7.2 in auth (low GHSA-pxg6-pf52-xh8x; `parse`/`serialize` unchanged).
- Overrides in `api/package.json`: `body-parser@1 ^1.20.6`, `brace-expansion@2 ^2.1.7`, `multer@2 ^2.3.0`, `nanoid@3 ^3.3.18`, `proxy-addr@2 ^2.0.8`, `qs@6 ^6.16.0`.
- **The braces ignore:** `pnpm.auditConfig.ignoreCves: ["CVE-2026-93687"]` (GHSA-vfj7-8cjw-p6xm). It isn't reachable: the gateway's `createProxyMiddleware` has no `pathFilter`, so http-proxy-middleware takes its string-prefix path and never calls micromatch/braces.
  - Deviation: this uses `ignoreCves`, not `ignoreGhsas`. CI's pnpm 9.4.0 ignores `ignoreGhsas`; I tested both versions.
- **Drill:** the stack ran on `.env.example` values, a scratch DB `el_11c` and mailpit on 1025.
  - The notification service logged `SMTP ready (<loopback>:1025)` on nodemailer 10.
  - A sign-up's "Verify your EthiopiaLearn account" email arrived in mailpit, along with the 22 emails from demo-seed.
  - The #38 checks: a validation 400 lists all four messages (class-validator 0.15), and the issued certificate PDF downloads and renders correctly (pdfkit 0.20, PDF 1.3, 1 page).

**Step 4: web**
- `next` ^15.5.27, `react`/`react-dom` ^19.3.0, `@types/react`/`-dom` ^19.3.0, `eslint-config-next` 15.5.27.
- Absorbed #39 (react-query, hls.js, lucide, mammoth, testing-library, plugin-react, autoprefixer, postcss ^8.5.28) and #46 (vitest ^4.1.11, plus `@vitest/coverage-v8` ^4.1.11 for its peer).
- The `next>postcss` override puts every postcss at 8.5.29 (`pnpm why postcss`), which also clears nanoid and source-map-js.
- **Codemods:** `@next/codemod@15 next-async-request-api` (the transform on its own, as decision 4 allows) changed 4 files: `courses/page.tsx`, `courses/[id]/page.tsx`, `educators/[id]/page.tsx` and `verify/[uid]/page.tsx`. `types-react-codemod preset-19` changed nothing.
  - `courses/[id]/opengraph-image.tsx` keeps a synchronous `params`, which is still sync for image routes in 15 (it becomes a Promise in 16).
- **Hand fixes:**
  - `courses/[id]/page.test.ts` passes `params: Promise.resolve(...)`;
  - `courses/page.tsx`'s signature was reformatted to house style;
  - `next.config.mjs`: `outputFileTracingIncludes` moved to the top level (N1);
  - `tsconfig.json` keeps its formatting plus the `"target": "ES2017"` Next 15 adds;
  - `next-env.d.ts` was regenerated by Next.
- **Deviation:** `eslint: { ignoreDuringBuilds: true }` in `next.config.mjs`. Next 15.5's build-time lint passes ESLint 8 legacy options (`useEslintrc`, `extensions`) to the flat config and prints `⨯ ESLint: Invalid Options`. Next 14's build lint printed nothing. Lint is its own required check (`eslint .` via lint-check), so the build skipping it changes no gate.
- **The build log** is clean: no warnings, no sync-dynamic-API messages. The Google font fetch retried once before and after, then succeeded.
- **Lint:** web 4 → 4 problems (`import/no-anonymous-default-export` 2, `react-hooks/exhaustive-deps` 2) and api 166 (baseline 211). `node scripts/lint-check.mjs` reports "No rule above its baseline", so no baseline change.

**Step 5 / 8: caching**
- Every server-side fetch goes through `serverApi` with `next: { revalidate }`. sitemap uses it too, and the other `fetch` callers are client components.
- **The route table matches:** every route keeps its ○/ƒ marker, and Next 15 now prints the revalidate times: `/` 1m, `/educators` 2m, `/sitemap.xml` 1h, the same as 14's prerender-manifest (60/120/3600).
  - The prerender manifest differs only by `/_not-found` being listed (it was ○ in both tables);
  - `/icon/[[...__metadata_id__]]` is now printed `/icon/[__metadata_id__]` (Next's internal naming; ƒ in both).
- **Runtime headers** (`next start` on 3011, two requests per route, a second pass 3 s later, then a cold twin on 3012 with `GATEWAY_INTERNAL_URL` unreachable): `x-nextjs-cache` and every `Cache-Control` match, except one accepted deviation (planner, 2026-10-07):
  - on the ISR pages `/` and `/educators`, 14 sent `s-maxage=N, stale-while-revalidate` and 15 sends `stale-while-revalidate=<1 year − N>`, from Next 15's default `expireTime` (1 year). No config change.

  | route | Cache-Control (both) | x-nextjs-cache, warm pass 1 / pass 2 / cold |
  |---|---|---|
  | `/` | `s-maxage=60, stale-while-revalidate[=…]` | STALE / HIT / HIT |
  | `/courses`, `/courses/<id>`, `/educators/<id>`, `/verify/<uid>` | `private, no-cache, no-store, max-age=0, must-revalidate` | – |
  | `/educators` | `s-maxage=120, stale-while-revalidate[=…]` | STALE / HIT / HIT |
  | `/sitemap.xml` | `public, max-age=0, must-revalidate` | HIT |
  | `/courses/<id>/opengraph-image-10l7fm` | warm `public, max-age=86400, stale-while-revalidate=604800`; cold `public, max-age=300` | – |

  - `/educators/<id>` stays `private, no-store` while it renders "Waking up the server" with the API down, so a waking page is never cached (S2).
- **First Load JS** (budget +10%): `/` 128 → 138 kB (+7.8%), `/courses` 128 → 138 kB (+7.8%), `/courses/[id]` 124 → 134 kB (+8.1%). The shared bundle went 87.8 → 103 kB (React 19 + Next 15 runtime).

**Step 6: Dependabot (D2).** Both npm entries now hold `dependency-name: '*'` at `version-update:semver-major`, with comments citing P2-44 / P2-45. The per-package holds are gone, and the header comment says majors are planned work and security updates still come through.

**Step 7.** `docs/DEPLOYMENT.md` gained "## Dependencies", after "Environments":
- the versions and why, the overrides, the braces ignore with its reason;
- the moderates with reasons: `@nestjs/core` GHSA-36xv-jgw5-4q75 under P2-45, file-type, uuid, sprintf-js;
- the P2-44 and P2-45 follow-ups.

The `ci.yml` audit comment now points there.

**Step 9: gate so far**
- api: `build` ✓; `test` (CI runs `pnpm test`; the plan's `test:coverage` script doesn't exist in api) 73 suites passed, 1 skipped, 1417 tests passed (the skipped suite is the real-DB resend spec, which needs `TEST_DATABASE_URL`); `typecheck` ✓; `db:check` on `el_11c` "No drift"; lint via lint-check ✓.
  - `db:check` prints a pg `DeprecationWarning` (concurrent `client.query`) during the schema diff. It's dev tooling only; the service logs on typeorm 0.3.31 show none.
- web: `typecheck` ✓; `test` 82 files / 691 tests ✓; `build` ✓; lint ✓.
- React 19 removals scan (`defaultProps`, `propTypes`, `ReactDOM.render`, `findDOMNode`, `react-dom/test-utils`, string refs): none in `src` or `e2e`.
- **Webkit:** `playwright.config.ts` on main has only chromium (11b adds webkit), so the Playwright run is chromium, per the Amendments (11b's coverage moved to 11b).

**In flight / next step (checkpoint 2026-10-07 ~16:10):**
- **Code review round 1** was sent to ethio-plan-review on the uncommitted tree; its verdict goes to `code-review.md` in this folder. The planner accepted `eslint.ignoreDuringBuilds` (the comment is beside it) and braces-by-CVE.
- **The stack:** ethio-impl [5d9058] holds it for 9c's gate, and ethio-planner [a4b0f1] will message "free". Don't `docker compose up` before then.
- **Then, with the slot:**
  1. In `../ethi0-11c`, start the api with `env -i HOME=$HOME PATH=<node22>:$PATH bash scripts/start-backend.sh`. The worktree's git-ignored `api/.env` is `.env.example` with `DATABASE_URL` → `el_11c`, an empty `GROQ_API_KEY`, and `SMTP_HOST` = the loopback address and `SMTP_PORT=1025` added (mailpit isn't needed for e2e; without it the SMTP verify just logs an error).
  2. Run the CI e2e scripts in CI's order: `e2e-revisions`, `e2e-institution`, `e2e-payments`, `e2e-learning`, `e2e-security`. demo-seed already ran on `el_11c`.
  3. Wait 60 s, then run the Playwright suite: `env -i HOME=$HOME PATH=<node22>:/usr/bin:/bin NEXT_PUBLIC_WAKE_URLS=http://localhost:4101/health ./node_modules/.bin/playwright test` in `web/`. First check that 3000 and 3100 are free, because `reuseExistingServer` would pick up a stranger's server. The web build in `.next` is the after build.
  4. Run `E2E_CHECK_RATE_LIMIT=1 node scripts/e2e-smoke.mjs` last.
  5. Stop everything (`scripts/stop-backend.sh`, kill `next start`) and message the planner "stack free". Send the results to ethio-plan-review.
- **Session scratchpad** (`/tmp/claude-1000/…/scratchpad/`, which the reboot loses; the files that matter were copied into this folder's `snapshots/` and `commit1-web/`, neither of them to be committed):
  - `before/` and `after/`: audits, route tables, prerender lists and header tables;
  - `headers.sh`: the header check;
  - `web-before/`: the Next 14 build copy;
  - **`commit1-web/package.json` and `pnpm-lock.yaml`: web's state for commit 1** (Next 14 + #39/#46 + `@vitest/coverage-v8` ^4.1.11 + the `next>postcss` override). If it's lost, rebuild it from origin/main's web/package.json with those changes and `pnpm install`.
- **Commits** from 2026-10-08, after asking ethio-planner; see "Commit split" above. Before the PR: merge `origin/main` (7c's and 9c's merges), regenerate both lockfiles with `pnpm install` (never hand-merge them), confirm `pnpm why axios` is empty, re-run both audits and the gates.

**CHECKPOINT 2026-10-07 ~16:35 (paused by the user, then a PC reboot; resume on another machine). State:**
- **Step 9, in progress on the stack slot** (granted ~16:10; the api services run from `../ethi0-11c` on `el_11c`):
  - the CI e2e scripts all passed: revisions, institution, payments, learning, security;
  - **Playwright (chromium) finished: 115 passed, 14 failed, 1 skipped (5.5 min).** Log: `snapshots/playwright-run1.log` in this folder.
    - Failures: `catalog-and-404.spec.ts:7` (Newest → sort=new) plus 13 in `a11y.spec.ts`: light admin ×2 and lesson player; dark mode public course pages, login/verify, 375 px course, admin ×2, editor, institution, preview, learner ×2.
    - Messages: 5 × `toBeVisible` element not found, 6 × expected true / received false, 2 × the 30 s timeout, 2 × page closed, and **401s from the api** (`GET /me/certificates` ×3, `/enrollments` ×2, `/courses` ×1). The dark-mode block ran last, so the stored logins (`e2e/.auth`) may have expired, or the refresh flow broke on Next 15 / React 19.
    - **Not yet known whether these are real or flaky.** The planner's tip from 9c: 3 timeouts at a load average of ~9.7 passed with `--last-failed`.
    - **Next:** on a stack slot, first re-run `playwright test --last-failed`. Whatever still fails, compare against `origin/main`'s build (the 9c run is the reference), and debug the 401s (token TTL vs. refresh) before calling anything an 11c regression.
  - Not run yet: `E2E_CHECK_RATE_LIMIT=1 node scripts/e2e-smoke.mjs` (after Playwright).
  - **The stack is released:** the api services and next are stopped, and postgres/redis/rabbitmq/minio were left alone. `el_11c` stays (seeded, demo-seed run); the worktree's git-ignored `api/.env` points at it.
- **Code review round 1: APPROVED** (S1–S3):
  - S1 done: `"agentGuidance": false` in `api/turbo.json`, and `api/AGENTS.md` deleted. Still to check that a turbo command doesn't re-create it.
  - S2 done: the dependabot.yml header and DEPLOYMENT.md now say security-update PRs are off and advisories come as alerts and in the CI audit summary.
  - S3 pending: the drop in no-floating-promises predates 11c (the before run on unchanged origin/main already showed 166/211). Probably 9a+9b, whose outbox moved publishes into awaited transactions. To prove it, count the rule's hits per file at 8c511b5 (11a's merge) and at 40c40f2, then run `lint-check --update` if the drop is real.
  - Then answer S1–S3 inline in code-review.md.
- **Deviations, all logged above:**
  1. `eslint: { ignoreDuringBuilds: true }`: Next 15.5's build lint fails on the ESLint 8 flat config, and lint is its own required check. Accepted by the planner.
  2. braces ignored by CVE (`ignoreCves`), because CI's pnpm 9.4.0 doesn't read `ignoreGhsas`. Accepted.
  3. ISR pages' bounded `stale-while-revalidate` (Next 15 `expireTime`, 1 year). Accepted, no config change.
  4. `opengraph-image` keeps a synchronous `params` (still sync in 15).
  5. One codemod pass, `next-async-request-api`, instead of `upgrade`; `types-react-codemod` changed nothing.
  6. Two grouped commits instead of one commit per codemod (Amendments).
  7. The api has no `test:coverage` script, so the gate ran `pnpm test`, as CI does.
  8. typeorm ^0.3.31 and cookie ^0.7.2 were bumped inside their ranges for moderate/low advisories.
  9. Dev transitive deps (browserslist, js-yaml 3, brace-expansion 1) were refreshed inside their ranges with no override.
  10. Playwright runs chromium only; webkit comes with 11b.
- **Archive note:** `snapshots/` and `commit1-web/` in this folder are working files. Don't commit them; `commit1-web/` supplies web's package.json and lockfile for commit 1.
