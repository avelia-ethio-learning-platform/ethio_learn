# Plan review: Phase 7a, UI foundations and accessibility

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)"), against `fix/access-control` @ `3de83c3` (working tree, read-only): `globals.css`, root `layout.tsx`, `Header`, `Footer`, `RequireRole`, `ThemeProvider`, the editor's file inputs, the date and ETB sites, and the Phase 3 and Phase 5 plans. Contrast checked live on the running stack (`localhost:3000`) by computing each text node's colour against its composited background.

Checked and OK:
- **Contrast premise holds.** The page background resolves to white (the `body` rgba tint is overridden), so gray-500 is 4.76:1 in light. In dark it is about 6.9:1 on the body and 5.7:1 on cards. On home, catalog, a course page, login, signup, help, educators and reset-password, the only failures today are `text-gray-400`, `text-gray-300` and `badge-success`, which are exactly what decision 4 sweeps.
- **No `middleware`,** so the new icon, OG and manifest routes aren't intercepted. The root layout is the only layout, and it is a server component, so the 3-line server route layouts with `metadata` (decision 10) won't collide with any client layout.
- **Focus suppression:** only the two search inputs use `outline-none`, and decision 6 covers both.
- **File pickers:** all five hidden inputs sit inside their wrapping `<label>` and already have `disabled` for their busy states (`video-upload.tsx:324,394,471`, `structure-generator.tsx:286`). Making them `sr-only` doesn't let a keyboard user start a second upload.
- **Footer** is already a client component using `useT`, so the auth-aware columns are a local change.
- **Dark mode** is class-based and defaults to `system`, so the a11y spec can drive it with Playwright's `colorScheme: 'dark'`.
- **The roadmap split into 7a and 7b** is reasonable. 7a is still broad, but most of it is mechanical and verified by grep.

### Blockers
- **B1. The new standard error style itself fails contrast** at Decisions 1 and 4, and acceptance "Contrast"
  Scenario: a learner enters a wrong password on `/login`, and `FormStatus` renders the error as `badge-danger`. That is `#dc2626` on its own red tint (`globals.css:293-298`), which composites to about 4.2:1 for 12 px semibold text, below 4.5:1. So every announced error this phase introduces fails WCAG 1.4.3 in light mode.
  The inline error text that stays outside `FormStatus` has the same problem: the `Field` error, coupon errors and the role pages use `text-red-500` (63 uses), which is 3.76:1 on white. The axe gate never sees these, because none of the listed pages shows an error on load. So the acceptance criterion "no text below 4.5:1" fails without the gate noticing.
  Suggested fix:
  - In decision 4, add `.badge-danger` light text → `#b91c1c` (red-700, about 5.7:1 on its tint). Dark stays `#f87171`.
  - Give `Field`'s error a passing colour: `text-red-600 dark:text-red-400`. Red-600 is about 4.8:1 on white, and red-400 is about 6.4:1 on the dark background. Red-600 alone fails in dark, at about 3.6:1.
  - Add `text-red-500` on text to the step 4 sweep and its grep. Icons can stay.
  - In `a11y.spec.ts`, add one scan with an error visible: submit `/login` with a wrong password, then run axe. This puts error states under the gate.
  Response: **Fixed.** Decision 4 adds `.badge-danger` light text → `#b91c1c` (dark stays `#f87171`); `Field`'s error uses `text-red-600 dark:text-red-400`; `text-red-500` on text joins the step 4 sweep (→ `text-red-600 dark:text-red-400`, icons excepted) and its grep; the contrast criterion names the error styles; `a11y.spec.ts` adds a scan of `/login` after a wrong-password submit (step 10).

### Should-fix
- **S1. A single live region that switches role won't reliably announce** at Decision 1 (`FormStatus`)
  Scenario: the region mounts empty (as `role="status"`, or with no role). The first failed submit changes its role to `alert` and inserts the text in the same render. Screen readers track live regions they saw before the change, so NVDA and VoiceOver often say nothing. That misses the criterion "errors are announced".
  Suggested fix: two always-mounted, visually empty containers, one `role="status"` and one `role="alert"`. Set the text in the one that matches the tone and clear the other. Alternatively, keep only the status region persistent and mount a fresh `role="alert"` element for errors, which screen readers announce on insertion. Make the vitest assert that both regions exist before any status is set.
  Response: **Fixed.** Decision 1: `FormStatus` keeps two always-mounted, visually empty regions (`role="status"` and `role="alert"`), fills the one that matches the tone and clears the other. The step 2 vitest asserts both regions exist before any status is set.
