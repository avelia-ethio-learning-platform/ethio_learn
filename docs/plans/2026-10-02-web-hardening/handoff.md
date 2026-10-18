# Handoff: Phase 10, security headers, performance, SEO and Amharic for new learners

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 1, see [plan-review.md](plan-review.md))
Code review goes to: ethio-plan-review (size M)

## What to build
- A Content Security Policy from one pure builder, plus the other security headers on every web response.
  - The CSP is enforced in development, CI and Playwright, and is Report-Only on Vercel production until the user flips `CSP_ENFORCE`.
- A CSP report route.
- Lighter first loads: hls.js loads only when playback starts, framer-motion drops to `LazyMotion`, and fonts are self-hosted through `next/font`.
- Raw `<img>` tags get sizes, async decoding and lazy loading.
- Canonicals on every indexable route, and a production build that fails when `NEXT_PUBLIC_SITE_URL` is missing, isn't `https://`, or is a `REPLACE` placeholder (amended 2026-10-03: production had the placeholder set).
- Amharic on the new-learner path, an English-only notice on every other page, and `<html lang>` set before paint.

## Read first, in order
1. `plan.md` decisions 1–8, then `plan-review.md`:
   - round 1 S1: `'unsafe-eval'` only under `next dev`;
   - N1: the enforce default is keyed on `VERCEL_ENV`, and Dockerfile `ARG`s;
   - N2: the shell loads `domMax` lazily for the `layoutId` underline;
   - N3: the editor and preview `<img>` go through `hasRealThumbnail`.
