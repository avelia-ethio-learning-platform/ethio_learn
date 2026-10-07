# Phase 10: Security headers, performance, SEO and Amharic for new learners

Status: approved (round 1, S1 and the nits folded in)
Size: M (sessions: 3 — ethio-impl implements, ethio-plan-review reviews plan and code). Web only.
Base branch: `origin/main` (amended 2026-10-03: runs in parallel with the backend stack 9a–9e and 11a; merge `origin/main` after 8b lands and before the gate). Earlier: the tip of the stack, expected `perf/read-paths` (9e). This phase builds on:
- Phase 5's `wake.ts` and ISR pages;
- 7a's metadata, icons, `MotionConfig` and i18n keys;
- 7b's `CourseCover`, per-course OG images and fonts in `web/src/assets/fonts/`;
- 8b's role pages;
- 9e's list shapes.

Feature branch: `feat/web-hardening`.
Roadmap: phase 10. Findings: P1-06, P1-53 (the rest after 7a), P1-55 (scoped by the user's English-first decision), P1-56, P2-26, P2-28, P2-34.

## Goal
- The web app sends the security headers a payments and accounts site needs, including a Content Security Policy that allows exactly what the app loads.
- First loads get lighter on the mobile connections the product targets: video and animation code load only when used, and fonts are self-hosted and subset.
- An Amharic-speaking new learner sees Amharic from the header through sign-up, the catalog, a course page, checkout and the dashboard, and is told plainly when a page is still English-only.

Acceptance criteria:
- **Headers (P1-06):** every response carries:
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: strict-origin-when-cross-origin`;
  - `X-Frame-Options: DENY`;
  - `Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=()`;
  - `Cross-Origin-Opener-Policy: same-origin-allow-popups`;
  - in production builds, `Strict-Transport-Security`.
- **CSP:**
  - built from the build's env;
  - enforced in development, CI and Playwright, where the suite fails on any CSP violation in the console;
  - in production, sent as `Content-Security-Policy-Report-Only` with reports collected, until the user flips `CSP_ENFORCE=true` once the post-deploy console checks are clean (Rollout);
  - every flow works under the enforced policy: Google sign-in, uploads, video playback, webcam proctoring (mediapipe wasm), PDF outline extraction, wake pings, Chapa redirect, the service worker.
- **Bundle (P1-56):**
  - `hls.js` is not in the first-load JS of the course page, the lesson player or the preview page; it loads when playback starts;
  - framer-motion in the shared shell drops to the `LazyMotion` core.
  - The `next build` first-load sizes for `/`, `/courses/[id]` and `/learn/[courseId]` are recorded before and after, and all three go down.
- **Fonts (P2-28):**
  - no request to `fonts.googleapis.com` or `fonts.gstatic.com`;
  - Inter and Noto Sans Ethiopic self-hosted through `next/font`, with only the weights the UI uses;
  - no render-blocking `@import`.
- **Images (P2-26):** every raw `<img>` has `width`, `height`, `decoding="async"` and `loading="lazy"`, except the home hero, which gets `fetchpriority="high"`. Decorative thumbnails get `alt=""`.
- **SEO (P1-53 rest):**
  - every indexable route has a canonical URL;
  - a production build fails if `NEXT_PUBLIC_SITE_URL` is missing, so canonicals, the sitemap and OG URLs never point at localhost.
- **Amharic (P1-55, English-first scope):**
  - in Amharic mode, every user-facing string is Amharic on: the header, footer, login, signup, reset-password, verify-email, the catalog, the course page (with its enroll panel and coupon, gift and sponsor forms), the payment return page, the dashboard, course cards, the waking-up states, and the 404 and error pages;
  - on every other page, Amharic mode shows a one-line notice that the page is in English for now;
  - new `am` strings are listed for the native speaker's review.
- **`<html lang>` (P2-34):** it matches the saved locale before first paint.

## Non-goals
- **A nonce- or hash-based strict CSP.** Static and ISR pages (Phase 5) can't carry per-request nonces. Decision 1 explains the `'unsafe-inline'` trade.
- **Proxying the API through the web origin** (P1-07, Phase 11). Phase 11 tightens `connect-src` to `'self'` when it lands.
- **Translating role pages,** the lesson player, account, notifications, messages, help and educators. They get the English-only notice. The same goes for API error messages, which stay English.
- **Server-side locale** (a cookie read in the root layout would make every page dynamic and undo Phase 5's ISR). Text flips after hydration, as the shell does today. `lang` is set before paint (decision 7).
- **Next.js 15** (Phase 11), image optimization through Vercel (decision 4), and removing framer-motion entirely.

## Current state
- **Headers** (`web/next.config.mjs:1-24`): `poweredByHeader: false`, an optional standalone output and the `/?q` redirect. No `headers()`. `vercel.json` only names the framework. Production has only Vercel's HSTS; the gateway already sends helmet's set.
- **What the app loads** (Phase 10 research; the CSP must allow each):
  - **Inline scripts:** the theme-init script (`layout.tsx:34`, from `lib/theme-script.ts:5`) and Next's own inline flight scripts on every page.
  - **Google Identity Services** (`GoogleSignInButton.tsx:9,33-39`): the script `accounts.google.com/gsi/client` and its iframe, style and fetches; profile images from `*.googleusercontent.com`.
  - **API:** `NEXT_PUBLIC_API_URL`, with `credentials: 'include'`.
  - **Wake pings** (`lib/wake.ts`): `NEXT_PUBLIC_WAKE_URLS`, `no-cors`.
  - **Uploads** (`lib/upload.ts:363-375`): presigned PUTs straight to R2 (`https://<account>.r2.cloudflarestorage.com`; MinIO `:9000` locally).
  - **Video:** hls.js loads signed R2 `.m3u8` and segments, with blob: workers and MSE blob: URLs. Safari plays the URL natively.
  - **Images:** thumbnails from `NEXT_PUBLIC_S3_PUBLIC_URL`; proctor previews may be `data:` (`lib/proctor.ts:184-185`).
  - **Proctoring:** mediapipe wasm and model self-hosted in `public/mediapipe/`, which needs `'wasm-unsafe-eval'`.
  - **pdf.js** worker at `public/pdf.worker.min.mjs`.
  - **Service worker** `public/sw.js` (`VERSION = 'el-sw-v1'`, `:14`).
  - **Chapa:** a top-level redirect only. No iframes.
  - framer-motion writes inline `style` attributes.
- **i18n** (`lib/i18n.tsx`):
  - client-only: starts `en`, reads `localStorage.el_locale` in an effect and sets `document.documentElement.lang` then (`:278-301`);
  - about 125 keys per locale, with a parity test (`i18n.test.ts:4-17`);
  - `t()` is used on the home page, the shell and parts of auth, the catalog, the dashboard and the enroll panel;
  - hardcoded English remains in: login (~6), signup (~11), reset (~3), verify-email (~5), the enroll panel's sub-forms (~11), payment return, the dashboard (~27), `CourseCard` (price label, category), the course page (a server component, no `useT`), `error.tsx`, `not-found.tsx` and the waking-up components.
  - 7a and 7b add keys for the chrome they touch, and 7b adds Amharic category labels.
- **Bundle:**
  - `hls.js` is imported statically at the top of `learn/[courseId]/page.tsx:6`, `CoursePreviewPlayer.tsx:5` and `(admin)/preview/[id]/page.tsx:6`;
  - framer-motion is in the root-layout chrome (`Header`, `Footer`, `ThemeToggle`, `LanguageToggle`, `NotificationBell`) and in `home-client`/`explore-client`, so it ships on every route;
  - pdf.js and mediapipe are already dynamic.
- **Images:** no `next/image` and no `images` config. Raw `<img>` at:
  - `CourseCard.tsx:42-46` (7b may replace it with `CourseCover` when there's no thumbnail);
  - `home-client.tsx:208` (hero, likely LCP);
  - `teach/courses/[id]/page.tsx:170`;
  - `preview/[id]/page.tsx:180`;
  - `exam/[assessmentId]/page.tsx:338`.
- **Fonts:**
  - `globals.css:1-3`: two `@import url(...)` lines (Inter 300–900 and Noto Sans Ethiopic 300–800, 13 weights);
  - `tailwind.config.ts:56-58` names both families;
  - `font-extrabold` (800) is used on headings across the app.
- **Metadata:**
  - `metadataBase` comes from `NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'` (`layout.tsx:10`, `lib/server-api.ts:58`);
  - canonicals exist on `/`, `/courses`, `/courses/[id]`, `/educators` and `/educators/[id]`; 7a adds login, signup and help.

## Design and key decisions
1. **One CSP builder, Report-Only in production until the user enforces it:**
   - `web/src/lib/csp.ts` exports `buildCsp(env)`, a pure function tested with vitest. `next.config.mjs` calls it in `headers()` for `/:path*`.
   - **Directives:**
     - `default-src 'self'`
     - `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client`
     - `style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style`
     - `img-src 'self' data: blob: <S3 public origin> https://*.googleusercontent.com`
     - `font-src 'self'`
     - `connect-src 'self' <API origin> <wake origins> <media origins> https://accounts.google.com/gsi/`
     - `media-src 'self' blob: <media origins>`
     - `worker-src 'self' blob:`
     - `frame-src https://accounts.google.com/gsi/`
     - `frame-ancestors 'none'`
     - `object-src 'none'`
     - `base-uri 'self'`
     - `form-action 'self'`
     - `manifest-src 'self'`
     - production adds `upgrade-insecure-requests`;
     - **`next dev` only** (`NODE_ENV === 'development'`) adds `'unsafe-eval'` to `script-src`, because webpack's eval dev builds and React Refresh need it. A vitest asserts it's absent from a production build's policy (plan-review S1).
   - **Origins** come from `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WAKE_URLS`, `NEXT_PUBLIC_S3_PUBLIC_URL` and a new `NEXT_PUBLIC_MEDIA_ORIGINS` (comma-separated R2 upload and stream origins, which aren't in the web env today). They are reduced to origins (scheme, host, port). Locally, `http://localhost:4000` and `http://localhost:9000` apply.
   - **Google** entries are present only when `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is set.
   - **Why `'unsafe-inline'` in `script-src`:** static and ISR pages can't carry a nonce, and Next's flight scripts change per build, so hashes don't work either. The policy still blocks every external script origin, plugins, `<base>` hijacks, framing (clickjacking on login, checkout, account deletion and QA approve), and exfiltration to unlisted hosts. Inline-injection defence stays with React's escaping and Phase 3's JSON-LD escaping.
   - **Report-Only, then enforce:**
     - `CSP_ENFORCE` (build-time) selects `Content-Security-Policy` or `Content-Security-Policy-Report-Only`. Its default is keyed on `VERCEL_ENV === 'production'`, never `NODE_ENV`, which `next build` always sets to production: Report-Only on Vercel production, enforced everywhere else, including CI's `next start`, so Playwright tests the enforced policy (plan-review N1).
     - `NEXT_PUBLIC_MEDIA_ORIGINS` and `CSP_ENFORCE` are added as build `ARG`s in `web/Dockerfile`, so the self-hosted image gets the same policy.
     - A route handler `app/api/csp-report/route.ts` accepts reports (body ≤ 8 KB, sampled to 1 in 10 after the first 100 per instance), logs them, and returns 204. The policy points `report-uri` at it (not `report-to`: with it, Chrome ignores `report-uri`; code review B1).
     - After the deploy, a console check of the production pages, then `CSP_ENFORCE=true`. Rollout gives the steps (Vercel Hobby keeps runtime logs for 1 hour, so a week of logs can't be reviewed; code review S1).
   - **The service worker** version moves to `el-sw-v2` so cached pages pick up the new headers.
2. **The other headers:**
   - `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: DENY` (alongside `frame-ancestors` for older browsers), `Permissions-Policy` and `Cross-Origin-Opener-Policy` go on every response, exactly as in the acceptance criteria.
   - `camera=(self)`, because proctoring uses the webcam.
   - `same-origin-allow-popups`, because Google sign-in can open a popup.
   - **HSTS:** `Strict-Transport-Security: max-age=63072000; includeSubDomains` only when `VERCEL_ENV === 'production'`. Vercel already sends a shorter one on `vercel.app`; no `preload` until the user has a custom domain.
3. **Bundle:**
   - **hls.js:** `const { default: Hls } = await import('hls.js')` inside each play handler or effect (the three players), then `Hls.isSupported()`. Safari's native path never loads it.
   - **framer-motion:**
     - `Providers` wraps the app in `<LazyMotion features={domAnimation} strict>`;
     - the shell components and `home-client`/`explore-client` use `m.*` instead of `motion.*`;
     - `strict` makes any leftover `motion.*` throw in development, so none slips through;
     - the header's nav underline uses `layoutId` (`Header.tsx:116`), which needs `domMax`, not `domAnimation`. The shell loads `domMax` lazily (`LazyMotion features={() => import('./motion-features').then(m => m.domMax)}`), so the underline still slides (plan-review N2);
     - 7a's `MotionConfig` stays.
   - **Measuring:** record `next build`'s first-load JS for `/`, `/courses/[id]` and `/learn/[courseId]` before and after, in Progress.
4. **Images, without the optimizer:**
   - Raw `<img>` keeps its `src`, and gains `width`/`height` matching its CSS box, `decoding="async"` and `loading="lazy"`.
   - **The hero:** `fetchpriority="high"`, no lazy.
   - **Card thumbnails** get `alt=""`, because the card's heading names the course.
   - **The editor and preview thumbnails** (`teach/courses/[id]/page.tsx:170`, `preview/[id]/page.tsx:180`) go through 7b's `hasRealThumbnail`, falling back to `CourseCover`, so the seed's `placehold.co` thumbnails never reach the CSP and `placehold.co` stays out of the policy (plan-review N3).
   - Rejected: `next/image`. On Vercel it routes every remote thumbnail through the image optimizer, which has a monthly quota on the free plan and would fetch from R2 on every miss. It also needs `remotePatterns` tied to env. The attributes give the layout stability and lazy loading that P2-26 asks for.
5. **Fonts:**
   - **`next/font/google` in `app/fonts.ts`:**
     - Inter: weights 400, 500, 600, 700, 800 (headings use 800), subset `latin`;
     - Noto Sans Ethiopic: 400, 600, 700, subset `ethiopic`;
     - both `display: 'swap'`, exposed as CSS variables.
   - `tailwind.config.ts` families use the variables, and the `@import` lines are deleted.
   - Light (300) and black (900) weights are dropped; the implementer greps `font-light`/`font-black` and swaps any use to the nearest kept weight.
   - 7b's TTFs in `web/src/assets/fonts/` stay for the OG images only.
6. **Amharic for the new-learner path:**
   - **Server components:** a small client `<T k="…" />` (and `useT` in client components) renders translated text. The course page, `CourseCard`, `error.tsx` and `not-found.tsx` render translatable text through `<T>`, so their server HTML is English and flips after hydration, as the shell does today.
   - **Pages translated:** exactly the acceptance list. Prices go through 7a's `formatETB` with the locale, and categories through 7b's labels with their `am` names.
   - **Untranslated pages:** a `LocaleNotice` in the root layout's client chrome compares `usePathname()` with a list of translated route prefixes in `lib/i18n-routes.ts`. In Amharic mode on any other route it shows one dismissible line, roughly "This page is in English for now" in Amharic. It is dismissed per session.
   - **Review:** every new or changed `am` value is drafted by the implementer and listed in `docs/i18n/am-review.md` (key, English, Amharic draft, page) for the native speaker. The parity test keeps both dictionaries complete.
   - Rejected: hiding the toggle on untranslated pages. Users would lose their place, and the notice is clearer.
7. **`lang` before paint (P2-34):** the inline theme-init script also reads `el_locale` and sets `document.documentElement.lang`. This is a few bytes in an inline script already allowed by `'unsafe-inline'`. It fixes screen readers' language on first paint. Text still flips after hydration (Non-goals).
8. **SEO:**
   - **Required site URL:** `next.config.mjs` throws during a build where `VERCEL_ENV === 'production'` and `NEXT_PUBLIC_SITE_URL` is unset, not an `https://` URL, or contains `REPLACE` (any case). (Amended 2026-10-03 by ethio-planner: production shipped with the placeholder `https://REPLACE.vercel.app` set, which an unset-only check would let through; see USER-ACTIONS item 9.)
   - **Canonicals:** `/verify` (the lookup form from Phase 5) gets a canonical, and every other indexable route is checked against the list in Current state.
   - **Sitemap:** `sitemap.ts` lists `/help`, `/educators` and `/verify` alongside courses and educator profiles.
   - A Playwright check asserts one canonical per indexable route.

## Steps
- [x] 1. Branch `feat/web-hardening` from the base above. Record `next build`'s first-load sizes for the three routes.
- [x] 2. CSP builder and headers (decisions 1, 2): `lib/csp.ts`, `next.config.mjs` `headers()`, the report route, `NEXT_PUBLIC_MEDIA_ORIGINS` in `web/.env.example`, the SW version bump.
  - vitest for `buildCsp`: origins reduced, Google present only with a client id, Report-Only versus enforce, no duplicate directives.
  - The report route: size cap and sampling.
- [x] 3. Playwright under the enforced CSP: a fixture fails a test on any `securitypolicyviolation` or console CSP error. Then run the whole suite.
  - New flow checks: Google button renders (skip when there's no client id in CI); an upload to local MinIO; a preview video plays; a proctored exam loads its wasm detector (or the spec asserts the detector-load path doesn't hit a CSP error); PDF outline extraction; a wake ping to a listed origin.
  - Fix any directive gaps in `buildCsp`, not with blanket wildcards.
- [x] 4. Bundle (decision 3): hls.js dynamic in the three players; `LazyMotion` plus `m.*` across the shell and the two marketing clients. vitest stays green, playback works in Playwright, and the first-load sizes are recorded after.
- [x] 5. Images and fonts (decisions 4, 5). Verify: no Google font requests in Playwright's network log; the `font-light`/`font-black` grep is empty or swapped; screenshots show no layout shift on the home hero and course cards.
- [x] 6. Amharic (decisions 6, 7):
  - `<T>`;
  - the listed pages;
  - `LocaleNotice` and `i18n-routes.ts`;
  - the theme-init `lang` line;
  - `docs/i18n/am-review.md`.

  vitest: parity; `LocaleNotice` shows on `/teach` in Amharic mode and not on `/courses`; `lang` is set by the init script. Playwright: in Amharic mode the signup page has no ASCII-letter text nodes except brand names, emails and placeholders listed in an allowlist.
- [x] 7. SEO (decision 8): the site-URL build guard, canonicals, sitemap entries, the canonical Playwright check.
- [x] 8. Screenshots: the new-learner path in Amharic at 375 and 1440, plus the English-only notice, into `screenshots/after-phase10/` (git-ignored).
- [x] 9. Full gate:
  - `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`;
  - the Playwright suite (enforced CSP), following Phase 5's build order;
  - `pnpm -C api test` untouched.
- [ ] 10. Code review by ethio-plan-review; the user approves push and PR.

## Test plan
- **vitest:** `buildCsp` (step 2), the report route (step 2), `LocaleNotice` and the init script (step 6), the i18n parity test.
- **Playwright:**
  - the whole suite under the enforced CSP, with a violation-fails fixture (step 3);
  - the new flow checks (step 3);
  - no Google font requests (step 5);
  - Amharic signup text (step 6);
  - canonicals (step 7).
- **Measurements:** first-load sizes before and after (steps 1, 4).

## Rollout and ops
- **Before deploy (the user, on Vercel):**
  - set `NEXT_PUBLIC_MEDIA_ORIGINS` to the R2 upload and stream origins (from the Render storage env), comma-separated;
  - **USER-ACTIONS item 9 done** (`NEXT_PUBLIC_SITE_URL` is the real `https://` site URL). This is a merge prerequisite: with the placeholder, the production build now fails on purpose;
  - leave `CSP_ENFORCE` unset, so production ships Report-Only.
- **After the deploy** (Vercel Hobby keeps runtime logs for 1 hour, so a week of logs can't be reviewed; code review S1):
  1. **A session, no credentials, read-only:** opens the public production pages in Playwright and lists any `[Report Only]` console messages: home, the catalog, a course page, playing a free preview, `/verify`, `/educators` and `/help`.
  2. **The user, once, about 10 min:** in Chrome on production, with DevTools → Console filtered on `Report Only`, walks the signed-in flows: Google sign-in, a thumbnail upload, a lesson video, a proctored exam's preflight and a PDF outline, and pastes back any messages.
  3. **If both are clean,** set `CSP_ENFORCE=true` and redeploy. If a real flow shows up, add its origin to `NEXT_PUBLIC_MEDIA_ORIGINS` or file a fix. The route stays, so real users' reports still show up when the logs are filtered on `csp-report` within the hour.
- **Native-speaker review:** `docs/i18n/am-review.md` lists every new Amharic string. Corrections are dictionary edits.
- **Installed PWAs** pick up the new service worker version on their next visit.

## Risks and open questions
- **`'unsafe-inline'` scripts** are a known weakness (decision 1). Phase 11's same-origin API proxy and a future move to dynamic rendering with nonces could tighten it. Not this phase.
- **Media origins** are env-driven. A wrong value breaks uploads or playback only when enforced, which is why production starts Report-Only and the Playwright suite enforces against local MinIO.
- **Amharic quality:** drafts by the implementer need the native speaker's pass before they're relied on. Until then the English-only notice sets expectations.
- **framer `strict` mode** throws on a stray `motion.*` in development. That's intended, but 7a's or 8b's components may still use `motion.*` outside the shell. The implementer converts any that render under `LazyMotion`.

## Progress and deviations (implementer)

Implementer: ethio-impl (3) [688c71], worktree `../ethi0-10`, branch `feat/web-hardening` from `origin/main` `03fd049` (handoff amendment).

**First-load JS** (`next build`, clean env):

| Route | Before (step 1) | After step 4 | Gate (after step 7 and 8b) |
|---|---|---|---|
| `/` | 150 kB | 126 kB | 128 kB |
| `/courses/[id]` | 277 kB | 121 kB | 124 kB |
| `/learn/[courseId]` | 297 kB | 141 kB | 142 kB |
| `/preview/[id]` (not on the list) | 287 kB | 130 kB | 132 kB |

Shared by all: 87.7 kB, then 87.8 kB at the gate. The Amharic dictionary is a separate 21.5 kB chunk, loaded only in Amharic mode.

- **Step 1** done: the baseline above.
- **Step 2** done (`b73dd93`): `src/lib/csp.mjs` (`buildCsp`, `cspEnforced`, `securityHeaders`), `next.config.mjs` `headers()`, `app/api/csp-report/route.ts`, `.env.example`, Dockerfile `ARG`s, `el-sw-v2`. vitest: 10 for the builder, 5 for the route.
- **Step 4** done (`82993f7`): `lib/video.ts` `attachVideo` loads hls.js on the first HLS playback, for all three players. `LazyMotion strict` in `Providers`, with `domMax` from `components/motion-features.ts` loaded lazily, and `m.*` in the six shell and marketing components. `Header.test.tsx` renders under `LazyMotion strict`, so a stray `motion.*` fails there.
- **Step 5** code done (`69e6858`): `app/fonts.ts`, variables on `<html>`, the tailwind families, the `@import`s gone, `font-light` changed to `font-normal` (the only use; no `font-black`). `<img>` attributes as decided. The Playwright checks run in the stack window with step 3.
- **Step 3** done: fixture `e2e/test.ts`, which every spec now imports; flow checks in `e2e/csp.spec.ts`. Playwright 2026-10-03 against the enforced policy: no violation anywhere in the suite. All six flow checks pass (Google skips without a client id, as planned). The step 5 font check passes too. Two fixes to the suite:
  - `lesson-player.spec.ts` focused Next, which is disabled when "Resume" opens a finished course's last lesson. It only failed when the seed had a sample video, so it isn't a regression. It now focuses the last enabled control after the video.
  - The draft-course payload in `csp.spec.ts` was missing `is_free_preview`.

  The a11y scans timed out at 30 s while other sessions' jest runs held the machine at load 16–24. Re-run with nothing else running, each took 7–11 s and passed.

- **Step 6** code done (`dbc410f`):
  - The dictionaries are split into `lib/i18n-en.ts` (inline) and `lib/i18n-am.ts` (loaded on first use).
  - Server components render `<T k>` and the `components/Localized.tsx` helpers (`PriceLabel`, `CategoryName`, `LocalDate`, `StatusName`). These are English in the server HTML and switch after hydration, as the plan's non-goal says.
  - `LocaleNotice` with `lib/i18n-routes.ts`, and the theme-init `lang` line.
  - 225 new keys, all listed in `docs/i18n/am-review.md`.
  - vitest: parity (keys, non-empty, placeholders), `LocaleNotice` (shows on `/teach` in Amharic mode; stays off `/courses` and English mode; dismissed per session), `isTranslatedRoute`, and the init script. Playwright: `e2e/i18n.spec.ts`, the Amharic signup page.
- **Step 7** code done (`84629fb`):
  - `lib/site-url.mjs` `assertSiteUrl`, called from `next.config.mjs`. With `VERCEL_ENV=production` and the `REPLACE` placeholder the config fails to load; with a real https URL it loads.
  - `/verify` already had its canonical (Phase 5). Every other indexable route was checked against Current state, and all have one.
  - `sitemap.ts` adds `/educators`, the top-24 educator profiles, `/help` and `/verify`.
  - The canonical check is in `titles-and-robots.spec.ts`.
- **origin/main merged** (`ab82bf4`, 8b): two import-line conflicts in `a11y.spec.ts` and `layout.spec.ts`. 8b added no `motion.*`. 11a hasn't merged, so there is no lint baseline yet.

- **Step 8** done: the new learner's path in Amharic at 375 and 1440 px, covering home, catalog, a paid course, signup, login and the dashboard, plus the English-only notice on `/help`. They're in `screenshots/after-phase10/` in this folder (git-ignored as `docs/plans/*/screenshots/`; a top-level `screenshots/` isn't ignored).
- **Step 9** gate on `ab82bf4` plus fixes, fresh `el_10_e2e` stack, clean-env build with the wake URL as in CI:
  - typecheck clean; vitest 82 files, 692 tests; `next build` ok;
  - Playwright 128 passed, 2 skipped (Google without a client id; `admin.spec` "Next shows the second page", which skips itself); no CSP violation;
  - `pnpm -C api test`: 67 suites, 1281 tests, 1 skipped (no api change in this phase);
  - no lint step yet (11a hasn't merged).

  The first gate run after the merge failed 4 tests, all fixed:
  - **8b's new axe check of the admin preview** loaded the seeded `placehold.co` thumbnail through the video `poster`. Fixed: the poster goes through `hasRealThumbnail`.
  - **The preview's "No thumbnail" fallback** failed contrast (`text-gray-500` on a gray tint). Step 5 made it show for seeded courses. Fixed: `text-gray-600`.
  - **8b's axe check of "the editor of a draft"** opened the CSP checks' own draft, which had a lesson. That lesson's upload button fails contrast at 90% opacity, which is 8b's. Fixed: the CSP checks now use the suite's shared draft (`ownCourseId`), and their own draft helper is gone. The button's contrast is now in Phase 7c's plan (sent to ethio-planner).
  - **The Amharic signup check** didn't allow for the footer's "Chapa" and "EthiopiaLearn ·". Fixed: brand names are removed before checking for Latin letters.

**Deviations:**
1. **`lib/csp.mjs`, not `lib/csp.ts`.** `next.config.mjs` imports the builder, and Next 14 can't load a TypeScript file from the config. JSDoc types; the vitest imports it from TS.
2. **Media origins default to the storage public origin when `NEXT_PUBLIC_MEDIA_ORIGINS` is unset.** Local and CI have no web env, and MinIO serves uploads, video and thumbnails from one origin. Production sets the variable (Rollout).
3. **`img-src` also allows the media origins.** The proctoring report's snapshots are signed storage URLs (`getSignedStreamUrl`), on the R2 S3 host rather than the public `r2.dev` URL. Without them, the educator's proctoring report would show broken images in production. Locally the hosts are the same, so only the vitest catches this.
4. **`frame-src 'none'` without a Google client id.** The app has no other frames.
5. **The editor and preview thumbnails keep their existing fallbacks** ("No thumbnail" in the preview, the upload icon in the editor) instead of `CourseCover`. Both go through `hasRealThumbnail`, so `placehold.co` stays out of the policy as N3 asks. `CourseCover` comes only in card and strip sizes, and neither fits the 96×56 editor box or the small aspect-video preview box.
6. **Noto Sans Ethiopic isn't preloaded** (`preload: false`). Preloaded, it put a 198 KB file on every page's critical path for an English-first site. The browser still fetches it as soon as a page shows Ethiopic text (`unicode-range`), as the `@import` did. Inter (48 KB) is still preloaded.
7. **The proctoring check serves the exam page a stub assessment list** (Playwright `route`): one proctored quiz in the learner's own course. The seed's only quiz is in a course the learner isn't enrolled in. The preflight screen reads nothing else, so the real detector (wasm and model) loads, and it loads with or without a camera. The seed, which other e2e scripts use, is unchanged.
8. **CI sets `NEXT_PUBLIC_WAKE_URLS=http://localhost:4101/health`** on the web build and Playwright steps, so the wake check runs on its own origin instead of always skipping. The Google check skips without a client id, as planned.
9. **The Amharic dictionary loads on first use** (a dynamic import in `lib/i18n.tsx`), so English readers don't download it. Until it arrives the page stays English, and text, prices and dates then switch together. The toggle's own vitest waits for it.
10. **Status badges are translated on every page**, not only on the learner path. It is one map (`status_*` keys), so the role pages' badges are Amharic in Amharic mode too, inside pages that otherwise show the English-only notice.
11. **Three lines lose a bold:** the discounted price in the coupon line, the amount in `invite_reward` (dashboard, "Get **50 ETB**…") and the range in `showing_range` (explore, "Showing **1–12** of N"). Amharic puts the parts in another order, so each sentence is one translated string with its values filled in.
12. **CSP reports go through `report-uri` only** (code review B1). With `report-to` in the policy, Chrome ignored `report-uri` and sent Reporting API batches, which never reached the route (measured: 0 of 20 logged). The `Reporting-Endpoints` header and the route's Reporting API branch are gone.

## In flight / next step (checkpoint 2026-10-03; updated 2026-10-07 by ethio-impl [5d9058])

- **2026-10-07:** round 1 (CHANGES REQUESTED) answered in one commit: B1 (report-uri only), S1 (the Rollout's console walk-through), N1 (ReviewPlayer's catch), N2 (deviation 11). Round 2 requested from ethio-plan-review [1a4214].
- **Round 2 APPROVED** (ethio-plan-review, 2026-10-07). The user set `NEXT_PUBLIC_MEDIA_ORIGINS` on Vercel Production.
- **Merged origin/main** (11a, `8c511b5`). One conflict, in `web/.env.example`; both blocks were kept. `docs/DEPLOYMENT.md` gained a "Content Security Policy (web)" section with the Rollout's three steps and a rollback, and the web row of its env table lists `NEXT_PUBLIC_MEDIA_ORIGINS` and `CSP_ENFORCE`. Gate after the merge: web typecheck clean, vitest 691, clean-env build OK (`/` 128 kB, shared 87.8 kB), api build, and `node scripts/lint-check.mjs` with no rule above its baseline.
- **Next:** push, open the PR, and merge (`gh pr merge N --merge`) once CI is green.

- **State:** steps 1–9 done, everything committed on `feat/web-hardening` (local, not pushed). The gate is green on this tip; see Step 9 above. The stack is released and nothing is running.
- **Step 10 in flight:** code review round 1 requested from ethio-plan-review [f903ba] on 2026-10-03 (branch, base `f8e70bc`, this plan, gate result).
- **Next:**
  1. Answer the review findings inline in `code-review.md`. Re-run the affected checks (claim the stack from the impl sessions for any Playwright run), commit, and send "Round N addressed".
  2. On APPROVED: merge origin/main again (re-gate if it moved), push `feat/web-hardening` and open the PR. Tell ethio-planner, because 7c starts from this tip.
  3. Merge (`gh pr merge N --merge`) only once CI is green and USER-ACTIONS has `NEXT_PUBLIC_MEDIA_ORIGINS` (Vercel Production) and item 9 (`NEXT_PUBLIC_SITE_URL`) done.
- **After that:** Phase 7c (color system), from docs/plans/2026-10-03-color-system/ in the main repo, on `feat/color-system`. It includes the `UploadVideoButton` contrast fix.