- **S2. `RequireRole` reading the query string with `useSearchParams` breaks `next build`** at Decision 9 and step 8
  Scenario: `pathname + search` is built with `useSearchParams()` inside `RequireRole`. In Next 14.2, `missingSuspenseWithCSRBailout` is on by default, so every statically rendered page that uses it fails the build with "useSearchParams() should be wrapped in a suspense boundary". That is about 18 pages (dashboard, account, notifications, teach, institution, admin, qa…), and none has a `Suspense` boundary. Only login, reset-password, accept-invite and dev/checkout do.
  Suggested fix: the signed-out card only renders on the client, after `ready`. So build `next` from `usePathname()` plus `window.location.search` (or entirely from `window.location`) in that branch. Don't add `useSearchParams` to a component shared by 18 pages. The step 8 vitest stays as written.
  Response: **Fixed.** Decision 9 builds `next` in the signed-out branch from `usePathname()` plus `window.location.search` (that branch renders only on the client, after `ready`), and says explicitly not to use `useSearchParams` in `RequireRole`. Step 8 also checks that `next build` passes.
- **S3. The mechanical gray-300 → gray-500 swap fails on surfaces that are dark in both themes** at Decision 4
  Scenario: the lesson player's empty state, "Select a lesson to begin" (`learn/[courseId]/page.tsx:283`), is `text-gray-300` on the player's `bg-black` (`:256`). Swapped to gray-500, it becomes `#64748b` on black, about 4.4:1, which fails in light mode. Today it is about 2.0:1 in dark, because gray-300 inverts to `#334155`. The inverting gray scale is the wrong tool on fixed-dark surfaces. The lesson player is on the axe list.
  Suggested fix: add a rule to decision 4. On surfaces that stay dark in both themes (`bg-black`, `bg-black/50` video overlays), use a non-inverting light colour (`text-white/80`) instead of the gray scale. List such sites as documented exceptions in the step 4 grep.
  Response: **Fixed.** Decision 4 adds the rule: on surfaces that stay dark in both themes (`bg-black`, `bg-black/50` overlays, video players), use non-inverting `text-white/80` (or `text-white/70` for large text) instead of the gray scale. The step 4 grep lists these sites as documented exceptions, and the lesson player's empty state is named.

### Nits (optional)
- **N1. Role-home helper name.** Phase 3 shipped `roleHome()` in `web/src/lib/safe-next.ts` (logged as a Phase 3 deviation), while Phase 5's plan names `homeForRole`. Phrase decision 9 and step 8 as "the role-home helper (Phase 3's `roleHome`, or the name Phase 5 settles on)", so this phase doesn't add a third copy.
  Response: **Fixed.** Decision 9 and step 8 now say "the role-home helper (Phase 3's `roleHome`, or the name Phase 5 settles on)".
- **N2. Skip link details.**
  - Once the skip link moves focus to `<main tabIndex={-1}>`, Chrome matches `:focus-visible` on it, so the global outline draws a ring around the whole page. Add `focus:outline-none` on `main`.
  - The skip link sits in the server layout, outside `Providers`, so it can't call `useT()`. Either make it a small client component inside `Providers` with a `t()` key, as the non-goal on new chrome strings requires, or state that it stays English.
  Response: **Fixed.** `main` gets `focus:outline-none`; the skip link is a small client component rendered first inside `Providers`, with a `t('skip_to_content')` key in both dictionaries.
- **N3. Icons and OG.**
  - Once `app/icon.tsx` exists, Next's file-based icons override the layout's `icons: { icon: '/icon.svg' }`. Delete that field instead of leaving a dead entry.
  - The maskable 512 needs its own padded variant, a fourth `generateImageMetadata` id, because a maskable icon's safe zone is the inner 80%.
  - Course pages set their own `openGraph` and omit `images` when there is no thumbnail (`courses/[id]/page.tsx:44-49`). Have the metadata spec assert that `og:image` is present on such a course, to prove the site image is inherited there.
  Response: **Fixed, all three.** The `icons` field is deleted from the root metadata; `generateImageMetadata` gets a fourth, padded `maskable-512` id; the metadata spec asserts `og:image` on a course without a thumbnail. If Next doesn't inherit it there, the course page's `openGraph` falls back to the site image explicitly (7b replaces it with per-course images).

## Round 2 (2026-10-02) · Verdict: APPROVED
Reviewed: `plan.md` (status "in review (round 2)"); only the changed parts, against the round 1 findings.

