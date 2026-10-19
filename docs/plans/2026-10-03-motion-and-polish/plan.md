# Phase 12: Motion and UI polish

Status: approved (round 1); S1–S2 and N1–N3 folded in. Drift check 2026-10-18 ([drift.md](drift.md)) amends it; its amendments bind. 12a in progress.
Size: two parts, 12a and 12b, each M (sessions: 3 — ethio-impl, or the planner in the `../ethi0-web` worktree, implements; ethio-plan-review reviews plan and code). Web only: no API, no migration, no env change.
Base branch: the stack tip after 11c (`chore/deps-next15`'s tip, or `origin/main` once 11c has merged). The user chose this order on 2026-10-03: Phase 10 sets the `LazyMotion` imports and the CSP, and 11c moves to Next 15 / React 19, so neither is redone here. · Feature branches: `feat/motion-polish-a` (12a), then `feat/motion-polish-b` (12b) from 12a's tip, or from `origin/main` once 12a has merged.
Brief: [brief.md](brief.md) (the user's request and the constraints already decided). Inventory: facts below were taken at `origin/main` `ff1d89e`; Phases 8–11 change some of these files first, so re-find each site by its code.

## Goal
The site should feel finished: every interaction answers at once, things appear calmly in a consistent way, loading and empty states look intentional, and nothing moves without a reason. This applies the approved "calmer motion" direction. "Pro" means consistent and purposeful, not more movement. Motion must not cost first load, battery or layout stability on the slow phones most learners use, and it switches off for people who ask for reduced motion.

Acceptance criteria:
- **One motion system.** All durations and easings come from the tokens in decision 1. In the files each part touches there are no literal durations: `git grep -nE 'duration-[0-9\[]|[0-9.]+m?s( |;|,)' -- <touched files>` finds nothing outside `globals.css`'s token block, and a bare `transition` class gets `duration-fast` or `duration-base` (review N1). Framer presets come from `lib/motion.ts`. Home and Explore no longer define their own variants.
- **Only `transform` and `opacity` animate**, plus `background-color`/`color`/`border-color`/`box-shadow` on hover and focus. No `height`, `width` or `top` animation, except the `grid-template-rows` disclosure pattern the help FAQ already uses.
- **Size:** `next build` First Load JS for `/`, `/courses` and `/courses/[id]` is at most 5 kB above the numbers Phase 11c records in its after-snapshot (Phase 10's baseline, carried through 11c). Recorded before and after in Progress.
- **Layout stability:** a new Playwright check measures cumulative layout shift on `/`, `/courses` and a seeded course page at 375 and 1440 px: CLS ≤ 0.05 on each.
- **Lighthouse mobile performance** on `/` and a course page doesn't drop by more than 3 points against the before run (one manual run each, recorded in Progress; decision 9).
- **Reduced motion:** a `reduced-motion` Playwright project runs the key-flow specs (decision 8) with `reducedMotion: 'reduce'`. They pass, and under it no element is clickable only after an animation, and nothing transforms.
- **Nothing waits on an animation:** no button, link or input has `pointer-events: none`, `disabled` or `inert` tied to an animation's state. A click during an enter animation works.
- **The existing suites stay green:** vitest, Playwright (Phases 5, 7a, 7b, 8, 10 and 11c specs, chromium; webkit arrives with 11b, drift A1), axe at zero serious or critical, and Phase 10's enforced-CSP fixture with no new violations.
- **UX audit:** the `web-design-guidelines` review of each route group has its real findings fixed or listed in Deviations with a reason (decision 10).
- **Before and after:** screenshots at 375 and 1440 px (light; dark for Home, the course page and the learner page), plus a short screen recording of the motion surfaces, in `docs/plans/2026-10-02-refinement-audit/screenshots/after-phase12/` (git-ignored). The user sees 12a's before/after before 12b starts.

## Split
- **12a: the motion system, shared primitives, the shell, Home and Explore** (`feat/motion-polish-a`): steps 2–6 and the 12a parts of steps 9–11.
  - **Acceptance:** the motion-system, size, CLS, reduced-motion and nothing-waits criteria on `/` and `/courses`; the shell and shared primitives (decisions 3 and 4); Home and Explore (decision 5); the audit of the `(public)` group's Home and Explore pages and the shell.
  - Then the user sees a before/after (screenshots plus a recording at 375 and 1440 px) as an artifact. 12b starts after that, folding in any change the user asks for.
- **12b: the course page, checkout, the learner path, certificates and dashboards** (`feat/motion-polish-b`): steps 7–8 and the 12b parts of steps 9–11.
  - **Acceptance:** the rest of the criteria, over every remaining surface.

## Non-goals
- **A toast system.** Phase 8 decision 2 rejected it (auto-dismiss timing is a WCAG 2.2.1 problem); outcomes stay in 7a's `FormStatus`. This phase only gives `FormStatus` its enter transition.
- **A second animation library** (GSAP, Lenis, Lottie, a confetti package). Every surface below is done with CSS or the framer-motion already installed.
- **Route exit transitions** or Next's experimental view transitions. Route changes get an enter fade only, and only where it doesn't touch first-load LCP (decision 6).
- **Layout redesigns.** The approved visual direction and the page layouts stay. This phase changes motion, states and the audit's real findings.
- **Number count-ups and animated chart drawing** on dashboards. They add movement and help no one read a number.
- **Smooth-scroll libraries and scroll-jacking.** Native `scroll-behavior` stays as it is.
- **Translating more strings into Amharic.** The audit checks that Amharic text fits; it doesn't add translations.
- **A bundle-size CI gate or Lighthouse CI.** Sizes and Lighthouse are recorded manually, as Phases 10 and 11c do. The CLS check is the one new automated gate, because it's cheap and catches the regression motion work actually causes.

## Current state (at `origin/main` `ff1d89e`; Phases 8–11 change some of this first)
- **framer-motion** `^12.42.2`, 39 `<motion.*>` elements in 6 files, all `motion.*`:
  - Header: the mobile-menu backdrop and panel (opacity, `height` 0→auto, y −8), a logo hover wiggle (rotate), and the nav underline with `layoutId="nav-underline"`;
  - NotificationBell: the badge scale, the panel (opacity, scale .95, y −8, 0.15 s);
  - ThemeToggle: the dropdown (opacity, scale .92, y ±8, 0.15 s); Footer: back-to-top hover scale;
  - `explore-client.tsx`: heading and filters enter (y 24/20, 0.6 s), and the results grid keyed on filters/page/sort, so it re-animates (y 12, 0.4 s) on every change, while pending sits at `opacity-50` with `pointer-events-none`;
  - `home-client.tsx`: 26 elements; local `fadeUp` (y 30, 0.6 s, expo) and `stagger` (0.12 s) variants; `whileInView` once reveals on every section; the hero uses the CSS `.animate-in` so it's opaque at first paint (P1-57).
  - `MotionConfig reducedMotion="user"` in `Providers.tsx`.
  - Phase 10 wraps the app in `LazyMotion strict` with lazy `domMax` (the header `layoutId`) and moves the shell and Home/Explore to `m.*`.
- **CSS:** Tailwind adds the easings `out-quart` and `out-expo` but no durations. Keyframes `fade-in-up` (0.6 s, y 14), `fade-in`, plus four unused ones (`float`, `shimmer`, `spin-slow`, `pulse-soft`). `animate-fade-in-up` is used in about 45 places, including every `PageHeader`, card and section on role pages, some with inline `animationDelay`. `.card-hover` lifts 4 px, `.btn` and `.pill` lift 1 px on hover. `.skeleton` has a shimmer. `globals.css` already has a `prefers-reduced-motion` block (durations to .01 ms, `.animate-in` and the shimmer off).
- **Routes:** groups `(public)`, `(learn)`, `(teach)`, `(admin)`, `(account)`, `(verify)`. No `template.tsx`. `loading.tsx` exists only for the course page and the learner page. One root `error.tsx`.
- **Shared UI:** no toast, modal, drawer or tabs component today. Phase 8 adds the native `<dialog>` `ConfirmProvider`, ARIA admin tabs, `SearchPicker`, `Pager`, `EmptyRows` and the rewritten `Bars`. Accordions: the help FAQ (CSS `grid-rows`), `ExpandableSummary` (line-clamp), and the lesson list's mobile "All lessons" toggle (no animation).
- **Surfaces:**
  - the enrol panel swaps the icon for a spinner and "Please wait…", and is `disabled` while busy;
  - `/payment/return` polls (2.5 s × 12) through polling, active, failed and timeout, swapping icons with no transition;
  - the lesson list swaps Play for CheckCircle2 on completion with no transition, and `.progress-fill` animates `width` 0.5 s;
  - `completion-card.tsx` returns null until the certificate exists, then appears with no moment;
  - `/verify/[uid]` is a server-rendered card with `animate-fade-in-up` and the flag band.
- **Playwright:** one `chromium` project plus `setup` (11c adds webkit). `reduced-motion.spec.ts` sets `reducedMotion: 'reduce'` for one hero test. `a11y.spec.ts`'s `revealAll` polls inline `opacity` until framer reveals finish. No CLS, size or Lighthouse measurement exists anywhere. Phase 10 adds the CSP fixture.
- **Skills:** `frontend-design`, `web-design-guidelines`, `react-best-practices`, `composition-patterns` and `playwright-expert` are installed.

## Design and key decisions
1. **Motion tokens: three durations, two easings, one stagger, one distance.**
   - `globals.css` `:root`: `--dur-fast: 120ms` (press, hover, focus, small popovers), `--dur-base: 200ms` (enters, exits, crossfades, the dialog), `--dur-slow: 320ms` (the few page-level reveals and the one celebration step). The existing `--ease-out-quart` (UI feedback) and `--ease-out-expo` (enters) stay; there's no third easing. `--stagger: 40ms`. `--rise: 8px` is the only enter distance.
   - Tailwind `theme.extend.transitionDuration` maps `fast`, `base` and `slow` to the variables, so classes read `duration-fast` and similar.
   - `web/src/lib/motion.ts` holds the framer side, read from the same numbers: `dur` (in seconds), `ease`, and three presets: `fadeIn`, `rise` (opacity plus y `--rise`) and `listStagger`. `inView` is `{ once: true, margin: '-60px' }`. That's the whole file. Home and Explore import from it; their local variants go.
   - **Calmer than today:** enters drop from 0.6 s and 14–30 px to 200–320 ms and 8 px, stagger drops from 120 ms to 40 ms, and hover lifts become a shadow and border change with at most a 2 px lift (`.card-hover` from 4 px).
   - **Why tokens in CSS variables and Tailwind both:** CSS does most of the work (decision 2), and one source of numbers keeps CSS and framer in step. No design-token package.
2. **CSS first; framer only for what CSS can't do.**
   - **CSS:** hover, press (`active:scale-[.98]` on buttons, 120 ms), focus rings, skeleton shimmer, the content crossfade (decision 4), the dialog open, the route enter (decision 6), disclosures (`grid-template-rows` 0fr→1fr, like the help FAQ), the lesson check, the progress bar (`transform: scaleX` instead of `width`), and the course-complete moment.
   - **framer (`m.*` under Phase 10's `LazyMotion`):** exits through `AnimatePresence` (the mobile menu, the bell panel, the theme menu), `layoutId` for the header underline and the admin tab indicator, list stagger and `whileInView` reveals on Home, and the Explore grid crossfade.
   - **Mobile menu:** its panel stops animating `height: auto` (layout work on every frame). It becomes opacity plus y `--rise` on a panel that is already its full height. That also fixes the CLS-like jump under it.
   - **Rejected:** moving everything to framer (bigger first load, and CSS is cheaper on slow phones), and dropping framer (exits and shared layout would need hand-written state machines).
3. **The shell (12a):**
   - Header: the nav underline keeps `layoutId`, at `--dur-base` with `out-quart`; the logo wiggle goes (decorative). The mobile menu as in decision 2.
   - Bell, theme menu and Phase 8's dialog share one popover feel: opacity plus scale .98 to 1 over `--dur-fast`, origin at the trigger. Exits are faster than enters.
   - The `ConfirmProvider` dialog: `dialog[open]` gets a CSS fade and 8 px rise over `--dur-base`, and `::backdrop` fades. No exit animation, because a native `<dialog>` closes at once and faking an exit means delaying `close()`, which focus return and the tests rely on.
   - Footer: back-to-top loses its hover scale; it keeps a colour change.
4. **Shared primitives (12a, used by 12b):**
   - **Buttons, links, pills and cards:** one press and hover language from the tokens (above). `.btn[aria-busy='true']` shows the spinner in place of the icon with no width jump (the label keeps its width; the spinner is absolutely positioned over the icon slot).
   - **Content crossfade:** a `.fade-in` utility (opacity 0→1 over `--dur-base`, no movement) that a component puts on the content which replaces a skeleton. Skeletons must match the final layout's size, so the swap doesn't shift anything (the CLS check enforces it).
   - **`FormStatus`:** its message gets `.fade-in` when it changes. The live regions stay always mounted, as 7a requires.
   - **`EmptyRows` (from Phase 8)** gains an optional `icon` and `action` (a link or button), so empty states can say what to do next. No new component.
   - **`animate-fade-in-up`:** the keyframe's distance and duration move to the tokens (8 px, `--dur-base`), so the ~45 existing uses calm down without touching each site. Inline `animationDelay` values above 120 ms are removed in the files each part touches.
   - **Resting style is the end state (review S1):** every enter class (`.fade-in`, `.route-enter`, `fade-in-up`, the dialog open, the band wipe) leaves the element at full opacity and no transform when no animation runs. Opacity and movement live only in the keyframe's `from`, as `.animate-in` already does. So under reduce, where the animation is cut, nothing is left at 0.01 or offset.
   - **Reduced motion:** the existing `globals.css` block stays and gains the new classes. Under reduce, everything that rises only fades, and the celebration, shimmer and route enter don't run at all. `MotionConfig reducedMotion="user"` stays for framer.
5. **Home and Explore (12a):**
   - **Home:** the hero stays CSS and opaque at first paint (P1-57). Below the fold, sections reveal once with `rise` at `--dur-slow` and cards stagger at `--stagger`, capped so the last of six cards starts within 240 ms. The stats hover lift and the stagger on feature cards go. The category pills keep their press state only.
   - **Explore:**
     - the heading and filters don't animate on load (they're above the fold, and it delays reading);
     - on a filter, sort or page change, the grid crossfades (opacity only, `--dur-base`) instead of rising, and the pending state shows a thin progress bar at the top of the grid instead of `opacity-50` plus `pointer-events-none`. Clicks on the old results stay possible while the new ones load;
     - course cards share one hover: a shadow and border change, the cover image scales to 1.03 over `--dur-slow` (from 500 ms), and the arrow nudges 2 px.
   - Both pages: the "no courses" states use `EmptyRows` with an icon and a next action ("Clear filters", "Browse all courses").
6. **Route transitions (12a builds it; each part applies it to its groups):**
   - a `template.tsx` at `(teach)/`, `(admin)/` and `(account)/` (the institution pages live under `(teach)`, QA under `(admin)`), and at `(learn)/dashboard/` and `(learn)/messages/` (not at `(learn)/`, which holds the lesson player and exams), wraps the page in a div with a CSS `.route-enter`: opacity from 0.01 to 1 over `--dur-base`. Starting at 0.01, not 0, keeps the element an LCP candidate in Chromium.
   - **Not** in `(public)` or `(verify)` (their first load is what search engines and slow phones measure, and P1-57 already fixed an invisible hero once), and not in the lesson player or exams, where a fade on every lesson change would get in the way.
   - The implementer checks that a `template.tsx` doesn't remount on a search-param change (admin `?tab=`); if it does, that group goes without one and it's logged under Deviations.
7. **The course page, checkout, the learner path and certificates (12b):**
   - **The enrol and pay buttons:** they stay `disabled` and `aria-busy` while the request runs (decision 4's no-jump spinner). Success and failure come through `FormStatus` with `.fade-in`. Nothing pulses or bounces, so nothing invites a second click. (`MobileBuyBar` only scrolls to the buy box, so it has no busy state; drift A11.)
   - **`/payment/return`:** the state icon and text crossfade between polling, active, failed and timeout. The active state's check draws once (SVG `stroke-dashoffset`, `--dur-slow`), and "Start learning" gets focus. Under reduce, it just appears.
   - **The lesson list:** completing a lesson crossfades Play into the check, and the check scales from .8 to 1 over `--dur-base`. Section counts update without movement. The "All lessons" disclosure on mobile uses the `grid-template-rows` pattern.
   - **Progress bars:** `.progress-fill` animates `transform: scaleX()` from the left instead of `width`, so it doesn't relayout. The radius and `overflow-hidden` move to the track and the fill is square, so low progress doesn't squash rounded ends (review N2).
   - **Course complete:** when `completion-card` first shows for a course the learner just finished in this session, the Award icon gets one CSS moment: a ring of 8 small dots in the flag's colours bursts out and fades over about 700 ms, once. It's tracked in `sessionStorage` per course so a reload doesn't replay it; the read and write sit in try/catch, and if storage throws (some private modes) the moment is skipped (review N3); and under reduce it never runs. It's under 1 kB of CSS and a dozen lines of markup.
   - **The certificate page** (`/verify/[uid]`, server-rendered): the flag band wipes in (`transform: scaleX` from the left, `--dur-slow`), and the card itself doesn't move, because it's the LCP element.
   - **Loading:** `loading.tsx` for `/courses` and `/dashboard`, each mirroring its page's layout; the existing course and learner skeletons are checked against their final layout.
8. **Reduced-motion and nothing-waits checks (Playwright):**
   - A `reduced-motion` project in `playwright.config.ts` with `use: { reducedMotion: 'reduce' }`, depending on `setup`, runs only tests tagged `@flow` (`grep: /@flow/`). The tags go on the existing specs that cover the key flows: catalog and search, the course page, the lesson player, the keyboard checks, verify, and the Phase 8 admin dialog. So "key flows pass under reduce" costs no new test code, just the project and the tags.
   - `e2e/reduced-motion.spec.ts` gains one test per part that, under reduce, opens each animated surface (mobile menu, bell, theme menu, dialog; in 12b the payment-return states with a stubbed reconcile and the lesson completion) and asserts no element in it has a non-`none` computed `transform` after open, that its computed `opacity` is 1 (`toBeVisible` ignores opacity; review S1), and that its first control is clickable at once. The same opacity assertion runs on a page under each `template.tsx`.
   - `a11y.spec.ts`'s `revealAll` keeps working, because reveals still finish with inline opacity 1. Its timeout can drop, since reveals are shorter.
   - **No snapshot tests** for motion: they're flaky for animation and assert nothing a reader can check.
9. **Measurement:**
   - **CLS (new automated check):** `e2e/layout-shift.spec.ts` loads `/`, `/courses` and a seeded course page at 375 and 1440, collects `layout-shift` entries without recent input through a `PerformanceObserver` from `addInitScript`, scrolls to the end so the reveals run, and asserts the sum ≤ 0.05. It's tagged `@flow`, so it runs under reduce too. WebKit and Firefox report no `layout-shift` entries, so the spec skips on non-chromium projects and first asserts `PerformanceObserver.supportedEntryTypes` includes `layout-shift`, so it can't pass vacuously (review S2).
   - **First Load JS:** the `next build` route table before and after each part, recorded in Progress against 11c's numbers. 12a adds no framer feature bundle (Phase 10 already loads `domMax`), so the expected growth is near zero; most of the change is CSS.
   - **Lighthouse:** one mobile run each on `/` and a course page, before and after each part, against the local `next start`: `pnpm dlx lighthouse@12 <url> --preset=perf --form-factor=mobile --chrome-path="$(node -e "console.log(require('playwright').chromium.executablePath())")" --quiet --output=json`, recording the performance score and CLS in Progress. Not in CI (a third-party CLI and timing noise). If `pnpm dlx` can't fetch it, the run uses Chrome DevTools' Lighthouse panel against the same URL, and that's logged.
10. **UX audit alongside motion:**
   - For each route group the part touches, run the `web-design-guidelines` skill over its files. Fix what is real and in scope: focus visibility, targets under 44 px on touch layouts (24 px minimum for dense desktop tables, WCAG 2.5.8), form error and validation feedback, Amharic text that overflows or truncates at 375 px (checked with the language set to Amharic), dark-mode contrast.
   - Findings that need a layout redesign, or that belong to another phase, go under Deviations with a reason.
   - The `frontend-design` skill is consulted for the motion feel of decisions 3, 5 and 7; the `react-best-practices` skill checks that no animation adds a re-render loop or a client boundary to a server component (the certificate page stays a server component; its band is CSS).
11. **Skills:** no third-party skill is installed. The installed `frontend-design`, `web-design-guidelines`, `react-best-practices`, `composition-patterns` and `playwright-expert` cover direction, audit, primitives and tests. A third-party skill would add a dependency the brief says must trace back to a need, and none is missing.

## API contract
None.

## Data model and migrations
None.

## Steps
- [ ] 1. Branch `feat/motion-polish-a` from the base above. Record the before numbers in Progress: the `next build` route table (`/`, `/courses`, `/courses/[id]`), the Lighthouse runs (decision 9) and the before screenshots and a short screen recording (step 11's list), at 375 and 1440.
- [ ] 2. **(12a) Tokens and presets** (decision 1): the CSS variables, the Tailwind durations, `lib/motion.ts`, the calmer `fade-in-up` keyframe and `.card-hover`, and the unused keyframes (`float`, `shimmer`, `spin-slow`, `pulse-soft`) removed. vitest: `lib/motion.ts` presets carry the token numbers (one small test, so a change to a token is a visible diff).
- [ ] 3. **(12a) Shared primitives** (decision 4): the press, hover and `aria-busy` button states, `.fade-in`, `FormStatus`'s enter, `EmptyRows` `icon` and `action`, and the reduced-motion block for the new classes. vitest: `EmptyRows` renders the action; `FormStatus` keeps both live regions mounted.
- [ ] 4. **(12a) The shell** (decisions 2 and 3): the header underline and mobile menu, the bell, the theme menu, the dialog's CSS open, the footer. Update the specs that assert on these (Header, NotificationBell, ThemeToggle, ConfirmProvider).
- [ ] 5. **(12a) Home and Explore** (decision 5) plus the route `template.tsx` and `.route-enter` (decision 6) at the places decision 6 lists (the templates are tiny; 12b's audit checks each group). vitest: Explore's pending state keeps the old results clickable.
- [ ] 6. **(12a) Checks** (decisions 8 and 9): the `reduced-motion` project and the `@flow` tags, the 12a part of `reduced-motion.spec.ts`, and `layout-shift.spec.ts`. Run the `web-design-guidelines` audit over the shell, Home and Explore and fix the real findings (decision 10).
- [ ] 7. **(12b) Course page, checkout, payment return, learner path, certificate** (decision 7), and the two `loading.tsx` files. vitest: the payment-return states crossfade (the component keeps the state machine; a test drives it through polling → active and asserts the focus moves to "Start learning"); `completion-card` plays the moment once per course per session and never under reduce (mock `matchMedia`); the lesson list's check swap.
- [ ] 8. **(12b) Dashboards and the rest:** teach, institution, admin, QA, account, messages and the learner dashboard get the primitives (button states, `.fade-in` after skeletons, `EmptyRows` actions, the admin tab indicator with `layoutId`), and lose inline `animationDelay`s over 120 ms. No count-ups or chart animation. Run the `web-design-guidelines` audit over each group and fix the real findings.
- [ ] 9. **Playwright, per part:** the full suite (chromium; drift A1), the `reduced-motion` project, `layout-shift.spec.ts`, and 12b's part of `reduced-motion.spec.ts` (payment return with a stubbed reconcile, lesson completion), all under Phase 10's enforced-CSP fixture.
- [ ] 10. **Measure, per part** (decision 9): the route table and Lighthouse after, recorded next to the before numbers in Progress, with the acceptance limits checked.
- [ ] 11. **Screenshots and recording, per part:** before and after of every touched page at 375 and 1440 (light; dark for Home, the course page and the learner page), plus a 30–60 s screen recording of the motion surfaces (Playwright `video: 'on'` on a scratch spec, not committed), into `screenshots/after-phase12/`. **After 12a:** the planner publishes the before/after as an artifact and shows the user before 12b starts; requested changes fold into 12b.
- [ ] 12. **Full gate, per part:** `pnpm -C web typecheck && pnpm -C web lint && pnpm -C web test && pnpm -C web build`, the Playwright suite against the local stack with Phase 5's build order, and on the PR the CI `web` and `e2e` jobs.
- [ ] 13. Code review by ethio-plan-review, one per part; then the PR and merge under the standing authorization.

## Test plan
- **vitest:** the motion presets (step 2), `EmptyRows` and `FormStatus` (step 3), the shell specs updated (step 4), Explore's pending state (step 5), payment return, `completion-card` and the lesson list (step 7).
- **Playwright:** the `reduced-motion` project over `@flow`-tagged specs; `reduced-motion.spec.ts`'s per-surface checks (no transform under reduce, first control clickable at once); `layout-shift.spec.ts` (CLS ≤ 0.05 at 375 and 1440); every existing spec still green under the enforced CSP; axe zero serious or critical.
- **Manual, recorded:** the route table and Lighthouse before and after; screenshots and the recording.
- **Commands:** `pnpm -C web typecheck && pnpm -C web lint && pnpm -C web test && pnpm -C web build`; with the stack running and web on :3000, `pnpm -C web exec playwright test` (all projects).

## Rollout and ops
- Web only: Vercel deploys on merge. No API, env, migration or CSP change. If a framer exit misbehaves in production, the revert is the PR.
- **Production check (after deploy, by the planner, read-only):** open `/` and `/courses` on the live site at 375 px with reduced motion on and off in DevTools, and confirm the hero is visible at first paint.

## Risks and open questions
- **Phases 10 and 11c land first and change these files** (`m.*`, `LazyMotion`, Next 15). The implementer re-finds each site by its code. If 11c pinned a different framer-motion, `lib/motion.ts` follows that version's API.
- **`template.tsx` remounting** on a search-param change would reset the admin tabs' state; decision 6 makes it conditional per group.
- **The CLS check can flake** on font swap. Phase 10 moves fonts to `next/font` with `adjustFontFallback`, which should keep it under the limit; if it flakes, the check waits for `document.fonts.ready` before measuring, and the limit isn't raised.
- **Lighthouse noise:** single runs vary by a few points; the 3-point limit allows for that, and a miss gets one re-run before it counts.
- **Calmer can read as "less pro"** to the user. That's why 12a's before/after goes to the user before 12b: they can ask for more presence on Home and Explore, and 12b follows that.

## Progress and deviations (implementer)

### 12a
**Drift amendments applied ([drift.md](drift.md)):**
- Base `chore/deps-next15` (7c tip `0d91583`; 11c had no commits yet). Chromium only (A1).
- framer-motion stays `^12.42.2`; Dependabot #40 (12→14) declined, nothing needs 14 (A2).
- All 7 `.progress-fill` sites move to `scaleX` in the CSS commit; `.progress-fill` keeps `background` for `color-tokens.test.ts:84` (A3, A4).
- `.animate-in` moves onto the tokens; the bell/theme `hover:scale-105` becomes a colour change (A6, A8).
- The verify card's `animate-fade-in-up` is removed now (LCP, A10). MobileBuyBar busy line dropped (A11).
- Cuts (A14): no flag-dot celebration, no admin tab `layoutId`, no `lib/motion.ts` constants test, no SVG check-draw.

**Before (at `0d91583`, Next 14.2.35; 11c's after-snapshot doesn't exist yet, so this is the baseline):**

| Route | First Load JS |
|---|---|
| `/` | 128 kB |
| `/courses` | 128 kB |
| `/courses/[id]` | 124 kB |

- Lighthouse mobile (lighthouse@12, local `next start`, one run): `/` perf 49, CLS 0.000, LCP 5.4 s; course page perf 76, CLS 0.000, LCP 1.8 s.
- Screenshots and recording: `screenshots/before-phase12/` (git-ignored).

**After (12a tip on 11c `68596b2`, both built here on Next 15.5.28 / React 19.3; the before numbers above were Next 14):**

| Route | 11c | 12a | Limit +5 kB |
|---|---|---|---|
| `/` | 138 kB | 139 kB | ok |
| `/courses` | 138 kB | 123 kB | ok (framer left Explore) |
| `/courses/[id]` | 134 kB | 134 kB | ok |

- Lighthouse mobile, same install, CLS 0 on every run: `/` 11c 77, 74 (mean 75.5) vs 12a 74, 74, 76, 74, 79 (mean 75.4); course page 11c 82, 80, 80 (mean 80.7) vs 12a 74, 85, 78, 83, 78 (mean 79.6). Means within the 3-point limit; single runs spread ±5.
- 320 px (signed in and out, en and am): header and mobile menu fit after `px-4` below `sm` and a wrapping menu footer row. 13b's #58 hides the Messages icon below 360 px in `Header.tsx`: whichever merges second re-measures 320 px.
- Screenshots and recordings: `screenshots/after-phase12/` (light 375/1440, dark Home, `motion-*.webm`).
- Gate: vitest 753 passed, `tsc --noEmit` clean, `next build` ok, `scripts/lint-check.mjs` no rule above baseline. Local Playwright (chromium + reduced-motion): reduced-motion, layout-shift, keyboard, admin, layout, catalog specs pass. Full suite on CI.

**Deviations (12a):**
- `lib/motion.ts` has a fourth preset, `popover`, so the bell and theme menus share one enter/exit; `RISE` is exported for the menu's downward drop.
- The Explore grid crossfade is CSS (`.fade-in` on the keyed grid), not framer, so Explore no longer imports framer (-15 kB).
- Enter animations fill `backwards`, not `both`, so a finished enter leaves no transform or opacity effect behind.
- Busy spinner is pure CSS on the button's leading icon (no new markup); used by 12b.
- Templates key on the child segment with search params stripped, so `?tab=` and other query changes don't remount.
- `reduced-motion.spec.ts` records at mount: CSS enters count their own animations, framer surfaces count distinct transforms over 250 ms (framer snaps once under reduce). A no-preference control proves both probes see motion.
- `web-design-guidelines` isn't installed here, so the audit was a scripted pass at 375 px (EN and AM): no page overflow, no Amharic overflow; under-44 px targets fixed (burger, bell, theme, back-to-top, both search fields; pills and non-`.btn-sm` buttons on `pointer: coarse`; chip remove 24 px). Skip link and dense 36–40 px desktop buttons left (≥ 24 px, WCAG 2.5.8).
- Literal durations left in touched files: the reduce block's `0.01ms` and the lesson watermark's 90 s drift (anti-piracy, not UI motion).
- pnpm: the machine has pnpm 12, which ignores `pnpm.overrides` (11c); installs and builds here used `npx pnpm@9.4.0`, as CI does.

### 12b
