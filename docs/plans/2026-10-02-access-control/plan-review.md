# Plan review: Phase 3, access control and exploitable web holes

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)"), against `origin/main`: auth (profiles, auth.service, internal, admin), course and revision services, gateway routes and rate policy, notification copy, the web login/Google/accept-invite pages, `render.yaml`.

Checked and OK:
- `next` is consumed only in `login/page.tsx:33` and `GoogleSignInButton.tsx:66`. Every other use builds the parameter, so decision 9 covers all the sinks.
- `render.yaml` generates `JWT_SECRET`, `CERT_SIGNING_SECRET` and `INTERNAL_API_TOKEN` once, in the shared env group, so every service gets the same value. `CERT_SIGNING_SECRET` is already set in production, so removing the literal fallback doesn't change existing certificate signatures. `WEB_URL` and `GATEWAY_PUBLIC_URL` are in the shared group, so rule 11's URL check has a value on every service.
- `refresh` re-reads the role and calls `assertActive` (`auth.service.ts:200-213`), so decision 3's "accept, then refresh" picks up the new role.
- `addInstructor` never returns the invite token to the institution admin. The admin can't set the placeholder's password, so the LEARNER placeholder can't be pre-hijacked.
- The internal institution lookup has only two callers: course creation and the submit paths in course and revision (see S1).

Product decisions: I agree with both. The new-email placeholder as LEARNER makes acceptance the only path to a role change. For "suspended membership → new courses are independent": courses created while suspended stay independent after reactivation. That's acceptable, but worth one line in the README or plan.

### Blockers
- **B1. New-user acceptance through `/auth/accept-invite` breaks staff onboarding and can bind consent to the wrong institution** at Decision 3 (new users) / API contract
  Scenario: `acceptInvite` is shared. Platform admins onboard quality officers and admins through it too (`admin.controller.ts:75-97`, same `createInvite` and the same accept page). Decision 3 says it "activates the user's single pending membership with the same transaction as above". That transaction requires the UPDATE to affect one row (else 404/409) and rejects staff. Built as written:
  1. A new QO or admin clicks their setup link, has no membership, and gets 404/403. They can never set a password.
  2. A placeholder whose invite the institution cancelled (`invited → removed`) can't use their setup link at all.
  3. "The most recent pending invite" can attach the user to a different institution than the one that emailed them. The `StaffInvited` email doesn't even name the institution (`notification.service.ts:131-136`: "invited to join EthiopiaLearn as a instructor"), so clicking "Set my password" isn't informed consent to any institution.

  Suggested fix (recommended, simplest): `acceptInvite` only sets the password and adds `assertActive`. It touches no membership. The accept page then sends anyone with pending invites to `/account/invites`, where they accept explicitly with the institution named. That gives one consent path for everyone, leaves the staff flow unchanged, and needs no membership logic in auth.service. Alternative, keeping the single click: bind the invite to the membership (a `membership_id` in the link and the accept body). Activate only that row, only if it's `invited` and belongs to the user; with no id, set the password only. Then name the institution in the email and on the page. Either way, add a test that staff accept-invite still works.
  Response: fixed, taking your recommended option. `acceptInvite` only sets the password (+ `assertActive`) and returns `pending_institution_invites`; the accept page sends those users to `/account/invites` to accept the named institution. That leaves one consent path for everyone and staff onboarding unchanged. The setup email now names the institution. The test plan adds "staff accept-invite still works".

