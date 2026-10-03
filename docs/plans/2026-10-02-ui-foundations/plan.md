# Phase 7a: UI foundations and accessibility

Status: approved (round 2)
Size: M (sessions: 3 — ethio-impl, or `ethio-impl-web` if the user adds it, implements; ethio-plan-review reviews plan and code)
Base branch: `origin/main` after Phase 5 (`fix/web-p0`) has merged. Phase 5 rewrites the root layout spacing, the mobile menu, `overflow-x` in `globals.css` and adds Playwright, all of which this phase builds on. · Feature branch: `feat/ui-foundations`
Roadmap: phase 7, split into 7a (this plan) and 7b (public and learner pages, planned next). See "Roadmap change" at the end.
Visual direction (approved by the user): https://claude.ai/artifact/1KNuTFQ4NeRfsnuAJTxj5k
Findings: P1-33, P1-37, P1-38, P1-40, P1-43, P1-45, P1-48, P1-49, P1-50, P1-51, P1-52, P1-53 (titles, robots, site OG image), P1-54, P1-57; P2-23, P2-24, P2-27, P2-29 (shared chrome), P2-33, P2-40. Also the notification-panel part of P1-47 (same component as P1-50).

## Goal
Make the whole web app readable and operable for keyboard, screen-reader, dark-mode and motion-sensitive users, and give every later UI phase the same small set of building blocks: labelled fields, status messages, human labels for enums, and date and price formatting. Then apply them to the shared chrome and to every public, learner and account page. Role dashboards adopt the same building blocks in Phase 8.

Acceptance criteria:
- **Contrast (P1-52):**
  - no text below 4.5:1 in light or dark mode, anywhere in the app (helper text moves from gray-400 to gray-500);
  - `badge-success` and `badge-danger` text pass, and inline error text (`Field` errors and the swept `text-red-500`) passes in both modes;
  - no readable text below 12 px. The numeric unread badge on the bell is the only exception.
- **Dark mode (P1-40):**
  - native controls (scrollbars, selects, date inputs) follow the theme;
  - the five `dark:text-gray-*` / `dark:bg-gray-*` overrides and the seven light-only `bg-white` panels are gone;
  - `theme-color` matches the scheme.
- **Keyboard (P1-49, P1-50, P1-51):**
  - a skip link is the first tab stop and moves focus to `<main>`;
  - every focusable element shows a visible focus ring, including both search fields;
  - no motion wrapper takes a tab stop;
  - the theme menu, notification panel and mobile menu:
    - open and close by keyboard, and close on Escape with focus back on their trigger;
    - expose `aria-expanded` and `aria-controls`;
    - never stay open together;
    - the mobile menu keeps focus inside while open;
  - every file picker (thumbnail, lesson video, outline, assessment upload) can be reached and opened by keyboard.
- **Forms (P1-48, P1-43):**
  - every input, select and textarea on public, learner and account pages has a programmatic label;
  - errors are announced (`role="alert"`) and successes are polite live updates (`role="status"`);
  - a success never looks like an error.
- **Motion (P1-57):**
  - with reduced motion on, nothing on any page moves except the progress indicators;
  - the server HTML of the home page has no `opacity:0` on the nav, the hero heading, the hero copy, the search or the CTAs;
  - no infinite decorative loops remain.
- **Words (P1-45, P2-40, P1-37):**
  - no raw enum (`institution_admin`, `under_review`) on shared components or on public, learner or account pages;
  - the hero has no fake rating stars;
  - nav labels use sentence case.
- **Gates and navigation (P1-33, P1-38, P2-27):**
  - the login-required card links to `/login?next=<current path>`;
  - the access-denied card has an h1 and a button to the user's own home;
  - Help and Educators are linked from the footer and the mobile menu;
  - the footer reflects the user's sign-in state and role.
- **Metadata and brand (P1-53, P1-54, P2-33):**
  - every route has its own `<title>` and exactly one robots directive;
  - signed-in and utility pages are `noindex`;
  - a site-wide 1200×630 OG image with `summary_large_image`;
  - blue icons, with 192/512 PNG and Apple icons, no 404 on `/favicon.ico`, and the manifest `start_url` set to `/`.
