# 11c progress and deviations

Plan: [plan.md](plan.md). Rebuild 2026-10-18/19 (the 2026-10-07 worktree was lost; its numbers are in `snapshots/`, reference only).

## Commits
- Web minor/patch + `next>postcss` (#46, #50); Next 15.5.28 + React 19.3.1 + codemod (#47); tsconfig formatting; merge main (7c); api manifests, overrides, docs, lint baseline (#49); api lockfile alone; a11y networkidle cap; fonts to `next/font/local`.

## Results
- **Codemod:** `next-async-request-api` changed 4 pages (`courses`, `courses/[id]`, `educators/[id]`, `verify/[uid]`); `preset-19` changed nothing. Hand fixes: the course page test passes `Promise.resolve(params)`; `outputFileTracingIncludes` top level; tsconfig gains `target`.
- **Route table:** markers match the before snapshot. First Load JS `/` 128 → 138, `/courses` 128 → 138, `/courses/[id]` 124 → 134 kB (+7.8/7.8/8.1%). Build log clean.
- **Headers (cold, port 3011):** Cache-Control matches `snapshots/before/headers-cold.txt` except the bounded `stale-while-revalidate`; `/educators/<id>` waking render stays `private, no-store`.
- **Audits:** web clean at high (1 moderate, sprintf-js). api: axios only (chapa-nestjs, goes with 9c) + braces (ignored, CVE).
- **Gate:** web typecheck, vitest 743, build; api build, typecheck, jest 1417; lint-check (web 4, api 166); CI all green at b6ddbbe.
- **Review S1–S3 (2026-10-07):** `"agentGuidance": false` (no `api/AGENTS.md` after a build); dependabot/DEPLOYMENT wording; lint drop already on unchanged main (no-floating-promises 55 → 10, the rest are `main.ts` bootstraps; a cross-package probe is still reported), baseline updated.

## Deviations
1. `eslint.ignoreDuringBuilds`: Next 15.5's build lint rejects the ESLint 8 flat config; lint is its own required check.
2. braces ignored by `ignoreCves` (pnpm 9.4 ignores `ignoreGhsas`).
3. Bounded `stale-while-revalidate` on ISR pages (Next 15 `expireTime`). Side effect: on `next start`, Chrome revalidates a cached `/` prefetch in the background, Playwright never sees it finish, and a second visit's `networkidle` never comes (the 4 admin a11y timeouts). The scan's best-effort wait is capped at 5 s and logs when the cap fires. Vercel rewrites ISR headers to `public, max-age=0, must-revalidate` today; the post-merge curl confirms it on 15.
4. Fonts: `next/font/google` broke CI's e2e build once → `next/font/local` with Google's variable woff2s (Inter latin, Noto Sans Ethiopic + unicode-range). Inter's latin-ext glyphs fall back to system fonts.
5. `opengraph-image` keeps sync `params` (still sync in 15).
6. typeorm 0.3.31, cookie 0.7.2 bumped in range for a moderate/low.
7. Not done: the dev-only transitive refresh (outside `--prod`).
8. Production React is Next's vendored `19.2.0-canary-0bdb9206`; 19.3.1 serves vitest and types only.

## After 9c merges (2026-10-19, merge 53e9e92)
- [x] merged `origin/main` (dabba09); `courses/page.tsx` keeps the awaited `searchParams` plus 9c's page clamp; `api/pnpm-lock.yaml` regenerated with pnpm 9.4.0 from main's lock; `pnpm -C api why axios` empty
- [x] api audit at high: exit 0 (1 high = braces, ignored); build, typecheck, jest 1516 pass; lint-check green after `--update` (no-floating-promises 10 → 11: 9c's jobs-route `proxy(req, res, next)`, same call as the 2 beside it; no-explicit-any 131 → 130)
- [x] SMTP drill (nodemailer 10.1.7, own mailpit on 11025): the built `SmtpEmailProvider` delivered directly, and via the fallback port after ECONNREFUSED on the primary (Render's blocked-port path). The full sign-up flow wasn't run: another agent's backend held ports 4000-4107.
- [ ] CI green on #54
