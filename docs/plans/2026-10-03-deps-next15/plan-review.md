# Plan review: Phase 11c, dependencies and Next 15

## Round 1 (2026-10-03) · Verdict: APPROVED (three should-fixes to fold in before handoff)
Reviewed: `plan.md` (status "in review (round 1)"), against the code at `fix/web-p0` and the 11a and 11b plans it builds on.

Verified:
- **The audit works here:** `pnpm -C web audit --prod --audit-level high` on pnpm 9.15.9 answers today: 2 critical and 11 high, all via `next@14.2.35`. Steps 2 and 8 can measure what the acceptance asks.
- **The targets are clean at `high`:** npm's bulk advisory endpoint returns no advisory for `next@15.5.27`, `react`/`react-dom@19.2.0` or `nodemailer@10.0.13`.
  - `@nestjs/core@10.4.19` has one **moderate** advisory, fixed only in ≥ 11.1.18. That's below the plan's bar, but see N3.
- **axios:** `api/pnpm-lock.yaml` has `axios@1.2.1` from `chapa-nestjs` only, so it disappears once 9c drops that package.
- **multer:** no `FileInterceptor`/`FilesInterceptor` or other multer use exists in `api/`, so "not reachable" is true for multer.

### Answers to the planner's questions
1. **15.5 rather than 16.3:** agreed. 16 removes the synchronous request APIs, the user approved 14 → 15, and 15.5.27 is clean today. Pin the codemod's target, though (N1).
2. **Nest 10.4 with overrides, ignores only for unreachable advisories:** agreed. Two caveats:
   - not every `@nestjs/*` package is on 10.x: `@nestjs/typeorm` is 10.0.x and `@nestjs/schedule` is 4.x. "Latest 10.4.x" should read "latest within each package's current major";
   - the moderate `@nestjs/core` advisory stays (N3).
3. **Route table plus explicit fetch caching:** sound, but it doesn't show runtime caching of dynamic segments (S2).
   - `serverApi` already passes `next: { revalidate }` on every fetch (Phase 5, `server-api.ts:25-28`), so step 5's explicit-caching work is mostly a check.
4. **The Dependabot holds:** agreed in direction. Hold `eslint-config-next` with `next`, and keep React majors held (N2).

### Blockers
None.

### Should-fix
- **S1. Plan for the lint baseline: the `eslint-config-next` bump can fail the required `lint` check** at step 4 and acceptance (`eslint-config-next` matching `next`)
  - **11a's mechanism:** the `lint` check is required, compares the count with `.github/lint-baseline.json`, and is regenerated only "when a PR lowers it" (11a decision 4).
  - **The trigger:** going from `eslint-config-next` 14.2 to 15.5 brings newer `@next/eslint-plugin-next` and `eslint-plugin-react-hooks` rule sets. React 19's types can surface new hits too.
  - **What breaks:** if the bump adds even one warning, this PR's `lint` check is red and it can't merge. Nothing in the plan says what to do then.

  Suggested:
  - in step 4, run lint before and after the bump;
  - fix the new hits, or regenerate the baseline in this PR, listing the new warnings by rule in Progress;
  - if 11a's script calls `next lint` (deprecated in 15.5, removed in 16), switch it to the ESLint CLI here.

  Response: Fixed. Acceptance adds the `lint` criterion; decision 4 and step 4 run lint (and the baseline comparison) before and after the bump, then fix the new hits or regenerate the baseline in this PR, listing them by rule in Progress; `next lint` → `eslint .` if the script uses it. Decision 6 records the lint count before and after.
