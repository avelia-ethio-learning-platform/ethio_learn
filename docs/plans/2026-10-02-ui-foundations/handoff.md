# Handoff: Phase 7a, UI foundations and accessibility

From ethio-planner to ethio-impl (or `ethio-impl-web` in its own git worktree, if the user adds one). **Update 2026-10-03:** ethio-planner implements it in the worktree `/home/kal/Documents/code/ethi0-web`; see Branch → Parallel run.
Plan: [plan.md](plan.md) (approved in round 2, see [plan-review.md](plan-review.md))
Code review goes to: ethio-plan-review (size M)

## What to build
- **Building blocks** for every later UI phase:
  - `Field` and `FormStatus` (a labelled field, and messages announced to screen readers);
  - `lib/labels.ts` (human words for enums);
  - `lib/format.ts` (dates and ETB);
  - `useDismiss` (Escape, outside click, one overlay at a time).
- **App-wide sweeps:** contrast, error colours, dark mode, small text, file pickers, date and price formatting.
- **Applied to the shared chrome** (header, overlays, footer, `RequireRole`, skip link, focus ring, motion) and to every public, learner and account page.
- **Assets:** page titles and robots tags, a site OG image, blue icons and the manifest.
- **An axe gate** in the Playwright suite that keeps all of this from regressing.

## Read first, in order
1. **`plan.md`:** decisions 1–12, then `plan-review.md` round 1. It explains:
   - why the error colours are red-700 and red-600/red-400 (B1);
   - why `FormStatus` has two live regions (S1);
   - why `RequireRole` must not use `useSearchParams` (S2);
   - why fixed-dark surfaces use `text-white/80` (S3).
2. **The approved visual direction:** https://claude.ai/artifact/1KNuTFQ4NeRfsnuAJTxj5k. Its principles ("one hero entrance", "readable and operable") are the tie-breaker for any styling call the plan leaves open.
3. **The Phase 5 plan** (`../2026-10-02-web-p0-fixes/plan.md`), decisions 6–8 and 11. This phase builds on its layout padding, mobile menu backdrop, `overflow-x: clip`, Playwright setup, storage states and local build order.
4. **`web/src/app/globals.css`:** the gray and brand scales are RGB channels that **invert** under `.dark`. That is why `dark:text-gray-300` breaks and why gray-500 works in both modes.
5. **`web/src/app/(teach)/teach/courses/[id]/course-details.tsx:101-138`:** the labelling pattern `Field` generalises.
6. **`web/src/lib/safe-next.ts`:** Phase 3's `roleHome()` and `safeNext()`. Use whatever role-home helper exists after Phase 5; don't add another.

## Decisions already made (don't relitigate)
- **No form or headless-UI library.** Three small primitives and one hook.
- **Contrast is a class sweep**, not a palette change: never edit `--gray-400`.
- **Labels stay English** in `lib/labels.ts`. New chrome strings get `t()` keys in both dictionaries, so the parity test stays green.
- **Motion:** one CSS hero entrance; infinite loops are deleted, not gated; framer stays for below-the-fold reveals (Phase 10 decides its future).
- **Icons:** icons, the OG image and the manifest come from Next file conventions with `ImageResponse`. No binary PNGs committed by hand, and no new image library.
- **Out-of-scope axe violations:** fix them if each is a few lines; otherwise add a scoped per-rule, per-selector exclude naming the owning phase, and log it under Deviations. Never a blanket disable.
- **Role pages:** they get only the mechanical sweeps (contrast, red, dark overrides, file pickers, dates and ETB). Applying `Field`/`FormStatus`/labels to them is Phase 8.

