# Phase 3: Access control and exploitable web holes

Status: done. Merged to main via PR #20 (merge `04590af`, 2026-10-03).
Size: L (sessions: 4 — ethio-impl implements, ethio-reviewer reviews code)
Base branch: `origin/main` once Phase 2 (`feat/schema-migrations`) has merged; until then branch from `feat/schema-migrations` and rebase. · Feature branch: `fix/access-control`
Roadmap: [../2026-10-02-refinement-audit/roadmap.md](../2026-10-02-refinement-audit/roadmap.md) (this phase replaces the roadmap's "backend security and money integrity" row; payments move to Phase 4) · Findings: P0-03, P0-01, P0-02, P0-10, P1-02

## Goal
Close the holes an outsider can exploit today, before any polish:
- **P0-03:** anyone can self-sign-up as an institution admin and then change any user's role and ban or unban them platform-wide, by email.
- **P0-01:** educator-written course text is emitted unescaped inside the course page's JSON-LD script tag (stored XSS on public pages).
- **P0-02:** the login `next` parameter is pushed to the router unchecked (open redirect and `javascript:` execution after login).
- **P0-10:** pressing Cancel on the Suspend/Ban reason prompt still suspends or bans.
- **P1-02:** production boots with hardcoded dev secret fallbacks and an opt-in internal-token check; one missing env var exposes every service.

Acceptance criteria:
- An institution admin can only invite. Anyone's role changes only when that user accepts the named institution's invite in their own session (new users first set a password through the emailed setup link, which stays a password-only step and keeps working for staff onboarding). Institution admins can suspend or remove a membership, which never touches `users.status`, `users.role` or sessions.
- Course JSON-LD can't break out of its script tag, whatever the course text contains.
- After login (password or Google), only same-origin relative paths are followed; anything else goes to the role's home.
- Cancelling the suspend/ban prompt sends no request (admin page). The institution page has no platform-ban controls at all.
- In production (`NODE_ENV=production`), every service refuses to boot when a required secret is missing, short or a known dev value, or when the internal-token check is off, and the error names the variables, never the values. Local dev and CI e2e keep working unchanged.

## Non-goals
- Payment, wallet, payout and webhook fixes (Phase 4), including the financial-specific production checks (`CHAPA_MODE`, `CHAPA_WEBHOOK_SECRET`) and the mock-checkout guard (P1-03).
- Admin approval for institution_admin signups (a product decision; after this phase a self-signed-up admin can't affect other accounts).
- Splitting the shared `password_resets` token table between invites and resets (both prove email ownership; harmless).
- RequireRole `?next=` and dead-end auth cards (P1-33), role-aware landing for institution admins after login (P0-11) and the confirm-dialog component (P1-42) — Phases 5–8. This phase only fixes the cancel bug with a null check.
- Security headers / CSP (Phase 10), token storage (P1-07).
- A member-initiated "Leave institution" action (plan-review N3); admins can remove members. Deferred to the role-dashboards polish phase.
- Rewriting past data. Users already harmed by P0-03 are found with a read-only query (Rollout) and fixed by the user/admin.

## Current state
(Line numbers from `origin/main`; the Phase 2 branch only touches `app.module.ts`, `database.ts` and `migrations/`.)
- **Self-signup:** `api/services/auth/src/dto.ts:32` `SELF_SIGNUP_ROLES` includes `institution_admin`; `profiles.controller.ts:199-209` creates an institution.
- **`addInstructor`** `profiles.controller.ts:224-296`: ownership check `:229`. New email (`:236-260`): creates a user with role EDUCATOR, random password, `email_verified_at=now`, `must_change_password`, an educator profile, and a 7-day invite token in `password_resets` (`auth.service.ts:258-269`), then publishes `StaffInvited` with `/accept-invite?token=`. Existing email (`:261-288`): rejects staff and institution owners, **switches a learner to EDUCATOR immediately** (`:268-271`), publishes `InstructorLinked` (inbox + email "you're now an instructor", `notification.service.ts:139-145`). Check-then-insert duplicate check (`:290-294`); no audit row.
- **`institution_instructors`** `entities.ts:139-153`: id, `institution_id` (indexed), `user_id` (not indexed), `role_in_org`. No status, no unique constraint, no timestamps.
- **`listInstructors`** `:298-309`: one user lookup per row, shows `users.status`.
- **`setInstructorStatus`** `:312-329`: writes `users.status` / `status_reason` platform-wide (`:325-327`), can reverse an admin ban, no audit, no session revocation. Admin's own `setStatus` (`admin.controller.ts:50-64`) audits and revokes sessions.
- **New-user accept:** `web/src/app/(public)/accept-invite/page.tsx:26` → `GET /auth/invite/:token` (`auth.service.ts:272-280`); `:40` → `POST /auth/accept-invite` (`auth.service.ts:286-306`), which sets the password and issues tokens without `assertActive` (`:372-379`).
- **Course routing:** `course.service.ts:329-336` stamps `institution_id` from `resolveInstitution` (`:747-755`) → auth `internal.controller.ts:38-48`, `findOne({user_id})`: first membership in any institution, no status check. Submit then goes to institution review (`course.service.ts:696`).
- **Web institution page** `web/src/app/(teach)/institution/page.tsx:83-178`: lists `users.status` with Suspend/Ban/Reactivate (`:124-141`, POST `/status` at `:93-95`, `prompt(...) || undefined`).
- **Admin page** `web/src/app/(admin)/admin/page.tsx:315`: `reason = prompt(...) ?? ''`, then the request is sent even on Cancel.
- **JSON-LD** `web/src/app/(public)/courses/[id]/page.tsx:89`: `dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}`, with educator `name`/`description` at `:64-66`.
- **`next`** `web/src/app/(public)/login/page.tsx:31-33` and `web/src/components/GoogleSignInButton.tsx:66`: `router.push(next)` unchecked (signup passes `next` to the Google button at `signup/page.tsx:126`).
- **Production config:** `JWT_SECRET` is required in gateway (`gateway/src/main.ts:54`) and auth (`auth.service.ts:365`); `certificate.service.ts:185` falls back `CERT_SIGNING_SECRET` → `JWT_SECRET` → a hardcoded literal (the `.env.example` default for `JWT_SECRET`). `INTERNAL_API_TOKEN` defaults to `''` (fails closed, no length/dev check) at `gateway/src/main.ts:61,194`, `internal.guard.ts:14`, `internal-client.ts:23`, `bootstrap.ts:25`. `REQUIRE_INTERNAL_TOKEN` is opt-in (`bootstrap.ts:24`, `envBool(…, false)`); `render.yaml:133-134` sets it true. S3 keys fall back to the local MinIO default credentials (`packages/storage/src/index.ts:88-89`). `render.yaml` sets `NODE_ENV=production` and `generateValue: true` for `JWT_SECRET`, `CERT_SIGNING_SECRET`, `INTERNAL_API_TOKEN` (`:19-20,49-54`); the API Dockerfile sets `NODE_ENV=production`. CI e2e copies `api/.env.example` (`NODE_ENV=development`). `docker compose --profile full` runs the production image with dev values (`docker-compose.yml:7-30`).
- **Tests:** nothing covers `profiles.controller`, invites, `env.ts` or bootstrap. Auth has only `auth.session.spec.ts`. Service specs use hand-rolled `jest.fn()` mocks; `course/src/course.service.spec.ts:31-133` has a reusable in-memory repo, transaction and bus fake. Web uses vitest + Testing Library.

## Design and key decisions
### A. Institution membership (P0-03)
1. **Membership gets a lifecycle.** `institution_instructors` gains `status` (`invited | active | suspended | removed | declined`, varchar + CHECK rather than a Postgres enum, per the Phase 2 note on shared enum types), `status_reason`, `invited_by`, `created_at`, `accepted_at`. Existing rows are backfilled `active` (they are live affiliations today); the column default is `invited`. Constraints: `UNIQUE (institution_id, user_id)` and a partial `UNIQUE (user_id) WHERE status = 'active'` (one routing institution per instructor; it also indexes the internal lookup). Rejected: a separate invites table (the row already is the relationship; a status is simpler).
2. **`addInstructor` never changes `users.role` or `users.status`.** It upserts the membership as `invited` (re-inviting a `declined`/`removed` row resets it to `invited`), audits it, and:
   - existing user → publishes a new `InstructorInvited` contract event (inbox + email: "<Institution> invited you to teach with them. Log in to accept."), linking to `/account/invites`.
   - new email → still creates the placeholder account and the `StaffInvited` setup link, but **as a LEARNER**, so a role only ever changes on acceptance, the same rule for everyone. The setup email names the institution ("<Institution> invited you to teach on EthiopiaLearn. Set a password, then accept the invitation."). Rejected: keeping today's EDUCATOR placeholder (it is a role change without consent).
   - No enumeration (plan-review S3): staff and institution-owner emails get the same 201 and an `invited` row like anyone else (acceptance rejects them); responses and the list show only the email the admin typed for `invited` rows, and name and role only after acceptance; no `new_account` flag. The add endpoint joins the gateway `INVITES` rate class (`gateway/src/rate-policy.ts:50`).
3. **Acceptance.**
   - Existing users, in their own session: `GET /profiles/me/institution-invites`, `POST /profiles/me/institution-invites/:id/accept`, `POST …/:id/decline` (covered by the existing JWT rule for `profiles`, `gateway/src/routes.ts:45`). Accept runs in one transaction: `UPDATE institution_instructors SET status='active', accepted_at=now() WHERE id=$1 AND user_id=$me AND status='invited'` must affect 1 row (else 404/409); re-read the user and reject staff and institution_admin; upgrade learner → educator (an educator keeps its role); ensure an educator profile exists; audit. After commit publish `InstructorLinked`. The web then calls `/auth/refresh` (which re-reads the role, `auth.service.ts:200-213`) and goes to `/teach`.
   - New users: the emailed setup link (`POST /auth/accept-invite`) only sets the password, as today, and now calls `assertActive` so a banned placeholder can't log in through it. It touches no membership, so staff onboarding (`admin.controller.ts:75-97`, same endpoint) is unchanged and a cancelled invitee can still set a password. The response adds `pending_institution_invites` (a count); when it is above 0 the accept page sends the user to `/account/invites`, where they accept the named institution explicitly. One consent path for everyone. Rejected: activating a membership from the setup link (it breaks staff onboarding and can bind consent to the wrong institution, plan-review B1).
   - A user already `active` in another institution hits the partial unique index; map that 23505 to 409 "already teaching with another institution" (the global `DbErrorFilter` only maps 22P02).
   - Existing independent courses stay independent; only courses created after acceptance route to the institution.
4. **`setInstructorStatus` changes only the membership row.** Allowed: `active ↔ suspended`, any → `removed`, `invited` → `removed` (cancel invite). Never `invited → active`. It writes an audit row and never touches `users.status`, `users.role` or sessions. The platform-wide suspend/ban stays admin-only (`admin.controller.ts`).
5. **Internal lookup** (`internal.controller.ts:38-48`) returns only an `active` membership, so a suspended or removed instructor's new courses become independent (they are still platform educators). Courses created while suspended stay independent after reactivation. Existing institution courses keep their `institution_id` and stay with the institution after the member is suspended or removed.
5a. **Submit notifications follow the course, not the member** (plan-review S1): the institution-review notification recipient is the owner of `course.institution_id`, not the instructor's current membership (`course.service.ts:716`, `revision.service.ts:210`). This keeps the queue (scoped by `course.institution_id`, `course.service.ts:772`) and the notification in agreement.
6. **`listInstructors`** returns membership status and loads users with one `In()` query.
7. **Web.** Institution dashboard rows by status: Invited → Cancel invite; Active → Suspend / Remove; Suspended → Reactivate / Remove; Declined or Removed → Re-invite. Invite confirmation copy: "Invitation sent. They need to accept it." No platform ban/suspend controls on this page. New page `web/src/app/(account)/account/invites/page.tsx` (learners and educators) lists pending invites with Accept / Decline; a small banner on `/dashboard` and `/teach` links to it when any are pending. The new-user accept page redirects by the returned role.

### B. Web holes (P0-01, P0-02, P0-10)
8. **JSON-LD escaping:** a tiny `jsonLdScript(obj)` helper in `web/src/lib/` returning `JSON.stringify(obj).replace(/</g, '\\u003c')` (the pattern from the Next.js docs; `<` is still valid JSON for crawlers). Used at `courses/[id]/page.tsx:89` and anywhere else JSON-LD is emitted (grep).
9. **`safeNext(next, fallback)`** in `web/src/lib/`: accepts only strings that start with a single `/`, not `//` or `/\`, contain no control characters, and parse to the same origin with `new URL(next, origin)`; otherwise returns the fallback (the role's home). Used in `login/page.tsx` and `GoogleSignInButton.tsx`. Rejected: an allowlist of routes (every new page would need adding).
10. **Cancel means cancel:** `admin/page.tsx:315`: `const r = prompt(...); if (r === null) return;`. The institution page call goes away with decision 7. The shared confirm dialog stays in Phase 8.

### C. Production config fail-fast (P1-02)
11. **`assertProductionConfig({ service, required })`** in `api/packages/common/src/config/production-config.ts`, exported from the package. No-op unless `NODE_ENV === 'production'`. Collects every problem and throws one error listing variable names and the rule each broke, never values. Rules: present; length ≥ 32 for generated secrets; not equal to any known dev default (the values `api/.env.example` ships for `JWT_SECRET`, `CERT_SIGNING_SECRET`, `INTERNAL_API_TOKEN`, `S3_ACCESS_KEY`/`S3_SECRET_KEY` and the seed password; keep that list in code next to the check, not in docs); `REQUIRE_INTERNAL_TOKEN` not `false`; URL variables (`WEB_URL`, `GATEWAY_PUBLIC_URL`) not localhost. Called first in `bootstrapService` (`bootstrap.ts:14`) through a new `requiredSecrets` option, and in the gateway's `bootstrap()`.
    - all services: `INTERNAL_API_TOKEN`; gateway and auth: `JWT_SECRET`; outcomes: `CERT_SIGNING_SECRET` (must differ from `JWT_SECRET`); services using storage: `S3_ACCESS_KEY`, `S3_SECRET_KEY` when `S3_ENDPOINT` is set. Phase 4 adds financial's rules.
12. **Secure defaults:** `REQUIRE_INTERNAL_TOKEN` defaults to `NODE_ENV === 'production'` (`bootstrap.ts:24`). Remove the literal fallback at `certificate.service.ts:185` (production already sets the generated `CERT_SIGNING_SECRET` per `render.yaml`; rollout step 1 confirms it before merge, because a different secret would invalidate existing certificate UIDs). Storage keeps its local MinIO default for dev only; production is covered by rule 11.
13. **Keep local full-stack working:** add `NODE_ENV: development` to `x-service-env` in `docker-compose.yml`, since `--profile full` runs the production image with dev values.

## Data model and migrations
Two auth migrations (Phase 2 pattern; the entity changes match them so `db:check` stays at 0). Split so a failed index build can't leave half-applied columns behind an unrecorded migration (plan-review S2):
- **Migration 1 (transactional):** `ALTER TABLE auth.institution_instructors ADD COLUMN status varchar(16) NOT NULL DEFAULT 'active'` (backfills existing rows), then `ALTER … ALTER COLUMN status SET DEFAULT 'invited'`; `CHECK (status IN (…))`; `status_reason varchar(500) NULL`, `invited_by uuid NULL`, `created_at timestamptz NOT NULL DEFAULT now()`, `accepted_at timestamptz NULL`.
- **Migration 2 (`transaction = false`):** `UNIQUE (institution_id, user_id)` and the partial `UNIQUE (user_id) WHERE status = 'active'`, built `CONCURRENTLY` (drop-if-exists first, one statement per query), per Phase 2's decision 8; drop the now-redundant single-column `institution_id` index in the same migration.
- Both unique indexes fail if production already has duplicates, so rollout step 1 runs a read-only duplicate check first.
- `down()`: drop the indexes and columns (local only; the data they hold is new).
- Table size: a handful of rows; no locking concern.

## API contract
| Endpoint | Auth | Request | Responses |
|---|---|---|---|
| `POST /institutions/:iid/instructors` (changed) | institution_admin owning `:iid` | `{ email, name? }` | 201 `{ membership: {id, status:'invited', email} }` for every address, staff and owners included; 403 not owner; 409 already active here |
| `POST /institutions/:iid/instructors/:uid/status` (changed) | owner | `{ status: 'active'\|'suspended'\|'removed', reason? }` | 200 membership; 400 illegal transition; 404 not a member |
| `GET /institutions/:iid/instructors` (changed) | owner | — | 200 `[{ membership_id, status, status_reason, email, user?: {id,name,role} }]` (`user` only for rows that were ever accepted) |
| `GET /profiles/me/institution-invites` (new) | any signed-in user | — | 200 `[{ id, institution:{id,name}, invited_at }]` |
| `POST /profiles/me/institution-invites/:id/accept` (new) | the invitee | — | 200 `{ role }`; 404 not yours/not pending; 409 active elsewhere; 403 staff/institution_admin |
| `POST /profiles/me/institution-invites/:id/decline` (new) | the invitee | — | 200; 404 |
| `POST /auth/accept-invite` (changed) | invite token | `{ token, password }` | 200 tokens + `{ role, pending_institution_invites }` (sets the password only; no membership change); 403 banned/suspended |

Errors use the existing envelope. New event `InstructorInvited { user_id, institution_id, institution_name, email }` in `@ethiopialearn/contracts`, handled by the notification service (inbox + email).

## Steps
- [x] 1. Branch per the base rule above.
- [x] 2. `assertProductionConfig` + tests; wire into `bootstrapService` and the gateway; `REQUIRE_INTERNAL_TOKEN` production default; remove the certificate literal fallback; `x-service-env` `NODE_ENV: development`. · `pnpm -C api test`; boot one service locally with `NODE_ENV=production` and dev values → refuses with names only.
- [x] 3. Auth migration + entity changes; `db:check` 0 on a fresh DB and on the existing local DB.
- [x] 4. Membership service logic (decisions 2–6) + contracts event + notification handler; remove the role/status writes. · Unit tests (see Test plan).
- [x] 5. Accept/decline endpoints, gateway routes and rate class, `acceptInvite` changes.
- [x] 6. Web: institution dashboard states, `/account/invites` page + banners, accept-invite redirect by role; `jsonLdScript`, `safeNext`, admin cancel fix. · vitest.
- [x] 7. Live check on the local stack, scripted (`scripts/e2e-institution.mjs`, added to CI e2e): self-signup institution admin → invite an existing learner → learner's role, status and sessions unchanged → suspend attempt only changes the membership → learner accepts on `/account/invites` → role educator, membership active → admin suspends membership → learner can still log in and their new course is independent.
- [x] 8. Full gate: api build + tests + `db:check`, web typecheck + tests + build, all e2e scripts.
- [ ] 9. Code review by ethio-reviewer (APPROVED round 2); user approves push/PR; rollout below.

## Test plan
- **Membership (auth, unit, codebase mock style):** invite existing learner → membership `invited`, user row untouched, `InstructorInvited` published; invite new email → placeholder LEARNER + `StaffInvited` naming the institution; staff/owner email → same 201 response shape as anyone, and accepting it is rejected; invite responses and list never show name/role for `invited` rows; re-invite a declined row; accept → role educator, membership active, one `InstructorLinked`; double accept → second is 404/409, one event; accept as staff → 403; accept while active elsewhere → 409; decline; `setInstructorStatus` transitions allowed/denied and never writes `users`; internal lookup ignores non-active rows; `acceptInvite` sets the password only (membership untouched), returns `pending_institution_invites`, refuses a banned user, and **staff onboarding through accept-invite still works** (QO invite → set password → role quality_officer); submit notifications go to the owner of `course.institution_id` even after the instructor is removed.
- **Production config:** table tests for missing, short, dev-literal values and `REQUIRE_INTERNAL_TOKEN=false` (throws, message has names, not values); no-op outside production; certificate service throws without `CERT_SIGNING_SECRET` instead of using a literal.
- **Web (vitest):** `safeNext` with `/teach`, `//evil.com`, `/\evil.com`, `https://evil.com`, `javascript:alert(1)`, `/%2F%2Fevil.com`, control characters, empty; `jsonLdScript` output contains no `</script` for a description containing a closing script tag and still parses as JSON; admin cancel sends no request; institution row actions per status; invites page accept/decline.
- **E2E:** `scripts/e2e-institution.mjs` (step 7) in CI.
- Commands: `pnpm -C api build && pnpm -C api test && pnpm -C api db:check`; `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`; `node scripts/e2e-institution.mjs` plus the existing e2e scripts.

## Rollout and ops
Steps that read or change production are done by the user, or by a session only on the user's explicit request.
1. **Before merge (read-only, production):** (a) `SELECT institution_id, user_id, count(*) FROM auth.institution_instructors GROUP BY 1,2 HAVING count(*) > 1` and the same per `user_id` → must be empty, or the unique indexes fail at boot; (b) in the Render dashboard, confirm `JWT_SECRET`, `CERT_SIGNING_SECRET`, `INTERNAL_API_TOKEN` are set on every service, `REQUIRE_INTERNAL_TOKEN` is not `false`, and `WEB_URL` and `GATEWAY_PUBLIC_URL` (hand-set in the shared env group) are set and not localhost (the fail-fast would otherwise stop the deploy); (c) list possibly affected users: members whose `users.status <> 'active'` with no admin `user.banned`/`user.suspended` audit row, and learners upgraded to educator through a membership. Past role changes were never audited, so this list is a starting point for the user's own review.
2. Push the branch and open the PR only when it can be merged and deployed the same day: once public, the diff reveals the holes (plan-review N1). Merge and deploy. If a service refuses to boot, its log names the variable; set it in Render and redeploy.
3. Post-deploy check: as a throwaway institution admin, inviting a throwaway learner changes nothing on the learner until they accept.
- Logging: membership changes and acceptances write audit rows; the fail-fast error is one line per variable.

## Risks and open questions
- **Render generated-secret length (unverified):** if a generated value is shorter than 32 characters, the service refuses to boot. Rollout step 1(b) checks it; the minimum can drop to 24 if needed (still far above the dev literals).
- **Pending-invite UX for new users:** two steps (set a password, then accept on `/account/invites`). Accepted for one consent path; the accept page redirects straight to the invites screen so it reads as one flow.
- **Course routing change:** existing institution courses keep their `institution_id`; new courses route by the instructor's active membership (decision 5), and submit notifications follow `course.institution_id` (decision 5a).

## Progress and deviations (implementer)

Branch `fix/access-control`, cut from `feat/schema-migrations` (`9769a3f`; Phase 2 isn't merged yet): review with `git diff feat/schema-migrations...fix/access-control`. Commits: `71e72c9` production config, `bb42608` migrations, `da92345` membership backend, `bdf1e4a` web holes, `e7ae0f7` membership web, `3de83c3` e2e in CI + docs, `b31bb51` code-review round 1 B1 (`safeNext` dot segments).

### How to rerun the checks
- API: `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check` → 12/12 built, 37 suites / 736 tests, typecheck clean, no drift. New specs: `packages/common/src/config/production-config.spec.ts`, `services/auth/src/membership.service.spec.ts` (invite, list, accept, decline, status transitions, internal lookup, accept-invite incl. staff onboarding), plus cases in the certificate, course, revision, notification and rate-policy specs.
- Web: `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build` → clean, 18 files / 300 tests, build OK (after round 1). New tests: `lib/safe-next.test.ts`, `lib/json-ld.test.ts`, `(admin)/admin/page.test.tsx` (Cancel sends nothing), `(teach)/institution/instructor-manager.test.tsx`, `(account)/account/invites/invites-list.test.tsx`, `(public)/accept-invite/page.test.tsx`.
- E2E, in CI order on a throwaway database with `api/.env.example` values (no real SMTP/Chapa/Groq): seed, `start-backend.sh`, `/health` waits, `db:check`, `demo-seed`, `e2e-revisions`, `e2e-institution` (new, 20 checks), `E2E_CHECK_RATE_LIMIT=1 e2e-smoke`.
- Migrations: on a fresh DB all four auth migrations apply, `db:check` 0; `migration:revert` ×2 then `migration:run` round-trips; with a duplicate (institution, user) pair the columns migration records and the index migration fails with "could not create unique index …" leaving an INVALID index; after removing the duplicate a rerun drops it and builds both (S2 scenario). Existing rows backfill `active` + `accepted_at`, the default is `invited`, the CHECK rejects other values. The local dev DB had no membership rows and applied both cleanly.
- Production boot check: `NODE_ENV=production` outcomes with the dev values refuses to start and lists 6 variables by name, no values.

### Deviations
- **The dev-value denylist holds SHA-256 digests, not the literals.** The secret-guard commit hook rejects any change containing a value from a local `.env` file, so the literals can't be committed anywhere; digests keep the same check. `production-config.spec.ts` reads `api/.env.example` and `docker-compose.yml` and asserts each shipped dev value is recognised, so the list can't silently drift.
- **The status route takes the membership id** (`POST /institutions/:iid/instructors/:membershipId/status`), not the user id. Invited rows don't expose a user id (it could be looked up through profile endpoints and reveal who has an account), and the web needs an id to cancel an invitation.
- **Existing memberships are backfilled `accepted_at = created_at`** besides `status = 'active'`, so "ever accepted" is simply `status <> 'invited' AND accepted_at IS NOT NULL` (the list shows name and role only then). Re-inviting clears `accepted_at`.
- **A new email without a name** gets a placeholder named after the email's local part instead of a 400, which would have told the admin the address has no account.
- **Re-invites and staff.** Re-inviting an `invited`, `declined` or `removed` row resets it to a fresh invitation. An account that never set its own password (`must_change_password`) gets a fresh setup link (StaffInvited naming the institution) rather than an in-app invitation. Staff and institution owners get the same 201 and row but no email (acceptance refuses them anyway).
- **Status codes:** illegal transitions are 400 as in the contract; inviting someone already active or suspended here is 409; `acceptInvite` on a suspended/banned account is 401 (the existing `assertActive`, same as login) rather than the contract's 403.
- **`REQUIRE_INTERNAL_TOKEN`:** any value other than unset, `true` or `1` counts as off (`envBool` treats everything else as false). The URL rule applies to every service, since the shared env group sets both URLs.
- **Web extras:** `roleHome()` next to `safeNext()` replaces three copies of the role → home mapping; `refreshSession()` is exported from `lib/api.ts` for the invites page; the accept-invite page's copy no longer says "invited as learner" for institution invitees, and its password label is now associated with the input (the test found it wasn't).
- **e2e-institution** self-signs-up the institution admin and learner and has the seeded platform admin verify them (`POST /admin/users/:id/verify-email`), since a test run has no inbox. It retries a 429 on `/auth/*` after `Retry-After`: CI's scripts share the 10/min credential limit per IP. It reads `SEED_PASSWORD` from the environment or the api env file instead of embedding the default.
- **Not done here (blocked by this session's permission mode, left for the user/planner):** removing this folder's line from `.git/info/exclude` and committing the folder, and replacing the roadmap table in `docs/plans/2026-10-02-refinement-audit/roadmap.md`.

### Notes for review
- The partial unique index also serialises concurrent accepts of two invitations: the loser gets 409 "already an active instructor with another institution" and its transaction (role upgrade included) rolls back.
- Reactivating a suspended member who has since joined another institution is 409 (same index).
- `addInstructor`'s placeholder still sets `email_verified_at` at creation, as before; the setup link proves ownership before any password exists.


### In flight / next step (code review approved)
- State: code review APPROVED in round 2 (ethio-reviewer, `code-review.md`); no deferred should-fix items. HEAD `b31bb51` on `fix/access-control`, base `feat/schema-migrations` (`9769a3f`). Nothing pushed.
- Waiting on the user: (1) remove this folder from `.git/info/exclude`, then commit the folder on this branch by explicit path; (2) rollout step 1, the read-only production checks; (3) approval to push and open the PR, only on a day it can be merged and deployed (rollout step 2). Also still open for the user or planner: the roadmap table in `docs/plans/2026-10-02-refinement-audit/roadmap.md`.
- Before the PR: rebase onto `origin/main` if Phase 2 has merged by then (else the PR targets `feat/schema-migrations` or waits), rerun the gate, and tell the reviewer the new base.
- Environment notes are unchanged: `export PATH="/home/kal/.local/opt/node22/bin:$PATH"`; e2e on a throwaway `el_e2e` DB with `api/.env.example` values only; kill the `next-server` PID to restart web; stage explicit paths (`.playwright-mcp/` and `docs/plans/2026-10-02-ui-foundations/` in the root are other sessions' files); production is off-limits.