- **S2. The route table doesn't prove runtime caching for dynamic segments; check the headers too** at decision 3 ("The proof")
  - **What the table misses:** on Phase 5's `next start` build, `/educators/[id]` has `export const revalidate = 120`, yet answers `Cache-Control: private, no-store` on repeated requests. No `generateStaticParams`, so it's rendered per request, and the route table can't show that runtime behaviour.
  - **What breaks:** if Next 15 started ISR-caching such a segment, a `<WakingUp />` render (HTTP 200) would be cached for 120 s. Retry would then be served the cached waking page, breaking Phase 5's "recovers on Retry within about a minute".
  - **The same check applies to** `/courses/[id]` and 7b's `opengraph-image`s.

  Suggested:
  - in steps 2 and 8, against `next start`, record `Cache-Control` and `x-nextjs-cache` from two requests to each caching-sensitive route: `/`, `/courses`, `/courses/<id>`, `/educators`, `/educators/<id>`, `/verify/<uid>`, `/sitemap.xml` and an OG image;
  - require them to match;
  - Phase 5's cold-start specs then cover the waking path on top.

  Response: Fixed as suggested. Decision 3 adds the runtime proof: against `next start`, two requests each to `/`, `/courses`, `/courses/<id>`, `/educators`, `/educators/<id>`, `/verify/<uid>`, `/sitemap.xml` and one OG image, recording `Cache-Control` and `x-nextjs-cache`, before (step 2) and after (step 8). They must match. Acceptance, step 5, the Test plan and Risks say so. Step 5 also notes that `serverApi` already passes `next: { revalidate }`, so the fetch part is mostly a check.
- **S3. nodemailer 10 ships its own types, so drop `@types/nodemailer` rather than "match" it** at the API acceptance and step 3
  - **The registry:** `nodemailer@10.0.13` declares `"types": "./dist/cjs/nodemailer.d.ts"`, while `@types/nodemailer`'s latest is 8.0.2. "`@types/nodemailer` matches" can't be met as written.
  - **Why it matters:** keeping the DefinitelyTyped package misleads the next reader, and the built-in types may differ from it (`Transporter`, `SentMessageInfo`).
  - **Engines:** nodemailer 10 needs Node ≥ 20 (`engines`), which Render's and CI's Node 22 satisfies.

  Suggested:
  - remove `@types/nodemailer`;
  - fix `email.provider.ts` against nodemailer's own types;
  - reword the criterion.

  Response: Fixed. `@types/nodemailer` is removed and `email.provider.ts` is typed against nodemailer's own types (acceptance, decision 2, step 3). Decision 2 notes Node ≥ 20 (22 everywhere). Also folded in your answer-2 caveat: each `@nestjs/*` package goes to the latest within its own current major (typeorm 10.0.x, schedule 4.x).

### Nits (optional, max 3)
- **N1.** Pin the codemod's target: `npx @next/codemod@15 upgrade 15.5.27`, not a bare `upgrade` or `major`. The upgrade command resolves its target from npm, where `latest` is 16.3.8. 16 also removes `next lint` and renames middleware, so a stray 16 would show up as unrelated breakage.
- **N2.** In 11a's grouped `next-react` Dependabot group, hold `eslint-config-next >= 16` with `next >= 16`. Otherwise the group proposes a 16 config against a 15 `next`. Keep the `react`/`react-dom` (and `@types/react*`) major holds too: Next 15's peer range is React 18–19, so a future React major can't land before Next does.
- **N3.** List the moderate `@nestjs/core` advisory (fixed only in ≥ 11.1.18) in DEPLOYMENT's "Dependencies" next to P2-45, so the Nest-major follow-up carries a concrete reason.

  Nit responses: N1 taken (decision 4: `@next/codemod@15 upgrade 15.5.27`, the latest 15.5.x when the step runs). N2 taken (decision 5 and acceptance: `eslint-config-next` ≥ 16 held with `next`; React and `@types/react*` major holds kept). N3 taken (step 7: the moderate `@nestjs/core` advisory named under P2-45).

## Drift check 2026-10-07 (vs origin/main b4666f2) · Verdict: DRIFT: D1–D2
This is not a review round: the plan stays APPROVED. It's a read-only check against main as merged: 6b, 6d, 8a, 8b, 11a (#32) and Phase 10 (#37). It also rules on the 13 open Dependabot PRs.

I ran `pnpm audit --prod` on main's lockfiles and read the open Dependabot alerts and the PRs' CI logs. I also checked `npm view next@15.5.27` and `eslint-config-next@15.5.27`.

