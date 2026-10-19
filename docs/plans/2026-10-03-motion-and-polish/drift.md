# Phase 12 drift check (2026-10-18)

**Verdict: READY WITH AMENDMENTS.** Checked against `origin/feat/color-system` `0d91583` (7c). Local `chore/deps-next15` has no commits past it yet. Paths are under `web/src/` unless noted. Every component the plan names exists. Nothing was renamed or removed.

## Amendments
1. **Base and browsers.** The base branch is `chore/deps-next15`, not `fix/deps-next15` (plan:5). 11c runs Playwright in chromium only (`web/playwright.config.ts:32-35`, 11c drift A5); webkit arrives with 11b (`fix/auth-transport`). Remove "chromium and webkit after 11c" from plan:19 and step 9. Keep S2's chromium skip.
2. **framer-motion stays `^12.42.2`.** Both 7c and 11c keep it (`web/package.json`). Dependabot #40 (12→14) was closed with "decide with Phase 12" (11c plan-review:96). Decision: stay on 12, because nothing needs 14. Log it in Progress. `LazyMotion strict` with lazy `domMax` (`components/Providers.tsx:39-45`, `motion-features.ts:4`) works on React 19 (11c drift:24). Use `m.*` only: `Header.test.tsx:24` renders under `strict`.
3. **`.progress-fill` has 7 sites, and they must change in the same commit as the CSS.** Otherwise a site still on `width` renders a full bar.
   - `app/(admin)/preview/[id]/page.tsx:735`
   - `app/(learn)/dashboard/page.tsx:109` and `:334`
   - `app/(learn)/learn/[courseId]/lesson-list.tsx:110` (a `span.block`)
   - `app/(learn)/learn/[courseId]/page.tsx:436`
   - `app/(teach)/institution/bulk-purchases.tsx:218` (a `span.block`)
   - `components/UploadProgress.tsx:65` (keep its `!bg-danger-solid`)

   Each `style={{ width }}` becomes `transform: scaleX(p/100)`.
4. **N2 is half done already.** `.progress-track` already has `overflow-hidden rounded-full` (`app/globals.css:407-409`). In `.progress-fill` (`:412-417`):
   - drop `rounded-full`;
   - add `w-full` and `transform-origin: left`;
   - change the transition to `transform`;
   - keep `background` in that rule, because `lib/color-tokens.test.ts:84` reads it.
5. **Token sites at 7c (re-find by code):**
   - easings: `globals.css:83-84`
   - `.card` transition: `:247`
   - `.card-hover`: `:250-257` (4 px lift)
   - `.btn`, `.btn-secondary`, `.btn-danger`: `:259-305`
   - `.pill` and `.pill-active`: `:366` and `:378` (`duration-200`)
   - reduce blocks: `:473-482` and `:523-527`
   - unused keyframes: `tailwind.config.ts:88-121` (0 uses, confirmed)
6. **`.animate-in` is missing from the plan** (`globals.css:506-509`: 0.5 s, 12 px, 60 ms stagger; the Home hero at `home-client.tsx:84`). Move it onto `--dur-slow`, `--rise` and `--stagger`. `e2e/reduced-motion.spec.ts` (opaque hero at FCP) must stay green.
7. **Counts:** `animate-fade-in-up` has 51 uses (the plan says ~45). There are 7 inline `animationDelay`s, and 3 are over 120 ms:
   - `(learn)/dashboard/page.tsx:180` and `:215`
   - `(teach)/teach/page.tsx:117`
8. **Shell lines:**
   - Header: the wiggle at `components/Header.tsx:139-140`, the underline at `:169`, the `height` menu at `:233-236`.
   - Bell: `NotificationBell.tsx:87-90`. Theme menu: `ThemeToggle.tsx:55-58`.
   - Not in the plan: both triggers have `transition hover:scale-105` (`NotificationBell.tsx:65`, `ThemeToggle.tsx:44`). Treat them like the footer (`Footer.tsx:128`): a colour change only, with a `duration-fast` token.
9. **Explore:**
   - enters: `(public)/courses/explore-client.tsx:130` and `:145`
   - keyed grid with `pointer-events-none opacity-50`: `:293-299`
   - a literal `duration-300`: `:123`
   - Pager `disabled={isPending}` (`:312`, `:328`, `:336`) is tied to the request, not to an animation, so it stays.
10. **Verify page:** the card at `(verify)/verify/[uid]/page.tsx:33` has `animate-fade-in-up` today. Remove it, because the card is the LCP element (decision 7). Wipe the band (`:34`) only when it is `gradient-ethiopia` (a valid certificate).
11. **`MobileBuyBar` has no request or busy state.** It only scrolls to `#buy-box` (`components/MobileBuyBar.tsx:16`, `courses/[id]/page.tsx:242`). Remove "MobileBuyBar gets the same state" (plan:98).
12. **`EmptyRows` is `{ label, happy }`** (`components/EmptyRows.tsx:4`). Add `icon` and `action` alongside `happy`.
13. **Celebration colours clash with 7c.** The flag is for structure only (`docs/COLOR_SYSTEM.md:112-123`), and `lib/no-raw-colors.test.ts` rejects hex in `.tsx`. See cut 14a.

## Over-engineering to cut
14. Cut these:
    - a. The 8-dot flag burst and its `sessionStorage` (decision 7, N3). Instead, `completion-card` (`completion-card.tsx:43-54`) gets `.fade-in` plus a single `--dur-base` scale on the Award icon, and no storage.
    - b. The admin tab `layoutId` indicator (step 8). The tabs are `.pill`/`.pill-active` swaps (`(admin)/admin/page.tsx:82-96`), so a colour transition is enough. That avoids adding new motion to a dashboard.
    - c. The `lib/motion.ts` vitest (step 2). It only asserts that constants equal constants.
    - d. The payment-return SVG check-draw (decision 7). The crossfade plus focus on "Start learning" is enough.
15. **Next 15 / React 19:** no other impact. `template.tsx` and `loading.tsx` work the same, and the route table still prints First Load JS. 11c's after-numbers will be in `docs/plans/2026-10-03-deps-next15/snapshots/after/`.
