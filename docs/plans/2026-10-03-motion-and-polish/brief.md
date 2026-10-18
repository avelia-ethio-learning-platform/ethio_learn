# Brief: motion and pro-level UI/UX polish (new phase)

Written by ethio-plan-review on 2026-10-03, from the user's request. This is input for ethio-planner, not a plan. The planner sizes it, writes `plan.md` here and runs the usual loop.

## The user's request (their words)
"Add proper and best animations to the site … I want the website to feel pro in UI/UX, functionality, beautiful … give this to the planner with a proper prompt and plan idea, and iterate through all the agents to make the best website." They also allowed downloading the best skill for the job.

## Constraints already decided (don't relitigate)
- **Visual direction (refinement decisions, Oct 2026):** blue and Inter are kept, with generated course covers, the flag band as structure, **calmer motion**, and contrast and focus fixes. "Pro" here means polished, consistent and purposeful, not more movement.
- **The product's users** are mostly on mobile, on slow or metered connections, in English and Amharic. Motion must not cost first load or battery.
- **Phase 10 (web hardening)** moves framer-motion to `LazyMotion` + `m.*` (strict) and records first-load sizes. CSP and framer's inline `style` are handled there. 7a added `MotionConfig`. This phase builds on that and must not regress those sizes.
- **Phase 11c** moves to Next 15 / React 19, and may bump framer-motion.
- **No over-engineering** (user rule): every new dependency, abstraction or config needs a reason that traces back to this brief.

## Plan idea (a starting point; the planner owns the design)
1. **A motion system first, then apply it.**
   - A few tokens: three durations, two or three easings and one stagger step. They live in Tailwind config / CSS variables and in a small `lib/motion.ts` of shared framer `transition`/`variants` presets.
   - Reduced motion: `MotionConfig reducedMotion="user"` plus a `prefers-reduced-motion` CSS block. Movement collapses to a fade or to nothing.
   - Only `transform` and `opacity` are animated, so nothing animates layout and causes CLS.
2. **CSS first, framer only where CSS can't do the job.**
   - In CSS: hover, press and focus states, skeleton shimmer, button and link micro-interactions.
   - framer `m.*`: enter and exit (`AnimatePresence`), layout (`layoutId`), list stagger and `whileInView` reveals (once only).
   - **No second animation library** (GSAP, Lenis, Lottie) unless a surface can't be done otherwise, and that is argued in the plan.
3. **Route transitions:** a short fade or slide through `template.tsx` per route group, or nothing where it hurts (the lesson player, exams). No experimental Next APIs.
4. **Surfaces, by value:**
   - Home and Explore: hero entrance, course-card reveal and hover, filter changes animating the grid.
   - The course page and enrol / checkout:
     - clear pending, success and failure feedback on the pay button and the payment-return page;
     - nothing that could look like a double-submit invitation.
   - The learner path:
     - lesson list progress;
     - completing a lesson (a small check animation);
     - completing a course: one celebratory moment, CSS or a tiny one-shot, and none under reduced motion;
     - the certificate reveal.
   - Shared UI: the toast, modal and drawer, dropdown, notification-bell panel, tabs (sliding indicator), and accordion.
   - Loading, empty and error states everywhere:
     - skeletons match the final layout, and the content crossfades in;
     - empty states get an illustration or icon and a next action.
   - Teach, admin and institution dashboards: the same primitives. Skip number count-ups or decorative charts animation unless they help.
5. **UX pass alongside motion:**
   - Run the `web-design-guidelines` skill over each route group and fix what it finds that is real: focus, 44 px targets, form errors and validation feedback, Amharic text fitting, dark mode.
   - Don't redesign layouts the user already approved.
6. **Proposed split** (the planner sizes it):
   - **12a:** the motion system, shared primitives, the shell, Home and Explore;
   - **12b:** the course page, checkout, the learner path, certificates and dashboards.
   - After 12a, show the user a short before/after (screenshots or a screen recording at 375 and 1440 px) before 12b continues.

## Acceptance (testable)
- First-load JS for `/`, `/explore` and a course page is no more than about 5 KB gz above Phase 10's recorded numbers. Lighthouse mobile performance doesn't drop. CLS ≤ 0.05 on those routes.
- Playwright runs once with `reducedMotion: 'reduce'`. Key flows pass, and no element waits on an animation to become clickable.
- Existing Playwright and vitest suites stay green. No new CSP violations, under Phase 10's enforced-CSP fixture.
- Screenshots or a video at 375 and 1440 px, before and after, in `screenshots/after-phase12/` (git-ignored).

## Skills
- **Already installed, and enough for this:**
  - `frontend-design:frontend-design` for the aesthetic and motion direction;
  - `web-design-guidelines` for the audit;
  - `react-best-practices` and `composition-patterns` for the primitives;
  - `playwright-expert` for the reduced-motion and visual checks.
- **Third-party skill:** the user allows one. Only install one from a reputable source, read every file before installing, and nothing that runs scripts on install. My view is that it isn't needed. If one is installed, the plan says which one and why.

## Sequencing (the planner decides; ask the user if it changes the queue)
- At the earliest, it goes after Phase 10. Phase 10 rewrites the same imports (`motion.*` → `m.*`) and sets the size baseline.
- Ideally it also goes after 11c (Next 15 / React 19), so the work isn't redone. If the user wants it sooner than the current queue allows, that's their call.
- Its plan can be written and reviewed now.