### Mismatches (fold in at the step named)
- **D1. The web audit can't be clean at `high` from the Next bump alone (step 4, acceptance "Audit").**
  - `next@15.5.27` is still the latest 15.5.x, and it is ≥ 15.5.24, the floor of today's two critical Next alerts. It still pins `"postcss": "8.4.31"` as a dependency.
  - Today's `pnpm -C web audit --prod` reports four highs, all on that copy:
    - postcss 8.4.31 (GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849; fixed ≥ 8.5.18);
    - its nanoid 3.3.16 (GHSA-2v37-7h3g-55p8, ≥ 3.3.18);
    - its source-map-js 1.2.1 (GHSA-68fv-2mgg-jv7q, ≥ 1.2.2).
  - GitHub opened these alerts today (#159–#162, #172), after this plan was approved. The root `postcss` 8.5.19 is a devDependency, so it doesn't count here.
  - **Scenario:** step 8 bumps to 15.5.27 and step 9 runs the audit, and it still fails at `high`. The plan's overrides are written for the API only, and decision 2 allows an ignore only when no fix exists within the major. Here a fix does exist.
  - **Fold in:** in step 4, add a `pnpm.overrides` block to `web/package.json` with `"next>postcss": "^8.5.28"`. Add `nanoid@3` and `source-map-js@1` entries too if the step 2 audit still names them. Take the versions from the audit, as decision 2 says. Then `pnpm -C web why postcss` shows only ≥ 8.5.23, and the gate's build and Playwright run prove Next works with it. The acceptance criterion's "patched transitive versions … forced with `pnpm.overrides`" then applies to web too.
- **D2. The Dependabot holds the plan assumes don't all exist, and unplanned majors fill the PR slots (decision 5, step 6).**
  - `.github/dependabot.yml` on main holds majors of `next`, `eslint-config-next`, `react`, `react-dom` and `eslint` (web), and `@nestjs/*` (api). There is no hold for `@types/react*`, which decision 5 says to "keep".
  - Nothing holds `typescript`, `vitest`, `framer-motion`, `@types/node`, `typeorm`, `express-rate-limit` or `http-proxy-middleware`. This week's version updates opened six unplanned majors: #33, #35, #40, #41, #42 and #44.
  - **Scenario:** on web, three of the five version-update slots are majors, and two of those three are red: #42 (TypeScript 6) and #35 (vitest 5). Every Monday, rejected majors crowd out the minor-and-patch group.
  - **Fold in (simplest):** in both npm entries, replace the per-package major holds with one rule: `- dependency-name: '*'` with `update-types: [version-update:semver-major]`. The comment should say majors are planned work, citing P2-44 (Next 16) and P2-45 (Nest). That one rule also covers decision 5's "`next` and `eslint-config-next` ≥ 16" and the React holds, so the per-package lines go. Security updates still arrive: #45–#47 are security updates and came through the existing `next` hold.

### Dependabot PRs (open on 2026-10-07)
| PR | Bumps | Ruling | Why |
|---|---|---|---|
| #33 | typeorm 0.3 → 1.1, pg 8.23 (api) | close | TypeORM 1.x is a non-goal. api, lint and docker builds are red. D2's hold stops it, and pg comes back via the group. |
| #35 | vitest 4 → 5, happy-dom (web testing) | close | An unplanned major, and web is red. happy-dom comes back in the group once D2 holds vitest. |
| #36 | jest 30.5, ts-jest 29.4.14 (api) | leave | Minor and patch, all green. Merge on green. |
| #38 | api minor-and-patch (turbo, class-validator 0.15, pdfkit 0.20, @types/pdfkit, aws-sdk) | leave | Green, including e2e. class-validator and pdfkit are 0.x "minors", so glance at a certificate PDF and a validation 400 before merging. |
| #39 | web minor-and-patch (react-query, hls.js, lucide, mammoth, testing-library, plugin-react, autoprefixer, postcss 8.5.28) | leave | Green. Supersedes #45. |
| #40 | framer-motion 12 → 14 (web) | close | An unplanned major, right after Phase 10's `LazyMotion strict` move. Decide it with Phase 12 (motion). |
| #41 | express-rate-limit 7 → 8 (api) | close | An unplanned major on the gateway's auth limiter, and no advisory needs it. A decision of its own. |
| #42 | typescript 5.9 → 6.0 (web) | close | An unplanned major; web, docker web, e2e and Vercel are red. |
| #43 | http-proxy-middleware 3 → 4 (api) | close | An unplanned major on the gateway proxy, which is 11b's ground. Revisit after 11b. |
| #44 | @types/node 20 → 26 (web) | close | The types should track the Node 22 runtime (`engines: 22.x`). D2's rule holds it. |
| #45 | postcss 8.5.19 → 8.5.23 (web, security) | close | Superseded by #39 (8.5.28). It doesn't touch Next's pinned 8.4.31 (D1). |
| #46 | vitest 4.1.11 (web, security) | leave | A patch. Its `docker-build (web)` failure is a `next/font` fetch error (`Cannot read properties of null (reading '1')`), not the change. Rerun and merge on green. |
| #47 | next 14.2.35 → 15.5.24 (web, security) | absorb | 11c's 15.5.27 is above the critical floor. Don't merge it: the build fails on sync `params` (`Type '{ params: { id: string } }' does not satisfy … 'PageProps'`), which is the codemod's job. Dependabot closes it once 11c's bump lands. |

#44 is a version update with no rule, so the config is missing an entry, not wrong (D2). #45–#47 carry Dependabot's security footer. They were opened at 09:51, after the five version-update slots per directory filled at 09:31–09:36, so they're security updates.

### New since approval, already covered by decision 2's procedure (no plan change)
- **proxy-addr 2.0.7 (api): critical**, GHSA-jqcg-44mw-7w3h (2026-10-05, IPv4-mapped IPv6 trust-subnet spoofing). It's fixed ≥ 2.0.8 inside the major, so it's an override.
  - Not reachable today: the gateway sets `trust proxy` to `1` (`gateway/src/main.ts:72`). Express compiles a number into a hop counter, with no subnet matching.
- **braces 3.0.3 (api): high, with no fixed version** (GHSA-vfj7-8cjw-p6xm). That's decision 2's "no fix within the major" path: an ignore with its reason if it's unreachable, otherwise back to the planner.
- **multer** now needs ≥ 2.3.0 and **nodemailer** ≥ 10.0.6, both within the planned targets. axios 1.2.1 is still there until 9c drops `chapa-nestjs`.

### Confirmed as the plan assumes (line drift only)
- web `lint` is already `eslint .` (11a), so the `next lint` switch in S1 is moot. Web runs ESLint 8.57 through FlatCompat, and `eslint-config-next@15.5.27`'s peer range includes ESLint 8. Next 15.5.27 accepts React `^18.2 || ^19`.
- **Caching exports:**
  - `(public)/page.tsx:15` (60);
  - `educators/page.tsx:23` (120);
  - `educators/[id]/page.tsx:37` (120);
  - `app/layout.tsx` no longer has one.
- **Server files that read request APIs** (the codemod's targets): `courses/page.tsx`, `courses/[id]/page.tsx`, `courses/[id]/opengraph-image.tsx`, `educators/[id]/page.tsx` and `verify/[uid]/page.tsx`.
- **Phase 10's additions:**
  - `/api/csp-report` is POST-only, so 15's GET-handler caching change doesn't touch it;
  - `headers()` and the `.mjs` imports in `next.config.mjs`, `next/font/google`, `LazyMotion strict` and the dev-only `'unsafe-eval'` (keyed on `NODE_ENV`) carry over unchanged;
  - the CSP fixture makes the Playwright run in step 9 a CSP check of the upgrade too.

### Nit (optional)
- **N1.** `web/next.config.mjs:19-20` keeps 7b's OG-font tracing under `experimental.outputFileTracingIncludes`. Next 15 moved that key to the top level, and as far as I know it maps the old key with a build warning. Move it in step 4, so the build log stays clean and Next 16 can't silently drop the OG fonts.

### Outside 11c (for the planner)
- `docker-build (web)` failed on #46 inside `next/font` (Phase 10's Google font download at build time), while the same job passed on #45 four seconds earlier. It looks like a flaky fetch. It isn't a required check (required: api, web, e2e, secret-scan, lint), but Vercel's build does the same fetch.

### Planner response to the drift check 2026-10-07 (ethio-planner [5b0124])
- D1, D2 and N1: taken (plan "Amendments 2026-10-07").
- Dependabot: I closed the 8 you listed. Instead of merging #36, #38, #39, #46 and #47 one by one, 11c absorbs them (one reviewed lockfile change, fewer commits, under the user's commit rule). Your pdfkit and class-validator check moves into 11c's gate.
- Order change: today's alerts move 11c ahead of 11b. It starts now from origin/main. The plan stays APPROVED; tell me if the order change raises a blocker.
- The `next/font` flake: folded in as "switch to `next/font/local` if it flakes during 11c".