- **Formatting (P2-23, P2-24):** dates and ETB amounts go through one formatter each, using the app locale.
- **Regression gate:** an axe check in the Playwright suite reports zero serious or critical violations on the listed public, learner and account pages, in light and dark.

## Non-goals
- **Page redesigns (Phase 7b):**
  - course detail layout and sticky buy bar (P1-35);
  - generated course covers and per-course OG images (P1-36);
  - lesson player on mobile (P1-39);
  - branded 404/error/loading pages and silent-failure fixes (P1-32, P2-32);
  - the resend-verification endpoint (P1-34);
  - catalog sort and filters (P2-22);
  - review stars (P2-25);
  - signup validation copy (P2-30);
  - emoji status icons on learner pages (P2-35).
- **Applying `Field`, `FormStatus` and labels on role pages** (teach, institution, admin, qa, preview), and anything else in Phase 8. Exceptions: the app-wide mechanical sweeps below (contrast, dark-mode overrides, file pickers), which are one-line class changes that would otherwise leave half the app failing the same rule.
- **Translating new strings into Amharic beyond the keys this phase adds or changes** (P1-55, Phase 10). New user-facing strings in shared chrome get `t()` keys in both dictionaries, so the parity test stays green. Labels in `lib/labels.ts` stay English for now.
- **Removing framer-motion or lazy-loading it** (P1-56, Phase 10), and fonts (P2-28, Phase 10).
- **Canonical tags on every route and per-course OG images** (Phase 10 and 7b).
- **A design-token rewrite.** This phase changes class usages and adds a handful of CSS rules, not the palette.

## Current state
Line numbers are from `fix/access-control` at `3de83c3`. Phase 5 edits some of these files first, so the implementer re-finds each site by its code, not its line.

- **Global CSS** `web/src/app/globals.css`:
  - gray and brand scales are CSS-variable RGB channels that invert under `.dark` (`:44-54`, `:95-105`), so `dark:text-gray-300` resolves to a dark gray in dark mode;
  - no `color-scheme` anywhere;
  - `.input:focus` draws its own ring (`:241-245`), and nothing else has a `:focus-visible` style;
  - `.badge-success` is `#059669` on a light tint, 3.37:1 (`:275-280`);
  - `.input` placeholder is gray-400 (`:236`);
  - two reduced-motion blocks cover CSS animations only (`:384-393`, `:434-438`).
- **Root layout** `web/src/app/layout.tsx`:
  - static `<meta name="theme-color" content="#0f766e">` (`:35`);
  - `<main>` has no id (`:40`);
  - metadata sets `robots: index` and `icons: /icon.svg`, with no OG image and no twitter card (`:9-27`).
- **Brand assets:** `web/public/icon.svg` and `manifest.webmanifest` are teal `#0f766e`, `start_url: /dashboard`, SVG-only icons. The UI brand is blue `#2563eb`.
- **Motion:**
  - `Providers.tsx` has no `MotionConfig`;
  - `Header.tsx:72-77` animates the whole `<nav>` from `opacity: 0`;
  - in `home-client.tsx:73-229`, every hero element starts at `opacity: 0`, with infinite loops at `:81-90` (blobs), `:174` (arrow) and `:203-226` (floating chips);
  - `whileTap` on plain `motion.div`/`span` wrappers adds a tab stop: `Header.tsx:135`, `home-client.tsx:168,179,330,442,481`.
- **Popovers:**
  - `ThemeToggle.tsx:16-22` and `NotificationBell.tsx:128-134` close only on outside click;
  - the burger (`Header.tsx:164-170`) has no `aria-expanded`;
  - the bell panel is `absolute right-0 w-80` (`NotificationBell.tsx:176`), off-screen at 375 px;
  - grep finds no `Escape` handler in `web/src`.
- **Forms:**
  - on public, learner and account pages, about 44 controls, 23 `<label>`s, and only 1 `htmlFor` (`accept-invite`);
  - examples: `login/page.tsx:58-64`, `signup/page.tsx`, `reset-password/page.tsx`, `help/page.tsx`, `account/page.tsx` (6 controls), `account/password/page.tsx`, `enroll-panel.tsx` (6), `dashboard/page.tsx` (4), `assessments-panel.tsx`, `exam/[assessmentId]/page.tsx`, `messages/page.tsx`, `CommentsSection.tsx`, and the search inputs in `home-client.tsx:150-155` and `explore-client.tsx`;
  - the correct pattern already exists in `teach/courses/[id]/course-details.tsx:101-138`.