2. `web/next.config.mjs`, `web/src/app/layout.tsx` and `web/src/lib/theme-script.ts`.
3. Everything the policy must allow (the plan's "What the app loads"):
   - `components/GoogleSignInButton.tsx`;
   - `lib/upload.ts`, `lib/wake.ts` and `lib/proctor.ts`;
   - `public/sw.js`.
4. The three hls.js players:
   - `learn/[courseId]/page.tsx`;
   - `CoursePreviewPlayer.tsx`;
   - `(admin)/preview/[id]/page.tsx`.

   Then the framer-motion shell: `Header`, `Footer`, `ThemeToggle`, `LanguageToggle`, `NotificationBell`, `home-client` and `explore-client`.
5. `web/src/lib/i18n.tsx` and `i18n.test.ts`, then the pages on the acceptance list: login, signup, reset, verify-email, catalog, course page and enroll panel, payment return, dashboard, `CourseCard`, waking-up states, `error.tsx`, `not-found.tsx`.
6. The Phase 5 handoff (`../2026-10-02-web-p0-fixes/handoff.md`) "Local workflow" section, for the build order and the Playwright setup.

## Decisions already made (don't relitigate)
- **CSP shape:** `'unsafe-inline'` in `script-src`, with no nonces or hashes. Static and ISR pages can't carry a nonce, and Next's flight scripts change per build. `'wasm-unsafe-eval'` is there for mediapipe.
  - `'unsafe-eval'` only when `NODE_ENV === 'development'`, and a vitest asserts it's absent from a production build's policy.
  - Directives exactly as decision 1 lists them. Fix gaps in `buildCsp`, never with blanket wildcards.
- **Origins** come from `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WAKE_URLS`, `NEXT_PUBLIC_S3_PUBLIC_URL` and the new `NEXT_PUBLIC_MEDIA_ORIGINS`, reduced to origins. Google entries appear only when `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is set.
- **Report-Only versus enforced:** the switch is `CSP_ENFORCE`, defaulting to Report-Only only when `VERCEL_ENV === 'production'`, never keyed on `NODE_ENV`. CI's `next start` is therefore enforced. `NEXT_PUBLIC_MEDIA_ORIGINS` and `CSP_ENFORCE` become build `ARG`s in `web/Dockerfile`.
- **Report route:** `app/api/csp-report/route.ts`, body ≤ 8 KB, sampled 1 in 10 after the first 100 per instance, returns 204.
- **HSTS** only when `VERCEL_ENV === 'production'`, with no `preload`.
- **Other headers:**
  - `camera=(self)` for proctoring;
  - COOP `same-origin-allow-popups` for Google sign-in;
  - `X-Frame-Options: DENY` alongside `frame-ancestors 'none'`.
- **Service worker:** the version moves to `el-sw-v2`.
- **No `next/image`:** the free plan's optimizer quota and R2 fetches on every miss. Raw `<img>` gets attributes instead. `placehold.co` never enters the policy.
- **Fonts:** `next/font/google` in `app/fonts.ts`. Inter 400–800 (`latin`) and Noto Sans Ethiopic 400/600/700 (`ethiopic`). Drop weights 300 and 900. 7b's TTFs stay for OG images only.
- **Amharic:** client-side only, with `<T>`/`useT`. There's no server-side locale, since a cookie in the root layout would make every page dynamic and undo Phase 5's ISR.
  - Untranslated routes get the `LocaleNotice`. The toggle isn't hidden.
  - Every new `am` string goes in `docs/i18n/am-review.md`.
- **Non-goals hold:** no API proxy (11b), no Next 15 (11c), and no translation of role pages, the player, account, notifications, messages, help or educators.

## Gotchas learned while planning
- **Playwright in a clean env:**
  - never run Playwright or `next start` from a shell that exported `api/.env.example`. Its `NODE_ENV=development` makes `next start` drop the ISR stale-page fallback, and with this phase it would also switch on `'unsafe-eval'`. Use `env -i HOME=$HOME PATH=<node22 bin>:/usr/bin:/bin ./node_modules/.bin/playwright test`, and source the e2e env only for the API scripts;
  - run one suite at a time, with a minute between full runs. The setup spends half of the gateway's auth-strict budget, so back-to-back runs fail at login.
- **Local build order** (Phase 5 S4): `next build` empties `.next` under the running :3000 server. Build, then restart `next start` by killing the `next-server` PID (never a `pkill -f` pattern that matches your own shell), then run Playwright.
- **The violation fixture** fails a test on any `securitypolicyviolation` or console CSP error. Expect it to surface gaps from 7a, 7b and 8b pages. Fix them in `buildCsp` or at the source.
- **framer `strict` mode** throws on a stray `motion.*` in development. Convert any component from 7a or 8b that renders under `LazyMotion`.
- **`metadataBase`** falls back to localhost today. The new build guard fires only when `VERCEL_ENV === 'production'`, so local and CI builds still work without `NEXT_PUBLIC_SITE_URL`.
- **The plan folder isn't security-sensitive.** Commit it on your branch, staging paths explicitly (several plan folders are untracked).
- **Environment:**
  - the node PATH export (`/home/kal/.local/opt/node22/bin`);
  - Postgres on 55432;
  - the pnpm `--store-dir /home/kal/snap/code/current/.local/share/pnpm/store/v3` flag;
  - e2e on `.env.example` values only;
  - production is off-limits.
- **Secrets:** the secret-guard hook scans untracked files for `api/.env` values. `web/.env.example` gets `NEXT_PUBLIC_MEDIA_ORIGINS` with an obviously fake origin, never a real R2 host.

## How to run
- **Web:** `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`.
- **Browser E2E:** follow the build order, then the clean-env Playwright command, with the stack up and web on :3000. The whole suite runs under the enforced CSP.
- **API untouched:** `pnpm -C api test` stays green.
- **Measurements:** `next build`'s first-load JS for `/`, `/courses/[id]` and `/learn/[courseId]`, before (step 1) and after (step 4), in Progress.
- **Screenshots:** the Amharic new-learner path and the English-only notice, at 375 and 1440, into `screenshots/after-phase10/` (git-ignored).

## Branch
Create `feat/web-hardening` from the tip of the stack when it starts (expected `perf/read-paths`, 9e). Don't push until everything below has merged; then `git merge origin/main`.

## Rollout notes for the PR description (the user does these)
- **Before deploy, on Vercel:**
  - set `NEXT_PUBLIC_MEDIA_ORIGINS` (the R2 upload and stream origins, comma-separated);
  - USER-ACTIONS item 9 done (`NEXT_PUBLIC_SITE_URL` is the real `https://` site URL). This is a merge prerequisite: with the placeholder, the production build fails on purpose;
  - leave `CSP_ENFORCE` unset, so production ships Report-Only.
- **After a week of clean reports** in Vercel's logs for `/api/csp-report`: set `CSP_ENFORCE=true` and redeploy.

## Definition of done
- The acceptance criteria are met.
- First-load sizes are recorded, and all three go down.
- The whole Playwright suite passes under the enforced CSP, with the new flow checks.
- typecheck, vitest and build pass.
- The checklist is ticked, with deviations logged.
- Then request code review from ethio-plan-review.

## Amendment 2026-10-03 (ethio-planner [aeff2b]): parallel track, overrides "Branch" above
- **Base:** create `feat/web-hardening` from `origin/main` now, in its own worktree `../ethi0-10`. It runs in parallel with the backend stack (9a–9e) and with 11a; 9a–9d don't touch `web/`, and 9e touches only a few list pages.
- **Merge `origin/main`** after 8b (#31 or so) lands, which brings the role pages that the framer `strict` and CSP checks cover, and again before the gate and before the PR. If 9e merges first, its list pages come in the same way; if not, 9e adapts to yours.
- **Push and PR** as soon as code review is APPROVED (standing authorization); no need to wait for the backend stack. The merge still waits for the user's `NEXT_PUBLIC_MEDIA_ORIGINS` on Vercel: when your CSP origins are final, send ethio-planner [aeff2b] the exact origin list the policy needs in production (hosts only, no secrets) so it can go into USER-ACTIONS.
- **Stack window:** one local stack for every track. vitest, typecheck and `next build` run any time; Playwright and the e2e scripts only in your window. Ask the holder (9a [572e5c] until about 22:30) and hand it on when done. Don't start `next dev`/`next start` on :3000 outside your window.
- **If 11a merges first:** add a short "Security headers and CSP" section to `docs/DEPLOYMENT.md`, and keep `pnpm -C web lint` at or under `.github/lint-baseline.json` (fix new warnings rather than raising the baseline).
