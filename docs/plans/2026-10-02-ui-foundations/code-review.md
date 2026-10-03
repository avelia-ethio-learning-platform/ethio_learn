# Code review: Phase 7a, UI foundations and accessibility

## Round 1 (2026-10-03) · Verdict: APPROVED (one should-fix to fix or defer before the PR)
Reviewed: `git diff c82d091...1389f2e` (`feat/ui-foundations`, 149 web files plus docs, no api change), against `plan.md` including its deviations log, the ledger rulings R1–R19, `final-review-report.md`, `final-fix-rereview.md` and `merge-main-report.md`.

Checks I ran, in my own detached worktree `../ethi0-7a-review` at `1389f2e` (yours untouched):
- `pnpm -C web typecheck` → clean.
- `pnpm -C web test` → 53 files, 473 tests pass.
- `pnpm -C web build` (clean env) → succeeds. The route list has `/apple-icon`, `/icon/[[...__metadata_id__]]`, `/manifest.webmanifest` and `/opengraph-image`.

Not run by me:
- Playwright, which needs a stack window from ethio-impl. Your clean-env run is 75/75 at `88c1cee`, and CI's `e2e` job runs it again on the PR.
- `pnpm -C api test`, because the branch changes no api file.

How I read it: I read the shared pieces myself:
- `Field`, `FormStatus`, `use-dismiss`, `format`, `labels`;
- `ThemeProvider`, `theme-script`, `SkipLink`, `Providers`;
- `Header`, `ThemeToggle`, `NotificationBell`, `RequireRole`, `Footer`;
- the root layout and CSS, the icon, OG and manifest routes, `next.config`, the route layouts and the new i18n keys;
- the three merge resolutions against 6a's versions (`c82d091`): password page, dashboard referral and wallet, coupon manager;
- the home hero's motion diff.

Two read-only subagents covered the rest, and I re-checked every claim they made against the code:
- the form pages' behaviour, file by file;
- the role-page sweeps, `format`/`labels` call sites, `sr-only` file inputs, and the Playwright specs.

I also sampled the screenshots `help-1440-dark` and `home-375-theme-menu-open-light`. The dark help hero now reads well, and the theme menu opens upward, fully on screen.

Verified as the plan says:
- **Primitives (decisions 1, 2, 3):**
  - `Field` wires `aria-describedby` only to the hint and error ids that actually render.
  - `FormStatus` keeps both regions always mounted, and `info` goes to the polite region in warn colours.
  - The `useFormStatus` callbacks are stable, so effect deps that list them don't re-run.
  - `formatDate` returns `''` on an invalid date. No `formatETB` call site can pass `undefined` (dashboard, analytics and admin use `?? 0`; the other sites pass required fields).
- **Overlays (decision 7):**
  - Escape acts only on the top of the open stack. The mobile menu's listener is registered first and sees the theme menu on top, so nested Escape closes only the theme menu.
  - The bell sits outside the mobile panel, so pressing it closes the menu as an outside press.
  - The focus trap keeps the bell out of reach while the menu is open, so the three never stay open together.
- **Gates:**
  - `RequireRole` reads `window.location.search` only in the client-only signed-out branch, with no `useSearchParams` (round-1 S2).
  - The wrong-role card has the h1 and a `roleHome` button.
  - The Footer waits for `ready`.
- **Metadata:**
  - Every `page.tsx` has a title, from its own metadata or a route layout.
  - Child `robots: { index: false }` replaces the root's `robots`, so each page has one robots meta.
  - The course page falls back to `/opengraph-image` explicitly.
  - The manifest's start URL is `/`, and the favicon rewrite targets `/icon/32`.
  - In production, `ImageResponse` serves the generated images with `public, immutable, max-age=31536000`, so the dynamic icon route doesn't render per visit.
- **Merge with 6a:**
  - The password page keeps 6a's `needsCurrent` / `serverWantsCurrent` logic, the fresh session from `setAuth` and the redirect.
  - The weak-password, mismatch and server-error paths are mutually exclusive.
  - The referral `invited: 0` sentence goes to `setInfo`, not success (R19).
  - The coupon manager keeps 6a's per-learner limit with `formatDate`/`formatETB`.
  - No Playwright spec used the old fixed field ids: `e2e/support.ts` and the specs select by `name`, and 6a's `scripts/e2e-security.mjs` runs against the API.

### Blockers
None.

### Should-fix
- **S1. A failed exam submit leaves its error on screen after a successful retry** at `web/src/app/(learn)/learn/[courseId]/exam/[assessmentId]/page.tsx:89-119` and `:446`.
  - Scenario: a learner submits, the request fails (network drop, a cold gateway), and the page shows "Try submitting again". The retry succeeds and the result card ("🎉 Passed", 80%) renders. The old error banner stays under it, in red with `role="alert"`, because `endExam` never clears the status. Only `start()` calls `clearStatus()`.
  - Why it's new: on `c82d091`, the error rendered only inside the no-result branch (`{error || 'Submitting…'}`), so a result replaced it. `FormStatus` is now mounted after `renderPhase()` in every phase.
  - Side effect of the same gap: during the retry, `status.tone` is still `'error'`, so the "Submitting…" line (`:298`) never shows. Only the disabled button signals progress.
  - A learner who sees "Passed" next to a red error may doubt the attempt was recorded, or ask for help.
  - Suggested: call `clearStatus()` in `endExam` right after the `endedRef` guard. Add a vitest: a first submit rejects, the retry resolves, and `role="alert"` is empty while the result shows.
  - Response: **fixed in `cf4ebc0`.**
    - `endExam` calls `clearStatus()` right after the `endedRef` guard. Its dependencies are now `[clearStatus, setError]`, both `useCallback` with `[]` in `useFormStatus`, so `endExam` stays stable and the timer and violation effects don't re-run.
    - The new `exam/[assessmentId]/page.test.tsx` failed before the fix: "Submitting…" never appeared on the retry, and the old alert stayed. It passes after. During the retry the alert regions are empty and "Submitting…" shows; after it, the result shows with no alert.
    - vitest passes 54 files / 474 tests, and typecheck is clean.

### Nits
- **N1.** `LearnerDashboard` calls `useT()` twice (`const { locale } = useT(); const { t } = useT();`, `dashboard/page.tsx:34-35`). One destructure is enough. **Taken in `cf4ebc0`.**

### Checked, not findings
- **The CORS preflight in the `/login after a wrong password` scan** (`a11y.spec.ts:119-129`): `'access-control-allow-headers': '*'` would not cover `content-type` on a credentialed request. But Playwright 1.63's Chromium network manager answers any intercepted preflight itself, echoing `Access-Control-Request-Headers`. The spec's OPTIONS branch never runs, which is why the scan passes. No change needed.
- **The reduced-motion spec samples opacity in the FCP observer callback**, slightly after paint. The server-HTML half is pinned by `home-client.test.tsx`'s `renderToString` check, which fails on any `opacity:0` around the nav or hero. Together they cover the criterion.
- **`CommentsSection`'s `FormStatus` inside a `justify-between` row** centres the message. No page renders that component (final review, declined #11).
