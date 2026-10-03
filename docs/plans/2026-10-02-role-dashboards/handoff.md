# Handoff: Phase 8, UI polish II (role dashboards), in two parts

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 1 with S1–S3 folded in, plus the 2026-10-03 drift check D1–D8, see [plan-review.md](plan-review.md))
Code review goes to: ethio-plan-review (size M), one review per part

## What to build
Phase 7a built the building blocks; this phase applies them to every role page:
- money-moving and destructive actions ask first in one native `<dialog>`, and never fail silently;
- charts draw;
- admin lists page and search by name;
- every control has a name;
- phones work;
- instructors can leave an institution.

It ships as two PRs:
- **8a:** the shared dialog, the admin console, learner and account dialogs, and Leave institution;
- **8b:** educator, institution, QA and preview pages, plus the mobile pass.

## Read first, in order
1. `plan.md`:
   - "Split", which part owns which steps and acceptance criteria;
   - decisions 1–3: the dialog, outcomes, the confirm list with the S1 hold-rule copy and the S2 bulk-seat confirm;
   - decision 9: Leave.
2. `plan-review.md` round 1, especially S1, the Phase 4 hold rules in `payout.service.ts`, and S3, what `showModal()` does and doesn't trap. Then its "Drift check" section (D1–D8), already folded into the plan.
3. What 7a shipped, read by name, since the plan assumes them:
   - `components/form/Field.tsx`, `FormStatus.tsx`, `useFormStatus`;
   - `lib/labels.ts`, `lib/format.ts`, `lib/use-dismiss.ts`;
   - the a11y spec and its storage states.
4. `web/src/app/(admin)/admin/page.tsx` and `growth-tabs.tsx`, which change most in 8a. The private `SearchPicker` (`:161-204` at `2cdccf9`) moves out.
5. `api/services/auth/src/membership.service.ts` (`setStatus`, `myInvites`, `accept`, `decline`) and `admin.controller.ts` `list`. Also `api/services/financial/src/refund.service.ts` `listPending`.
6. **8b:** `teach/courses/[id]/page.tsx` and its siblings, `teach/analytics/page.tsx`, `components/Bars.tsx`, `(admin)/preview/[id]/page.tsx`, and `institution/*`.

## Decisions already made (don't relitigate)
- **One dialog:**
  - native `<dialog>` with `showModal()`, behind `useConfirm()`, returning `false | { reason }`;
  - the returned function is named `ask`, so the native-dialog grep stays meaningful;
  - `.focus()` after `showModal()`; no headless UI library.
- **Outcomes:** 7a's `FormStatus` per card; no toast system.
- **`SearchPicker`:** a combobox in `components/`, with a 300 ms debounce. Learner pickers send `&role=learner`.
- **Admin user search:** name or email, wildcards escaped, `q` ≤ 100. No index.
- **Pagination:** offset `Pager` on Users and Payments only. The API already pages.
- **Admin tabs:** `?tab=` through `useSearchParams` inside `Suspense`, with ARIA tabs and roving `tabIndex`.
- **Leave:** reuses `removed` with the reason "Left the institution". No migration, no owner notification. The same 404 for "not yours" and "not leavable".
- **Payees** show the role label and a short id. Names are Phase 9.

## Gotchas learned while planning
- **The hold rules (S1):**
  - resolving a fraud flag releases fraud holds only when the payee has no open flag left;
  - payouts over the KYC threshold go to `kyc_required`;
  - `release()` clears any hold, KYC included.
  - The dialog copy must say exactly that.
- **Vitest runs happy-dom, which has `showModal()`/`close()`:** no stub. Tests dispatch `cancel` for Escape. Playwright tests the real dialog. Don't assert a full Tab trap (S3, drift D5).
- **Phase 5 specs this phase must change, not duplicate (drift D1, D2):**
  - `web/e2e/admin.spec.ts` already exists; rewrite it (the Users tab and the dialog replace its button and native `prompt`), and never suspend a real seeded user: stub `/admin/users/*/status` with `page.route` for the Confirm case;
  - the 375 px overflow checks go into `layout.spec.ts` with `horizontalOverflow()`, because `overflow-x: clip` on html and body hides overflow from a plain `scrollWidth` check.
- **From 6a and 7b (drift D6–D8):** the leave route uses `@UuidParam('id')` (6a's `route-params.spec.ts` fails a bare `@Param`); extend 6a's `coupon-manager.test.tsx` (add `ready` to its mock); analytics errors use 7b's `PanelError`.
- **Next 14.2 and `useSearchParams`:** without a `Suspense` boundary it fails `next build` on static pages (7a round-1 S2). The editor's `ManageCourseFromUrl` shows the pattern.
- **Line numbers** in the plan are from `2cdccf9`. Phases 5, 6a, 6c, 6b, 7a and 7b edit these files first, so re-find each site by its code.
- **Overlapping fields:** 6a adds the coupon "Uses per learner" field and 6c the bank-transfer "Bank reference" field. Both become `Field`s here, so keep their behaviour.
- **Playwright:** no new logins. Reuse Phase 5's saved storage states, because the `auth-strict` budget comment in `playwright.config.ts` counts every login.
- **Screenshots:** put them in `docs/plans/2026-10-02-refinement-audit/screenshots/after-phase8/` (git-ignored), with file names matching the before set.
- **This plan folder isn't security-sensitive and isn't excluded.** Commit it on your 8a branch. Stage paths explicitly, because other plan folders are untracked in the shared tree.
- **Environment:**
  - node PATH export;
  - Postgres on 55432;
  - the pnpm `--store-dir` flag;
  - restart the backend with `scripts/stop-backend.sh && scripts/start-backend.sh`;
  - restart web by killing the `next-server` PID, never with a `pkill -f` pattern that matches your own shell.

## How to run
- **Web:** `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`.
- **API:** `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check`. There's no migration, so no drift is expected.
- **Browser:** Phase 5's build order, then `pnpm -C web exec playwright test` with the stack up and web on :3000.
- **API e2e:** `node scripts/e2e-institution.mjs`, which includes the new leave step.

## Branch
- **8a:** create `feat/role-dashboards-a` from the tip of the stack when this phase starts. Expect `feat/public-learner-pages`, or `origin/main` if 7b has merged.
- **8b:** create `feat/role-dashboards-b` from `feat/role-dashboards-a` once 8a's code review is approved, or earlier if you prefer and rebase later.
- Don't push either one until everything below it has merged. Then merge `origin/main` in.

## Definition of done (each part)
- That part's acceptance criteria in "Split" are met.
- Web and API gates pass, and the Playwright suite passes locally.
- Screenshots are saved.
- That part's Progress section is ticked, with deviations logged.
- Then request code review from ethio-plan-review: "Ready for code review (Phase 8a, round 1) …".