- **Messages:** errors and successes share `badge-info` in several places. On public, learner and account pages, about 85 `setError`/`setMsg`/`badge-info` sites use ad-hoc markup. No public or learner page uses `role="alert"` or `aria-live`, except the login error, which is visually distinct but not announced.
- **Enums:**
  - `StatusBadge` (`PageChrome.tsx:123-155`) prints `status.replace(/_/g,' ')` and is used on learner and role pages;
  - `RequireRole.tsx:46-47` prints raw role names;
  - `Header.tsx:42,44,47` uses "Review Queue" and a hardcoded "QA".
- **Gates:** `RequireRole.tsx` links to plain `/login` (`:32`); the access-denied card has no heading and no action (`:39-51`).
- **Footer** `Footer.tsx:12-38`:
  - static columns (Log in / Sign up when signed in, `/dashboard` for every role);
  - no Help or Educators links;
  - untranslated "Made with … for Ethiopia" and "Back to top";
  - 20 px link rows.
- **Metadata:** of 36 `page.tsx` files, 26 are `'use client'` with no metadata and no layout, so they show the default title. Only `verify/[uid]` sets `noindex`.
- **Contrast inventory:**
  - `text-gray-400`: 91 uses in 39 files;
  - `text-gray-300`: 8 uses;
  - `text-[10px]`/`text-[11px]`: 23 uses;
  - file inputs with `className="hidden"`: `video-upload.tsx:321,391,468`, `sections-editor.tsx:383`, `structure-generator.tsx:283`. `course-tools.tsx:135` and `assessments-panel.tsx:159` are visible.
