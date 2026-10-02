# Handoff: Phase 3, access control and exploitable web holes

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 2, see [plan-review.md](plan-review.md))
Code review goes to: ethio-reviewer (size L)

## What to build
Institution membership becomes consent-based: admins invite, users accept in their own session, and institution admins can never touch platform role, status or sessions. Also: escape course JSON-LD, validate the login `next` parameter, make Cancel on the admin suspend/ban prompt cancel, and refuse to boot in production on missing or dev-default secrets.

## Read first, in order
1. `plan.md` decisions 1–13 and the API contract. The round-1 review explains B1 (why accept-invite stays password-only: it is shared with staff onboarding) and S3 (no email enumeration).
2. `api/services/auth/src/profiles.controller.ts:199-329`: the membership endpoints you're rewriting.
3. `api/services/auth/src/auth.service.ts:258-306,365-379`: invites, accept-invite, `assertActive`.
4. `api/services/auth/src/internal.controller.ts:38-48` and `api/services/course/src/course.service.ts:329-336,696-716,747-755,772` plus `revision.service.ts:186-210`: institution routing and notifications (decisions 5, 5a).
5. `web/src/app/(teach)/institution/page.tsx`, `web/src/app/(public)/accept-invite/page.tsx`, `web/src/app/(public)/login/page.tsx`, `web/src/components/GoogleSignInButton.tsx`, `web/src/app/(public)/courses/[id]/page.tsx:60-90`, `web/src/app/(admin)/admin/page.tsx:310-320`.
6. `api/packages/common/src/bootstrap.ts`, `config/env.ts`, `gateway/src/main.ts:50-70`: where `assertProductionConfig` plugs in.
7. `api/services/course/src/course.service.spec.ts:20-133`: the in-memory repo, transaction and bus fakes to reuse in auth tests.

## Decisions already made (don't relitigate)
- Membership status on `institution_instructors` (varchar + CHECK), backfill `active`, default `invited`, two unique indexes in a separate concurrent migration.
- New-email placeholder is a LEARNER; the role changes only on explicit acceptance on `/account/invites`.
- `POST /auth/accept-invite` sets the password only (+ `assertActive`) and returns `pending_institution_invites`.
- Same 201 for every invited email, staff included; `invited` rows show only the typed email.
- `setInstructorStatus` changes only the membership row and audits.
- Internal lookup returns active memberships only; submit notifications go to the owner of `course.institution_id`.
- `safeNext` and `jsonLdScript` helpers in `web/src/lib/`; admin cancel is a null check (the dialog component comes later).
- `assertProductionConfig` is a no-op outside production; it names variables, never values; financial rules wait for Phase 4.

## Gotchas learned while planning
- **Secrets in docs:** a secret-guard commit hook scans every untracked file for values from `api/.env`. Refer to secrets by variable name only, in code comments, tests and docs. Tests that need a dev default should import or construct it, not paste the literal into a new doc. Keep the dev-literal denylist in code (`production-config.ts`) only.
- **Public repo:** this plan folder describes unfixed holes. It is in `.git/info/exclude` until your branch exists. When you create `fix/access-control`, remove that line from `.git/info/exclude` and commit the folder on your branch. Push only when the user can merge and deploy the same day (rollout step 2).
- **23505** (unique violation) isn't mapped by `DbErrorFilter` (only 22P02). Map the "active elsewhere" case to 409 explicitly in the accept handler.
- **Gateway routes:** `/profiles/**` already requires a JWT (`gateway/src/routes.ts:45`); the add-instructor POST joins the `INVITES` rate class (`gateway/src/rate-policy.ts:50`).
- **Contracts:** add `InstructorInvited` to `@ethiopialearn/contracts` and a handler in the notification service next to `InstructorLinked` (`notification.service.ts:139-145`). Also update the `StaffInvited` copy for institution invites to name the institution.
- **docker compose `--profile full`** runs the production image with dev values; add `NODE_ENV: development` to `x-service-env` or the fail-fast stops it.
- Same environment notes as Phase 2's handoff: node PATH export, pnpm `--store-dir`, Postgres on 55432, restart the stack with `scripts/stop-backend.sh && scripts/start-backend.sh` after rebuilding, no `pkill -f` patterns that match your own shell.
- **Production is off-limits.** Rollout step 1 (duplicate check, Render env check, affected-user query) is for the user.

## How to run
- Build and test: `pnpm -C api build && pnpm -C api test && pnpm -C api db:check`
- Web: `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`, then restart `next start` on :3000 (kill the `next-server` PID, not a pattern).
- E2E: `node scripts/e2e-institution.mjs` (new; add it to the CI e2e job before the smoke step, which hammers the login limiter), plus `demo-seed.mjs`, `e2e-revisions.mjs` and `e2e-smoke.mjs`.

## Branch
Create `fix/access-control` from `origin/main` if Phase 2 has merged, otherwise from `feat/schema-migrations` (rebase later). Tell ethio-reviewer which base to diff against.

## Definition of done
- Acceptance criteria met.
- api build, tests and `db:check` pass; web typecheck, tests and build pass; all e2e scripts pass, including the new institution one.
- Both migrations apply on a fresh DB and on the existing local DB, and `migration:revert -t none` round-trips.
- Plan checklist ticked, with deviations logged.
- Then request code review from ethio-reviewer.
