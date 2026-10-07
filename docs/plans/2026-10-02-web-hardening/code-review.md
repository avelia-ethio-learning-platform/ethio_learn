# Phase 10 code review (ethio-plan-review)

## Round 1 (2026-10-07) · Verdict: CHANGES REQUESTED (one blocker, a small fix; one should-fix to the Rollout)
Requested 2026-10-03 by ethio-impl (3) [688c71]. Started on 2026-10-07 after the usage-limit pause. ethio-impl [5d9058] now owns the branch.

I reviewed `git diff f8e70bc...a02ca58` (86 files outside `docs/plans`, +2555/−693) against the plan, its 11 deviations and `plan-review.md`. The head is `ec5b9ae`, and `a02ca58..ec5b9ae` changes only `plan.md` (verified). origin/main is still `f8e70bc`.
- **Read myself:** `csp.mjs`, `next.config.mjs`, the report route, `site-url.mjs`, `i18n.tsx`, `Localized.tsx`, `LocaleNotice`, `i18n-routes.ts`, the theme script, `fonts.ts`, `Providers`/`motion-features`, `video.ts` and the three players, `sw.js` (its fetch handler only touches navigations, same-origin `/_next/static` and API reads, so cross-origin thumbnails never hit the worker's `connect-src`), the Dockerfile, `ci.yml`, the e2e fixture and `csp.spec.ts`, `i18n.spec.ts`, the canonicals check, and `sitemap.ts`.
- **An agent read the page conversions** and I checked its findings: dashboard, wallet card, enroll panel, course page, explore, home, the auth pages, payment return, error and 404, `CourseCard` and the shell components. It checked every `{placeholder}` against the vars its callers pass and every key against `i18n-en.ts`. It found no `motion.*` left under `LazyMotion strict`, no server component importing a client hook, and no lost branch, link, handler or aria attribute. English output is unchanged.

**Gate** (my detached worktree `../ethi0-10-review` at `a02ca58`, frozen installs, clean env):
- `pnpm typecheck && pnpm test && pnpm build`: typecheck clean, vitest 82 files and 692 tests pass, and `next build` succeeds. First-load sizes match the plan's Gate column: `/` 128 kB, `/courses/[id]` 124 kB, `/learn/[courseId]` 142 kB, `/preview/[id]` 132 kB, shared 87.8 kB.
- I didn't rerun Playwright, because the impl's step 9 run (128 passed, 2 skipped, no violation) is on the same code. I did run `next start` from my build, with Playwright's full Chromium, to test report delivery (B1).

### Blockers
- **B1. Chrome's reports never reach `/api/csp-report`.** The policy has both `report-uri` and `report-to`. When `report-to` is present, Chrome ignores `report-uri` and sends reports through the Reporting API instead (`Reporting-Endpoints`, `csp.mjs:99-100,115`).
  - **Measured** against `next start` on the review build, by injecting N `<img>` tags from an unlisted origin on `/`:
    - **As built:** the page fired the `securitypolicyviolation` events (N=2 and N=20). The route logged **0** reports, after 15 s with `--short-reporting-delay` and after 75 s without it, in both a fresh and a persistent profile.
    - **Same build, with `report-to` and `Reporting-Endpoints` removed from the response** (a Playwright `route` rewrite): the route logged **2 of 2** and **20 of 20**, one POST per report.
  - Even where the Reporting API does deliver (https in production), it sends reports in batches. Each entry carries the full `originalPolicy`, about 1–2 KB in production, so a batch of five or more goes over the route's 8 KB cap and is refused whole with 413. That is exactly the case where one missing origin breaks every thumbnail or video segment on a page.
  - **Scenario:** `NEXT_PUBLIC_MEDIA_ORIGINS` misses the stream host. Chrome users' violations never reach the logs, so the Report-Only period looks clean. The user sets `CSP_ENFORCE=true`, and playback breaks for Chrome users, who are most of the traffic. The acceptance criterion says "sent as Report-Only with reports collected", and for Chrome that isn't true.
  - **Fix (smallest):**
    - drop `report-to` and the `Reporting-Endpoints` header, and keep `report-uri`, which every browser sends, one report per POST;
    - `summarize()`'s `[{ type, body }]` branch and `REPORT_GROUP` can go too;
    - update the two vitest expectations (`csp.test.ts:85,127`) to assert both are absent.
  - **Recheck:** start `next start` from a build and load `/` in Playwright's Chromium. Run `document.body.append(Object.assign(document.createElement('img'), { src: 'https://blocked.example.org/x.png' }))` and expect one `csp-report {…"directive":"img-src"…}` line in the server log within a few seconds.

### Should-fix
- **S1. The Rollout's "review a week of CSP reports in Vercel's function logs" can't be done on the free plan.** Vercel Hobby keeps runtime logs for 1 hour ([docs](https://vercel.com/docs/logs/runtime): Hobby 1 hour, Pro 1 day). Each look at the logs covers only the last hour, so "a clean week" would really mean "nothing in the hour before I looked". That is the gap B1's scenario falls through.
  - **The simplest replacement,** with no new machinery, for the Rollout's "After a week" section and the matching USER-ACTIONS item:
    1. **After the deploy, a session (no credentials, read-only):** opens the public production pages in Playwright and lists any `[Report Only]` console messages: home, catalog, a course page, playing a free preview, `/verify`, `/educators` and `/help`.
    2. **The user, once, about 10 min:** in Chrome on production with DevTools → Console filtered on `Report Only`, walk the signed-in flows: Google sign-in, a thumbnail upload, a lesson video, a proctored exam's preflight, and a PDF outline. Paste back any messages.
    3. **If both are clean,** set `CSP_ENFORCE=true` and redeploy. The route stays, so real users' reports still show up if the user filters the logs on `csp-report` within the hour.

    Keep the 🟥 format for the user's step.

### Nits (optional)
- **N1.** `ReviewPlayer` (`preview/[id]/page.tsx:415`) calls `attachVideo(...).then(...)` with no `catch`. If the hls.js chunk fails to load (a flaky connection, or a deploy replaced the chunks mid-session), the reviewer gets a silent dead player and an unhandled rejection. A `.catch(() => setErr('Could not load the video player.'))`, or similar, matches the other two players, which already show an error.
- **N2.** Deviation 11's lost bold also applies to `invite_reward` (dashboard, "Get **50 ETB**…") and `showing_range` (explore, "Showing **1–12** of N"). That's fine; just name them in deviation 11.

### Checked, no finding
- **Headers:** match the acceptance criteria exactly. HSTS and `upgrade-insecure-requests` apply only on Vercel production. The enforce default is keyed on `VERCEL_ENV` (N1 of the plan review), and CI's `next start` is enforced (`csp.spec.ts` asserts it). Docker `ARG`s are in.
- **Origins:** reduced and de-duplicated. Google is listed only with a client id, and `frame-src 'none'` without one (deviation 4). No frames, `<object>`/`<embed>`, websockets or external form actions exist in `web/src`, so `frame-src`, `object-src`, `connect-src` and `form-action` hold.
- **Report route:** the cap reads the stream and cancels past 8 KB. Query strings are stripped, so signed URLs aren't logged, and sampling works per instance.
- **Site-URL guard:** production only; it throws when the value is unset, not https or contains REPLACE. USER-ACTIONS shows `NEXT_PUBLIC_SITE_URL` done (`https://ethio-learn.vercel.app`), so the guard won't block the merge.
- **i18n:** server HTML is English and switches after hydration (non-goal). The Amharic chunk loads on first use, and the locale stays `en` until it arrives (deviation 9). `<html suppressHydrationWarning>` covers the pre-paint `lang`, and `LocaleNotice` is dismissed per session.
- **Bundle:** `attachVideo` cleans up on a stale effect in `ReviewPlayer`. The lesson player destroys the previous instance before attaching. `LazyMotion strict` with lazy `domMax` keeps the underline slide.
- **Fonts:** `next/font` with only the weights in use. Ethiopic isn't preloaded (deviation 6, reasonable for English-first), and no `@import` is left.
- **SEO:** sitemap entries added. The canonical check walks every indexable route plus a course and an educator.
- **Merge prerequisites:** the Vercel `NEXT_PUBLIC_MEDIA_ORIGINS` 🟥 is still open in USER-ACTIONS ("Blocks Phase 10's merge").

### Round 1 response (impl, ethio-impl [5d9058], 2026-10-07)
- **B1: fixed.** The policy keeps `report-uri` only: `report-to`, `REPORT_GROUP` and the `Reporting-Endpoints` header are gone from `lib/csp.mjs`, and the route's Reporting API branch is gone from `summarize()` (it now reads one `{ "csp-report": … }` per POST). `csp.test.ts` asserts both are absent, and the route's "reads the Reporting API format too" test is removed. Logged as deviation 12.
  - **Your recheck, run:** a clean-env `next build` and `next start -p 3100`, then `/` in Playwright's Chromium with a blocked `<img>` injected. The response had no `report-to` and no `Reporting-Endpoints`, the page logged one violation, and the server logged `csp-report {"page":"http://localhost:3100/","directive":"img-src","blocked":"https://blocked.example.org/x.png","disposition":"enforce"}` (1 of 1).
- **S1: fixed as you proposed.** The Rollout's "After a week" is now "After the deploy": a session's read-only Playwright pass over the public pages, the user's one 10-minute signed-in console walk-through, then `CSP_ENFORCE=true` if both are clean. The acceptance criterion's wording, decision 1's two bullets and `web/.env.example` follow. ethio-planner reworded the USER-ACTIONS item. At merge time, after 11a's `docs/DEPLOYMENT.md` lands, I'll add a short CSP section there with the same three steps.
- **N1: taken.** `ReviewPlayer`'s `attachVideo` has a `.catch`. Unless the effect was cancelled, it resets the player and shows "Could not load the video player. Load it again."
- **N2: taken.** Deviation 11 names all three lines (the coupon price, `invite_reward` and `showing_range`).
- **Gate on this commit:** `pnpm typecheck` clean; `pnpm test` 82 files and 691 tests pass (692 − the removed Reporting API test); clean-env `pnpm build` OK, with first-load sizes unchanged (`/` 128 kB, `/courses/[id]` 124 kB, `/learn/[courseId]` 142 kB, `/preview/[id]` 132 kB, shared 87.8 kB). Playwright wasn't rerun: the only runtime changes are two response headers, the report route and the preview's error path.
