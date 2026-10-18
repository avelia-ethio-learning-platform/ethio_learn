# Plan review: Phase 10, security headers, performance, SEO and Amharic for new learners

## Round 1 (2026-10-03) · Verdict: APPROVED (one should-fix to fold in before handoff)
Reviewed: `plan.md` (status "in review (round 1)"), against the web code at `2cdccf9` and the 5, 7a, 7b and 8 plans it builds on.

Verified as the plan states:
- **Google sign-in:** the directives match what GIS needs: the script, the style, the `/gsi/` frame and connect, and the popup behind COOP `same-origin-allow-popups`.
- **Proctoring and wake pings:** `'wasm-unsafe-eval'` covers mediapipe. `connect-src` takes `NEXT_PUBLIC_WAKE_URLS`, which closes Phase 5 A1's note.
- **`Permissions-Policy`:** `microphone=()` is safe. The viva is typed text, and the proctoring camera asks for `audio: false` (`lib/proctor.ts:93-95`).
- **`lang` before paint:** the root `<html>` already has `suppressHydrationWarning` (`layout.tsx:31`), so setting `lang` before paint causes no hydration warning.
- **hls.js:** the three static imports are where the plan says (`learn/[courseId]/page.tsx:6`, `CoursePreviewPlayer.tsx:5`, `preview/[id]/page.tsx:6`).

### Blockers
None.

### Should-fix
- **S1. Development needs `'unsafe-eval'`, or the enforced dev CSP blocks `next dev`** at decision 1 ("enforced in development, CI and Playwright")
  Scenario: `next dev` runs webpack's eval-based dev builds and React Refresh, which need `eval`. `headers()` applies in dev too. With `script-src` lacking `'unsafe-eval'`, `pnpm -C web dev` serves pages that throw `EvalError` and never hydrate, for every developer and session working on the web. CI and Playwright use `next build` plus `next start`, so the suite wouldn't notice. Next's own CSP guide adds `'unsafe-eval'` in development for this reason.
  Suggested: `buildCsp` adds `'unsafe-eval'` only when `NODE_ENV === 'development'`. Add a vitest asserting it's absent from a production build's policy.
  Response: fixed. `buildCsp` adds `'unsafe-eval'` only when `NODE_ENV === 'development'`, and a vitest asserts it's absent in production (decision 1).

### Nits (optional, max 3)
- **N1.** Key "production" on `VERCEL_ENV === 'production'`, as HSTS does, not on `NODE_ENV`. `next build` always sets `NODE_ENV=production`, so a `NODE_ENV` switch would make CI's `next start` Report-Only. The fixture would still catch report-only violations, but "every flow works under the enforced policy" wouldn't be tested. Also add `NEXT_PUBLIC_MEDIA_ORIGINS` and `CSP_ENFORCE` as build `ARG`s in `web/Dockerfile` (`:9-19`), so the self-hosted image gets the same policy.
- **N2.** `Header.tsx:116` animates the nav underline with `layoutId`. Layout animations live in `domMax`, not `domAnimation`, so under `LazyMotion features={domAnimation}` the underline jumps instead of sliding, with no error. Load `domMax` (lazily) for the shell, or accept the jump and say so.
- **N3.** The seed's courses keep `placehold.co` thumbnails (7b A1). The raw `<img>` sites that don't go through 7b's `hasRealThumbnail`, the editor (`teach/courses/[id]/page.tsx:170`) and the preview (`preview/[id]/page.tsx:180`), will raise `img-src` violations in Playwright, where Phase 8's a11y spec opens both for seeded courses. Route those `<img>` through `hasRealThumbnail` rather than adding `placehold.co` to the production policy.

### Planner responses to the nits
- **N1:** taken. The enforce default is keyed on `VERCEL_ENV === 'production'`, so CI's `next start` is enforced. The new env vars are added as build `ARG`s in `web/Dockerfile`.
- **N2:** taken. The shell loads `domMax` lazily, so the `layoutId` underline still slides.
- **N3:** taken. The editor and preview `<img>` go through `hasRealThumbnail`, and `placehold.co` stays out of the policy.


## Amendment note (2026-10-03, decision 8 site-URL guard) · No objection, no new round
The extra condition (throw on a non-`https://` value or one containing `REPLACE`, any case) is the same check with one more clause. It closes the real gap: production's value is the placeholder. No new machinery.

One follow-on for the planner (should-fix, wording only):
- **The order of operations is now a hard prerequisite.** If Phase 10 merges before USER-ACTIONS item 9 is done, Vercel's production build on `main` fails on purpose, and web stops deploying (the previous deployment stays live). USER-ACTIONS item 9 says "Blocks: nothing merges on it", and Rollout says "confirm `NEXT_PUBLIC_SITE_URL` is set".
- Suggested: item 9 → "Blocks: Phase 10's merge". Rollout → "item 9 done (the real https URL, not the placeholder)". Then the merge-prerequisite check in the standing authorization catches it.
- Resolved 2026-10-03: item 9 now blocks Phase 10's merge; Rollout and handoff list it as a merge prerequisite.
