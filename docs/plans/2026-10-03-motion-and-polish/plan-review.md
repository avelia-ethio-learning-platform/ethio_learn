# Plan review: Phase 12, motion and UI polish

## Round 1 (2026-10-03) · Verdict: APPROVED (no blockers; S1–S2 to fold in)
Reviewed `plan.md` (draft, round 1) against `brief.md`, plus `origin/main`'s `globals.css` and `tailwind.config.ts`, and 11c's plan (webkit).

The plan matches the brief and stays inside it:
- calmer tokens; CSS first, with framer only for exits, `layoutId` and the Home reveals;
- no toast, no second library, no third-party skill;
- the public and verify groups and the lesson player are kept out of route fades;
- the hero stays opaque at first paint;
- the 12a/12b split, with the user's before/after between them.

Every new piece traces back to the brief: `lib/motion.ts`, `EmptyRows`' `icon`/`action`, the CLS spec, the `reduced-motion` project. The facts I spot-checked hold:
- the existing reduced-motion blocks (`globals.css:398`, `:448`);
- `.progress-fill` animating `width` (`:345`);
- the four unused keyframes and `fade-in-up` at 0.6 s / 14 px (`tailwind.config.ts`).

### Blockers
None.

### Should-fix
- **S1. The base (resting) style of every enter class must be its end state, or reduced-motion users get blank pages.** This applies to `.route-enter`, `.fade-in`, the celebration and the band wipe.
  - **The failure:** decision 6 says the route enter runs "opacity from 0.01 to 1", and decision 4 says under reduce "the route enter doesn't run at all". If the implementer writes `.route-enter { opacity: .01; animation: … }` and the reduce block sets `animation: none`, every templated page (teach, admin, account, dashboard, messages) stays at opacity 0.01 for those users.
  - **Why the planned tests miss it:** Playwright's `toBeVisible()` ignores opacity, so the `@flow` project would still pass.
  - **The existing pattern to copy:** `.animate-in` gets this right. The opacity lives only in the keyframe's `from`, with fill mode `both`, and `animation: none` falls back to opacity 1.
  - **Suggested:** decision 4 states the rule. `reduced-motion.spec.ts` adds one assertion: on a templated route (the learner dashboard) and on a `.fade-in` swap, the computed `opacity` is `"1"` right after navigation under reduce.
- **S2. `layout-shift.spec.ts` passes vacuously in WebKit.**
  - **The failure:** after 11c, the full suite runs in chromium and webkit, and WebKit has no `layout-shift` entry type. `observe({ type: 'layout-shift', buffered: true })` records nothing there, so the sum is 0 and the gate passes no matter what.
  - **Suggested:** `test.skip(browserName !== 'chromium', 'layout-shift is Chromium-only')`, plus an assertion that `PerformanceObserver.supportedEntryTypes` includes `'layout-shift'`, so a silent no-op can't count as a pass. The `reduced-motion` project should use the chromium device so the `@flow`-tagged CLS spec runs there too.

### Nits (optional)
- **N1.** The acceptance grep `duration-(500|700|1000)` misses `duration-300`, `duration-[600ms]` and Tailwind's `transition` default of 150 ms. `duration-[0-9\[]` outside the token block is the stricter check. Or drop "finds nothing" and say "no literal durations in files the part touches".
- **N2.** `.progress-fill` with `rounded-full` under `scaleX()` squashes its rounded ends at low progress. Either put the radius and `overflow-hidden` on the track and leave the fill square, or accept it.
- **N3.** Wrap `completion-card`'s `sessionStorage` read and write in try/catch. Some private modes throw on access, which would break the card. On a throw, skip the moment.

### Planner responses (round 1)
- **S1: fixed.** Decision 4 now requires every enter class to rest at its end state, with opacity and movement only in the keyframe's `from`. Decision 8 adds a computed-opacity assertion under reduce, including a page under each `template.tsx`.
- **S2: fixed.** `layout-shift.spec.ts` skips on non-chromium and first asserts `supportedEntryTypes` includes `layout-shift`.
- **N1: taken.** The acceptance is now "no literal durations in the files each part touches", with the stricter grep.
- **N2: taken.** The radius and `overflow-hidden` move to the track; the fill is square.
- **N3: taken.** The `sessionStorage` read and write are in try/catch; a throw skips the moment.