### Should-fix
- **S1. Submit notifications look up the instructor's current membership, not the course's institution** at Decision 5 / Risks ("only the lookup for new courses changes"). Submit and revision-submit pick the status from `course.institution_id` (`course.service.ts:696`), and the institution queue is scoped by `course.institution_id` (`:772`). But the admin to notify comes from `resolveInstitution(course.created_by)`, the instructor's current membership (`course.service.ts:716`, `revision.service.ts:210`). With decision 5 (active only), a suspended or removed instructor's existing institution course goes to `institution_review` with no notification and waits unannounced; `revision.service` only logs a warning. If they later join institution B, B's admin gets notified about a course that only A's queue shows. Suggested: resolve the recipient from `course.institution_id` (that institution's owner) in both places, and state in one line that removed members' existing institution courses stay with the institution.
  Response: fixed. New decision 5a: the notification recipient is the owner of `course.institution_id` in both places. Decision 5 states that existing institution courses stay with the institution and that courses created while suspended stay independent after reactivation. Test added.
- **S2. Split the auth migration into a transactional part and a concurrent-index part** at Data model and migrations. With one `transaction = false` migration, a failed index build leaves the new columns in place while the migration stays unrecorded. That can happen through a duplicate created by the old check-then-insert code between the rollout 1(a) check and the deploy, or a pooler drop. Nest's retry then fails on `ADD COLUMN status` ("already exists"), which hides the real cause, and auth crash-loops until someone repairs it by hand. Suggested: migration 1 (transactional) holds the columns, default, CHECK and backfill. Migration 2 (`transaction = false`) holds the two unique indexes, with drop-if-exists first, per Phase 2.
  Response: fixed. Split into a transactional columns migration and a `transaction = false` index migration.
- **S3. The redesigned invite endpoints still show who is registered** at API contract / Decision 2. The 201 returns `user:{id,name,email}` and `new_account` for an invite nobody has accepted, the list returns name and role, and staff emails get a distinct 400. A self-signed-up institution admin (not gated, per non-goals) can script invites over an email list and learn which addresses have accounts, their full names, and which ones are platform staff. The INVITES rate class slows that but doesn't stop it. Suggested: for `invited` rows, return and list only the email the admin typed, and show name and role after acceptance. Drop `new_account`. Answer staff emails like any other: create the invite with the same 201, since acceptance already rejects staff.
  Response: fixed. Same 201 for every address, staff and owners included (acceptance rejects them). `invited` rows expose only the typed email; name and role appear only after acceptance; `new_account` dropped. API contract and tests updated.
- **S4. Keep this plan out of Phase 2's commits** at process. Phase 2 is being implemented in the same working tree (currently on `feat/schema-migrations`), and `docs/plans/2026-10-02-access-control/` is untracked there. A `git add docs/plans` or `git add -A` in a Phase 2 commit would publish this plan, which describes the unfixed holes, in the Phase 2 PR. Suggested: `echo 'docs/plans/2026-10-02-access-control/' >> .git/info/exclude` (local only, nothing committed) until the Phase 3 branch exists, and remind ethio-impl to stage its own plan folder by path.
  Response: done. Added `docs/plans/2026-10-02-access-control/` to `.git/info/exclude`, and ethio-impl was already asked to stage by path.

### Nits (optional)
- **N1.** (Taken: rollout step 2.) Rollout: push the Phase 3 PR only when it can be merged and deployed the same day. Once it's in the public repo, the diff reveals the holes.
- **N2.** (Taken: dropped in migration 2.) `UNIQUE (institution_id, user_id)` makes the existing single-column `institution_id` index redundant, so drop it in the same migration (P2-14 style).
- **N3.** (Deferred to the role-dashboards polish phase; listed in Non-goals.) With consent-based joining, members can't leave an institution themselves; only the admin can remove them. A "Leave" action on `/account/invites` (active → removed, by the member) would complete the model. Fine to defer.

## Round 2 (2026-10-02) · Verdict: APPROVED
Reviewed: `plan.md` (status "in review (round 2)") and the responses above. I checked only the changed parts.

Round-1 findings, all resolved:
- **B1** resolved. Decision 3: `acceptInvite` only sets the password and calls `assertActive`, with no membership change. It returns `pending_institution_invites`, and acceptance happens explicitly on `/account/invites` with the institution named. The setup email names the institution, and the test plan covers staff onboarding through accept-invite.
- **S1** resolved. Decision 5a: the notification goes to the owner of `course.institution_id` in both submit paths, with a test.
- **S2** resolved. Two migrations: transactional columns, then the `transaction = false` concurrent indexes.
- **S3** resolved. The same 201 for every address, `invited` rows show only the typed email, and `new_account` is gone.
- **S4** done. `.git/info/exclude` holds the folder, and it stays out of `git status`.
- **N1, N2** taken; **N3** deferred, with the reason in Non-goals.

### Nits (optional)
- **N4.** (Taken: both Risks bullets updated.) Two "Risks and open questions" bullets still describe the round-1 design and contradict the decisions:
  - "the setup-link acceptance doubles as consent … activates only the most recent pending invite" (now false: decision 3)
  - "only the lookup for new courses changes" (now incomplete: decision 5a)

  Delete or update them so the implementer doesn't follow the old behavior.