## Gotchas learned while planning
- **Stale line numbers:** they are from `fix/access-control` @ `3de83c3`. Phases 4, 5 and 6 move some of them, so find each site by its code.
- **Live regions:** they must exist before their text changes, or screen readers don't announce them. Test this.
- **Skip link focus:** `<main tabIndex={-1}>` matches `:focus-visible` in Chrome after the skip link moves focus, so give it `focus:outline-none`.
- **Next's metadata merge is shallow per key:** a course page that sets `openGraph` without `images` may drop the inherited site image. The metadata spec checks this.
- **Icon URLs:** confirm the icon route URLs (`/icon/<id>`) in the `next build` route list before hardcoding them in `app/manifest.ts`.
- **Commit the plan folder:** it isn't in `.git/info/exclude` (it isn't security-sensitive), so commit it on your branch as usual.
- **Environment:**
  - Node isn't on PATH: `export PATH="/home/kal/.local/opt/node22/bin:$PATH"`.
  - pnpm installs need `--store-dir /home/kal/snap/code/current/.local/share/pnpm/store/v3`.
  - The secret-guard hook scans untracked files, so never paste `.env` values into notes.
- **Restarting web on :3000:** kill the `next-server` PID. Never use a `pkill -f` pattern, which can match your own shell.
- **Shared working tree:** if you are working in the shared tree, other sessions read it. Reviewers never switch branches.

## How to run
- Build and unit tests: `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`.
- Browser suite: `pnpm -C web exec playwright test`, with the local stack up and web on :3000, following Phase 5's build order.
- API untouched: `pnpm -C api test`.
- Contrast grep (step 4): `grep -rnE "text-gray-(300|400)|text-red-500|text-\[1[01]px\]|dark:(text|bg)-gray-" web/src` → only documented exceptions.

## Branch
Create `feat/ui-foundations` from `origin/main` after Phase 5 (`fix/web-p0`) has merged. If you run it in a separate worktree while another implementer uses the shared tree, use another web port for Playwright and the same build order.

### Parallel run (2026-10-03): who implements, and how the stack is shared
- **Who and where:** the user asked for parallel work, so ethio-planner implements 7a in the worktree `/home/kal/Documents/code/ethi0-web`.
  - The branch `feat/ui-foundations` was created from `origin/main` @ `4b4a64c`, Phase 5's merge, with no upstream.
  - ethio-impl keeps the backend line (6a → 6c → 6b → 9a–9e) in the shared tree `/home/kal/Documents/code/ethi0_learning_platform`.
  - If the planner's context gets heavy, this worktree and branch go to a new `ethio-impl-web` session.
- **This plan folder** was moved out of the shared tree, so the worktree copy is the live one. Commit it first.
- **Stack ownership:** ethio-impl owns the docker infra and the API stack (gateway :4000 and the services). The web implementer never starts, stops, rebuilds, seeds or resets it, and never runs the API e2e scripts.
- **Web ports:** run `next start` from the worktree on **:3200**, with the cold twin on **:3300**. Run Playwright with `E2E_WEB_PORT=3200 E2E_COLD_PORT=3300`.
  - Never use :3000 or :3100, which are ethio-impl's. Playwright's `webServer` reuses a server that's already up, so it would test the wrong code.
  - Stop your own server by the PID listening on :3200, never by a process-name pattern.
- **Stack windows:** before each full Playwright run, message ethio-impl ("stack window, about N min") and wait for its OK. During the window it doesn't restart the stack or run e2e scripts.
  - Only one suite runs at a time, because both suites share the per-IP login limiter.
  - Vitest, typecheck and `next build` need no window.
- **The API runs ethio-impl's current branch** (6a now). If a spec fails only because of a 6a API change, tell ethio-impl. Don't change the API in 7a.
- **Known overlap:** 6a rewrites `web/src/app/(account)/account/password/page.tsx` (`4addd8f`: current password plus a confirmation). Apply `Field` and `FormStatus` to it as planned. Whichever branch merges second resolves the conflict; that's expected to be 6a, which waits for a same-day deploy.
- **Merging:** 7a isn't security-sensitive, so it can merge to main ahead of the backend security phases. As always, push and PR only with the user's OK.

## Definition of done
- Acceptance criteria met.
- Typecheck, vitest, build and the full Playwright suite (with the new a11y, metadata, keyboard and reduced-motion specs) pass.
- `pnpm -C api test` is still green.
- Before/after screenshots are saved for the user.
- Plan checklist ticked and deviations logged.
- Then ask ethio-plan-review for code review.