- **Dates and prices:** 22 `toLocale*String` calls without a locale, and about 37 places build "N ETB" by concatenation.
- **Phase 5 adds** (assumed merged):
  - Playwright under `web/e2e/` with a per-role `storageState` setup;
  - the header height as padding on `<main>`;
  - an opaque mobile menu with a dimmed backdrop;
  - `overflow-x: clip`;
  - the role-home helper (Phase 3 shipped `roleHome()` in `web/src/lib/safe-next.ts`; Phase 5's plan calls it `homeForRole`);
  - `safeNext` from Phase 3.

## Design and key decisions
1. **Three small primitives in `web/src/components/form/`, nothing more:**
   - **`Field`:** props `label`, `hint?`, `error?`, `children: (ids) => ReactNode`. It calls `useId()` and passes `{ id, 'aria-describedby', 'aria-invalid' }` to the render prop; it renders `<label htmlFor>`, the hint and the error (`role="alert"`). A render prop rather than `cloneElement`, so the wiring is visible at the call site.
   - **`FormStatus`:** takes `status: { tone: 'ok' | 'error'; text: string } | null`. It keeps **two always-mounted, visually empty regions**, one `role="status"` and one `role="alert"`. It puts the text in the region that matches the tone (styled `badge-success` or `badge-danger`) and clears the other. A single region that switches its role isn't announced reliably (round-1 S1).
   - **`Field` errors** use `text-red-600 dark:text-red-400` (4.8:1 and 6.4:1). Red-600 alone fails in dark (round-1 B1).
   - **`useFormStatus()`:** returns `[status, setOk, setError, clear]`.
   - Rejected: a form library (react-hook-form). Most forms here have 1–6 fields and native validation, and a library would be a second pattern next to the existing one.
2. **One labels module, `web/src/lib/labels.ts`:**
   - `roleLabel(role)`;
   - `statusLabel(status) → { label, tone }`, where `tone` is the badge class, replacing `STATUS_STYLE`;
   - `pricingLabel`;
   - `categoryLabel`, reusing `COURSE_CATEGORIES`.
   - Unknown values fall back to sentence case with underscores removed, never to the raw enum.
   - `StatusBadge` uses it and gains an optional `label` override for context-specific wording (for example "Payment not finished"), so callers don't fork the map.
   - English only for now (non-goal); the map is the single place to translate later.
3. **Formatting, `web/src/lib/format.ts`:**
   - `formatDate(d, locale, style?)` on `Intl.DateTimeFormat`, with style `'date' | 'datetime'`;
   - `formatETB(amount, locale)` on `Intl.NumberFormat` with digit grouping and an "ETB" suffix. We use the suffix, not `currency: 'ETB'`, because browsers render `ETB` / `Br` inconsistently, and the suffix matches today's copy;
   - `am` maps to `am-ET`, `en` to `en-GB` (day-month order, as the visual direction shows).
   - All 22 date sites and the ETB sites move to these helpers, including role pages. These are one-line swaps, and leaving half the app in US format would be visibly inconsistent.
4. **Contrast is a class sweep, not a palette change:**
   - `text-gray-400` → `text-gray-500` and `text-gray-300` → `text-gray-500` wherever the element is text or a meaningful icon;
   - purely decorative separators (`·`) and borders stay;
   - `placeholder:text-gray-400` → `placeholder:text-gray-500` in `.input` and in inline placeholders;
   - `text-[10px]`/`text-[11px]` → `text-xs`;
   - `.badge-success` light text → `#047857`; `.badge-danger` light text → `#b91c1c` (about 5.7:1 on its tint; dark stays `#f87171`) (round-1 B1);
   - `text-red-500` on text → `text-red-600 dark:text-red-400` (63 uses). Icons can stay;
   - **surfaces that stay dark in both themes** (`bg-black`, `bg-black/50` overlays, video players): use non-inverting `text-white/80` (`text-white/70` for large text), never the gray scale, which inverts. Example: the lesson player's empty state, `learn/[courseId]/page.tsx:283`, `text-gray-300` on `bg-black` (round-1 S3).
   - gray-500 is 4.76:1 on white, and in dark mode it resolves to slate-400 on the dark background (about 6.9:1). The current gray-400 in dark (about 3.7:1) fails, so the one sweep fixes both modes.
   - Rejected: redefining `--gray-400`. It is also used for borders and icons, and lightening or darkening it would shift every surface at once.
5. **Dark mode:**
   - `:root { color-scheme: light } .dark { color-scheme: dark }`;
   - `select.input option { background: var(--background); color: var(--foreground) }`;
   - delete the `dark:text-gray-*`/`dark:bg-gray-*` overrides, and swap the light-only `bg-white`/`bg-gray-50` panels for token classes (`bg-card`, `bg-background-secondary`);
   - `theme-color` moves to the `viewport` export as two entries with `media`: light `#2563eb`, dark `#0f172a`. `ThemeProvider` also rewrites the meta when the user picks an explicit theme, because the media query only knows the OS setting.
6. **Focus and keyboard:**
   - a global `:focus-visible { outline: 2px solid rgb(var(--brand-600)); outline-offset: 2px }` in the base layer;
   - `.input:focus` keeps its own ring, so inputs don't get both;
   - search forms get `focus-within:ring-2` (white on the blue hero);
   - **skip link:** `SkipLink`, a small client component rendered first inside `Providers` (so it can use `t('skip_to_content')`, a key in both dictionaries), `sr-only focus:not-sr-only`, `href="#main"`. `<main id="main" tabIndex={-1} className="... focus:outline-none">`, so the programmatic focus doesn't ring the whole page (round-1 N2);
   - **`whileTap` wrappers:** remove them from non-interactive wrappers, and use CSS `active:scale-[.98]` on the link itself;
   - **file pickers:** the five hidden inputs become `sr-only` (still in the tab order), and their visible wrapping label gets `focus-within:ring-2`. A keyboard user tabs to the input and Space/Enter opens the picker. No custom button or `inputRef.click()`.
7. **Overlays share one hook, `web/src/lib/use-dismiss.ts`:** `useDismiss({ open, onClose, containerRef, triggerRef })` handles:
   - an outside click;
   - Escape, which closes and returns focus to the trigger;
   - closing when another overlay opens (a window `CustomEvent('el-overlay-open', { detail: id })`).

   Wiring and behaviour:
   - ThemeToggle, NotificationBell and the mobile menu use it.
   - Triggers get `aria-expanded` and `aria-controls`; ThemeToggle options get `aria-pressed`.
   - The mobile menu also moves focus to its first link on open and wraps Tab inside the nav while open, because Phase 5's backdrop makes it modal.
   - Below `sm`, the bell panel becomes `fixed inset-x-4 top-20` (the P1-47 part).
   - Rejected: a headless UI library for three overlays.
8. **Motion (approved visual direction: "one hero entrance, everything else static"):**
   - `<MotionConfig reducedMotion="user">` in `Providers`;
   - the nav renders statically: no `initial`, so its server HTML is visible;
   - the hero panel keeps one CSS entrance (`animate-in`, already reduced-motion guarded), and every hero child loses its framer `initial` opacity;
   - delete the infinite loops (blobs, arrow, floating chips) rather than gating them;
   - below-the-fold `whileInView` reveals stay for now (P1-56, Phase 10, decides framer's future). Under reduced motion, `MotionConfig` drops their movement and only the fade remains, which is acceptable because a fade is not motion.
   - Also delete the five hero stars (P1-37).
9. **Gates and chrome:**
   - **`RequireRole`:**
     - signed out → `/login?next=${encodeURIComponent(pathname + window.location.search)}`, with `pathname` from `usePathname()`, validated on the login side by Phase 3's `safeNext`. That branch renders only on the client after `ready`, so `window` is safe. **Don't use `useSearchParams` here:** in Next 14.2 it would fail `next build` on about 18 statically rendered pages without a Suspense boundary (round-1 S2);
     - wrong role → h1 "This page isn't available for your account", a sentence that names the role with `roleLabel`, and a button to the user's home from the role-home helper (Phase 3's `roleHome` in `lib/safe-next.ts`, or the name Phase 5 settles on; don't add a third copy) (round-1 N1);
     - both cards translated with `t()`.
   - **Footer:**
     - columns built from auth state: signed out → Log in / Sign up; signed in → the role's home and Account;
     - Learn column: Browse, Educators, Verify a certificate (`/verify`, from Phase 5), Help;
     - "Made with…" and "Back to top" use `t()`;
     - link rows get `py-1` for a 24 px minimum target.
   - **Header:** Help and Educators in the mobile menu, labels in sentence case ("Review queue"), and "QA" becomes `t('quality_review')`.
10. **Metadata:**
    - **Per-route titles:** each client route folder gets a 3-line server `layout.tsx` exporting `metadata` (title, and `robots: { index: false }` where it applies). Server pages already have metadata and keep it.
    - **noindex:** reset-password, verify-email, accept-invite, payment/return, pay/[token], dev/checkout, account/*, notifications/*, dashboard, learn/*, messages, teach/*, institution/*, admin, qa, preview/*.
    - **Indexable:** login, signup and help keep `index` and get `alternates.canonical`.
    - **Site OG image:** `app/opengraph-image.tsx` via `ImageResponse` (built into Next 14, no new dependency), 1200×630, with the blue panel, the cap mark, the wordmark and the flag band; root `twitter: { card: 'summary_large_image' }`.
    - **Course pages** set their own `openGraph` and omit `images` without a thumbnail (`courses/[id]/page.tsx:44-49`). The metadata spec asserts `og:image` is present on such a course. If Next doesn't inherit the site image there, the course page falls back to it explicitly (7b replaces it with per-course images) (round-1 N3).
    - A Playwright test asserts one `<meta name="robots">` per page.
11. **Icons:**
    - redraw `public/icon.svg` in brand blue: a white cap and a flag hairline, as in the header logo;
    - generate the PNGs with Next file conventions and `ImageResponse`: `app/icon.tsx` with `generateImageMetadata` for 32/192/512 plus a padded `maskable-512` (artwork inside the inner 80% safe zone), and `app/apple-icon.tsx` at 180;
   - delete `icons: { icon: '/icon.svg' }` from the root metadata, since the file-based icons replace it (round-1 N3);
    - `public/manifest.webmanifest` becomes `app/manifest.ts`, so it references the generated URLs and can't drift: `start_url: '/'`, `theme_color: '#2563eb'`, and the PNG icons plus the padded maskable 512;
    - `next.config.mjs` rewrites `/favicon.ico` to the 32 px icon.
    - The implementer confirms the generated icon URLs in the `next build` route list before writing the manifest.
    - Rejected: committing binary PNGs made by hand, which would drift from the SVG.
12. **The axe gate:**
    - add `@axe-core/playwright` (web devDependency, the standard axe binding);
    - a new `e2e/a11y.spec.ts` checks these pages at 1440 px in light and dark, using the Phase 5 storage states, with tags `wcag2a`, `wcag2aa`, `wcag21aa`, and fails on `serious`/`critical`:
      - home, catalog, course detail (free and paid);
      - login, signup, reset-password, `/verify`, a certificate page;
      - help, educators;
      - dashboard, lesson player, account, account/password, notifications;
      - `/login` after a wrong-password submit, so the error states are under the gate (round-1 B1);
    - **violations outside this phase's findings:** the implementer fixes them if each is a few lines; otherwise it's excluded with a per-rule, per-selector `exclude` in the spec, with a comment naming the phase that owns it, and logged under Deviations. Never a blanket rule disable.

## Steps
- [x] 1. Branch `feat/ui-foundations` from `origin/main` after Phase 5 merges.
- [x] 2. Primitives: `components/form/Field.tsx`, `FormStatus.tsx`, `useFormStatus`, `lib/labels.ts`, `lib/format.ts`, `lib/use-dismiss.ts` (decisions 1–3, 7).
  - vitest: `Field` links its label and description ids; `FormStatus`: both regions exist before any status is set, and the text lands in the region for its tone; `statusLabel` on known and unknown values; `formatDate`/`formatETB` in en and am; `useDismiss` handles Escape (focus returns), outside click and a second overlay opening.
- [x] 3. Global CSS and layout: `color-scheme`, `:focus-visible`, `select` option colours, `.badge-success`, `.input` placeholder; skip link and `<main id>`; `viewport.themeColor`, plus `ThemeProvider` meta sync (decisions 4–6). · vitest for the ThemeProvider meta sync.
- [x] 4. App-wide sweeps (decisions 3–6):
  - contrast classes;
  - small text;
  - dark-mode overrides and light-only panels;
  - file pickers;
  - date and ETB formatting.

  - error text: `text-red-500` → `text-red-600 dark:text-red-400`;
  - fixed-dark surfaces: `text-white/80` instead of the gray scale.

  Verify with `grep -rnE "text-gray-(300|400)|text-red-500|text-\[1[01]px\]|dark:(text|bg)-gray-" web/src` → only the documented exceptions (decorative icons, the bell's count badge), each with a code comment.
- [x] 5. Overlays and header (decision 7, 9):
  - ThemeToggle, NotificationBell (mobile panel), mobile menu focus handling;
  - Header labels and links;
  - remove the `whileTap` wrappers.

  vitest: Escape closes each and focus returns; `aria-expanded` toggles; opening the bell closes the theme menu.
- [x] 6. Motion (decision 8): `MotionConfig`, a static nav, the hero's CSS entrance, loops deleted, stars deleted. · Verify: `curl -s localhost:3000/ | grep -c 'opacity:0'` before and after, and no nav or hero element among the remaining hits.
- [x] 7. Forms and messages on public, learner and account pages (decisions 1, 2):
  - **`Field` and `FormStatus` on:** login, signup, reset-password, accept-invite, help, account, account/password, verify-email, enroll-panel, dashboard, assessments-panel, exam, messages, CommentsSection;
  - **search inputs** get `aria-label`;
  - **icon-only buttons** get names ("Remove option 2" style);
  - **`StatusBadge`** goes through `labels.ts`.

  vitest: one test per form family (auth, account, enroll), asserting `getByLabelText` and an error announced with `role="alert"`.
- [x] 8. `RequireRole` and the Footer (decision 9). `next build` still passes with no new Suspense boundaries. · vitest: signed-out `RequireRole` links to `/login?next=%2Flearn%2Fabc`; wrong role shows the h1 and the role-home link; footer columns for signed-out, learner and educator.
- [x] 9. Metadata and icons (decisions 10, 11): route layouts, OG image, twitter card, icon routes, `app/manifest.ts`, `/favicon.ico` rewrite; delete `public/manifest.webmanifest`, and delete the `manifest` and `icons` fields from the root metadata (Next adds both from the file conventions). · Verify that `next build` lists `/opengraph-image`, `/icon/*`, `/apple-icon` and `/manifest.webmanifest`, and that `curl -I` on each returns 200 with an image or manifest content type.
- [x] 10. Playwright:
  - `a11y.spec.ts` (decision 12);
  - a titles-and-robots spec: each listed route has a non-default `<title>` and exactly one robots meta, with noindex where listed; a course without a thumbnail has an `og:image`;
  - a keyboard spec:
    - on `/login`, the first Tab focuses the skip link; Enter moves focus to `main`; the email field is reached with no duplicate stops;
    - the mobile menu at 375 px opens, closes on Escape, and focus returns to the burger;
    - the bell panel at 375 px stays within the viewport;
  - a reduced-motion spec: with `reducedMotion: 'reduce'`, the hero h1's computed opacity is 1 at first paint.
- [x] 11. Screenshots:
  - before/after of every touched public, learner and account page at 375 and 1440, light and dark;
  - the editor's file pickers with keyboard focus;

  saved into `docs/plans/2026-10-02-refinement-audit/screenshots/after-phase7a/` (git-ignored) for the user.
- [ ] 12. Full gate:
  - `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`;
  - the Playwright suite against the local stack, using Phase 5's build order and restart rule;
  - `pnpm -C api test` untouched;
  - on the PR, the CI `web` and `e2e` jobs pass.
- [ ] 13. Code review by ethio-plan-review; the user approves push and PR.

## Test plan
- **vitest:** the primitives (step 2), the ThemeProvider meta sync (step 3), the overlays (step 5), the form families (step 7), `RequireRole` and the Footer (step 8). The i18n parity test covers every new key.
- **Playwright:** the a11y, metadata, keyboard and reduced-motion specs (step 10), plus all of Phase 5's specs, still green.
- **Commands:** `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`; with the stack running and web on :3000, `pnpm -C web exec playwright test`.

## Rollout and ops
- **Web only:** no API, schema or env change.
- **Vercel** picks up the new icon and manifest routes on deploy.
- **Installed PWAs** refresh their icon and theme only when the browser re-reads the manifest, which can take days. Nothing to do.
- **The service worker** doesn't precache the icon or the manifest (checked, `public/sw.js`), so there's no cache to bust.

## Risks and open questions
- **The axe gate can surface issues nobody has listed yet.** Decision 12's rule (fix if small, otherwise a scoped exclude naming the owning phase) keeps it from turning into an unbounded sweep.
- **The size of the class sweep:** about 130 one-line class edits across about 45 files. They are mechanical and grep-verifiable. The reviewer checks the grep result and samples screenshots rather than reading every line.
- **`generateImageMetadata` URL shape in Next 14** (`/icon/<id>`) is checked against the build output in step 9 before the manifest hardcodes it. If it differs, the manifest takes the paths from the build.
- **Concurrency with Phase 6a and 6b:** both are mostly backend. 6b changes the lesson player's progress calls, so whichever merges second rebases `learn/[courseId]/page.tsx`; this phase only swaps classes and labels there.

## Roadmap change (planner)
Phase 7 was one M phase covering about 30 findings across shared chrome and every public and learner page, too broad for one reviewable PR. It is split by layer:
- **7a, this plan:** shared building blocks, app-wide sweeps and shared chrome.
- **7b:** page-level UX on public and learner pages (P1-32, P1-34, P1-35, P1-36, P1-39, P2-22, P2-25, P2-26 dimensions only if cheap, P2-30, P2-32, P2-35), which builds on 7a's primitives. 7b includes one small auth endpoint, resend verification.

Phase 8 then applies the 7a primitives to role pages.

## Progress and deviations (implementer)

Implemented by ethio-planner in the worktree `/home/kal/Documents/code/ethi0-web` (see handoff → Branch → Parallel run), task by task with a fresh subagent per step and a task review after each. The ledger is `.superpowers/sdd/plan/progress.md` (git-ignored scratch in the worktree).

Commits: `9f24b1a` plan folder (step 1); `77f9f89` primitives (step 2); `404e302` skip link, focus ring, themed native controls, theme-color (step 3). Step 4 `feb1bf3..b6a064d`; step 5 `1030b10..de63a8d`; step 6 `8ee22d0..063337e`; step 7 `9c06437..1cd3907`; step 8 `04417ab`, `6caede9`; step 9 `72962ec`, `6d692b4`; step 10 `ab6b459`, `c395500`, `c7113d7`; step 11 screenshots only (git-ignored, `docs/plans/2026-10-02-refinement-audit/screenshots/after-phase7a/` in the shared tree, with an `index.md`).

Deviations and notes (none changes a decision):
- **Step 2:** `pricingLabel` copy is Free / Free preview / Paid. `statusLabel` tones copy `STATUS_STYLE` exactly, so step 7's `StatusBadge` swap is drop-in.
- **Step 2 → 4 (ruling):** `format.ts` gets a fixed `timeZone: 'Africa/Addis_Ababa'`, applied in step 4 before the 22 date sites move. Without it, server (UTC) and client renders differ, causing hydration mismatches and off-by-one dates. The audience is Ethiopia-first.
- **Step 3:** also sets `.badge-danger` light text `#b91c1c` (decision 4, round-1 B1). The Amharic `skip_to_content` ("ወደ ዋናው ይዘት ዝለል") is best-effort and needs native review.
- **Step 4 (ruling):** the date and ETB sweep covers role pages too, per decision 3.
- **Step 5:** `useDismiss` gained an optional `closeOnOtherOpen` (default true; false for the mobile menu, which hosts the theme menu), and an open-overlay stack, so Escape closes only the innermost overlay. `.btn` links rely on `.btn`'s own hover and active transform instead of scale utilities. New keys `quality_review`, `educators` (Amharic best-effort, native review).
- **Step 6:** the theme and language toggles lost their framer icon-swap entrance (it left `opacity:0` in the nav's server HTML). `opacity:0` hits on `/` went from 57 to 38, all below-the-fold `whileInView` reveals, including the final CTA band (Phase 10 decides framer's future).
- **Step 7:** `StatusBadge` text is now sentence case ("Under review"). Pages with several forms carry one status and alert pair per form. Pages that can show `<WakingUp>` render `FormStatus` only after the data loads, so `cold-start.spec`'s strict `role="status"` still matches exactly one element.
- **Step 8:** the footer's Learn column no longer has "My dashboard" or "Certificates". Signed-in users get their role home and Account. New keys `gate_login_title`, `gate_login_body`, `gate_denied_title`, `gate_denied_body`, `footer_made_with`, `footer_for_ethiopia`, `back_to_top` (Amharic best-effort). Phase 5's three wrong-role assertions moved to the new h1 in the same commit (drift D1).
- **Step 9:** 28 route layouts. The course page falls back to `/opengraph-image` without a thumbnail, covered by a vitest test on `generateMetadata`, since the seed has no thumbnail-less course.
- **Step 10:** 72/72 in the full suite. The first run found a real contrast failure: unread notification text on its tint, now `text-gray-600`. No axe waivers. The `/login` wrong-password scan stubs the login (drift D5), so the suite spends no extra auth-strict calls.
- **Step 11:** the outline picker and the assessment upload weren't shot: the outline card is collapsed and the upload doesn't render on the sample course. 768 px and the role dashboards weren't shot either.

### In flight / next step (tenth checkpoint, 2026-10-03)
- Steps 1–11 are done and task-reviewed (step 10 complete after fix round 1, `c7113d7`).
- **Next:**
  1. The final whole-branch review on the most capable model (`4b4a64c..HEAD`), pointed at the ledger's deferred minors. Several are marked LIKELY FIX: the assessment non-pass shown in success green, `roleLabel` on accept-invite, the null guard in reduced-motion.
  2. One fix wave and one scoped re-review.
  3. Step 12's gate: typecheck, vitest and build, then the full Playwright suite in a stack window from ethio-impl (ask first, about 15 minutes).
  4. Code review by ethio-plan-review (size M).
  5. Push, PR and merge under the user's standing authorization in `~/.claude/CLAUDE.md`, once CI is green and the review is APPROVED.
- After the merge: show the user the before/after screenshots (`after-phase7a/index.md`), and send 7b's handoff.