Resolved:
- **B1:** decision 4 makes `.badge-danger` light `#b91c1c` and sweeps `text-red-500` text to `text-red-600 dark:text-red-400`. `Field` errors use the same pair. The contrast criterion names the error styles, the step 4 grep includes `text-red-500`, and the a11y spec scans `/login` after a wrong-password submit.
- **S1:** `FormStatus` keeps two always-mounted regions (`status` and `alert`), and the step 2 vitest asserts both exist before any status is set.
- **S2:** decision 9 builds `next` from `usePathname()` + `window.location.search` in the client-only signed-out branch, and explicitly bans `useSearchParams` there. Step 8 checks `next build`.
- **S3:** the fixed-dark rule (`text-white/80`, or `/70` for large text) is in decision 4, the lesson player's empty state is named, and these sites are documented grep exceptions.
- **N1–N3:** all taken. `SkipLink` sits first inside `Providers` (before `Header`), so it is still the first tab stop.

### Blockers
None.

### Should-fix
None.

## Drift check (2026-10-03, against origin/main 4b4a64c)
Not a review round: the plan stays APPROVED. A read-only check of the code this phase will be built on, after Phases 3–5 merged (`origin/main` 4b4a64c) and with 6a in flight (`fix/security-platform`). Subagents did the sweep; I verified every blocker against the code myself. The planner folds these into the plan before the handoff (or now, for a phase already in progress). Blocker here means the implementer would build something wrong or silently break a merged behaviour or test.

### Blocker
- **D1. Step 8/10 (the wrong-role card's new h1) breaks Phase 5's role specs.**
  - `web/e2e/roles.spec.ts:10` expects `/This area is for/` to be visible, so it fails.
  - `auth.setup.ts:11` and `roles.spec.ts:30` assert the same text is *absent*. Once it's gone they pass vacuously, and P0-11's "no wrong-role landing" guard is silently lost.
  - **Fix:** point all three assertions at the new h1 "This page isn't available for your account".

### Fixes
- **D2. The role-home helper is named.** There's no `homeForRole`. Phase 5 kept `roleHome()` and added `roleHomeLabel()` (`web/src/lib/safe-next.ts:1-17`, English strings) and `RoleHomeBackButton` (`components/BackButton.tsx:26-30`). `roles.spec.ts:19` clicks the button named "Institution dashboard".
  - Use `roleHome` + `roleHomeLabel` for the access-denied button and the footer home link.
  - If the labels move to `t()`, keep the English strings unchanged.
- **D3. Current state, Popovers.**
  - The burger already has `aria-expanded` (`Header.tsx:183-190`); only `aria-controls` is missing.
  - Phase 5 also added `aria-label="Main"` on the nav (:91), a backdrop with `data-testid="menu-backdrop"` that closes the menu on click (:73-89), and `data-testid="mobile-menu-panel"` (:205).
  - `useDismiss` must coexist with the backdrop's `onClick`.
- **D4. Steps 5–7: the hooks Phase 5 specs select by must stay.**
  - the nav name "Main" (`e2e/support.ts:87`);
  - the burger name "Menu" and both test ids (`layout.spec.ts:102-111`);
  - `input[name="email"|"password"|"name"]` (`support.ts:40-41`, `copy.spec.ts:14-16`), so `Field` call sites keep `name=`;
  - the footer link "Verify a certificate" (`verify.spec.ts:7`);
  - exactly one `role="status"` on the waking page (`cold-start.spec.ts:12,19`, strict locator), so no `FormStatus` region renders beside `<WakingUp>`.
- **D5. Step 10's a11y scan of `/login` after a wrong-password submit (light and dark) spends the auth-strict budget.**
  - Every `POST /auth/login` costs 1 of 10 per minute per IP (`rate-policy.ts:39-40,64`; fixed 60 s window, `main.ts:110`).
  - The suite already spends 7 (`playwright.config.ts:8-16`), and CI runs `e2e-smoke.mjs`'s 3 logins right after (`ci.yml:133-135`).
  - **Fix:** answer `**/api/v1/auth/login` with a 401 JSON through `page.route` (no spend), or count the calls and update the config comment.

Checked and still accurate (line shifts only): globals.css (no `color-scheme` or `:focus-visible`; `.input:focus`, badges, placeholder, reduced motion); the layout's theme-color, robots, icons, manifest and `<main>`; the hero motion; `whileTap`; ThemeToggle and NotificationBell (outside-click only); the Footer; `RequireRole`'s `/login`; `StatusBadge`; the hidden file inputs; `next.config.mjs`; the manifest and `sw.js`.
