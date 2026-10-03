# Phase 6d: Money integrity III (pay-request writes, refunds of duplicate purchases)

Status: approved (round 1); S1–S3 and N1–N3 folded in
Size: L (sessions: 4; money, concurrency; small diff)
Base branch: stacked on `fix/learning-integrity` (6b). If 6b has merged when this starts, branch from `origin/main`. · Feature branch: `fix/sponsor-refund-integrity`

Source: the Phase 6c code review (`docs/plans/2026-10-02-money-integrity/code-review.md` Round 1, "Planner: please schedule it") and the 6c plan's "Backlog for ethio-planner". Verified in code at `21a11c8` (6c's head, now on main as `5f5fe7d`) on 2026-10-03. Audit IDs: **P1-63** (refund of a duplicate purchase), **P2-47** (pay-request whole-row saves), both added to `audit.md` on 2026-10-03.

## Goal
A learner who refunds one of two purchases of the same course, or refunds their own purchase of a course someone also paid for them, keeps access. Today the refund revokes it at once, usually by auto-approval with no admin involved. A pay request records the payer who actually paid, and a slow or stale request can't overwrite a row that another payer's payment already granted.

Acceptance criteria:
- **Refunds (P1-63):**
  - Refunding a confirmed course payment revokes the entitlement **only** when the learner then has no other confirmed course payment for that course and no granted sponsorship for it.
  - Two refunds of two duplicate payments, approved at the same time, revoke the entitlement exactly once, through the second one.
  - The refund still flips the payment to `refunded` and voids its pending credits (6c), whether or not access is kept.
  - The refund email doesn't say access was revoked when it was kept.
- **Pay requests (P2-47):**
  - The granted row's `sponsor_id` and `sponsor_name` name the payer whose payment confirmed, not the last person who opened the link.
  - A request that is already `granted` (or `cancelled`) is never written back to `pending_payment` by a stale `payRequest` call. That call answers 400 and hands out no checkout URL.
  - The entitled check in `payRequest` never overwrites a `granted` row with `cancelled`.
  - Gift and bulk orders attach their `payment_id` with a conditional update. No whole-row save remains in `sponsorship.service.ts` on a row another request can change.
- **6c review nits:**
  - N1: the pay-request undo is also tested on a wallet refusal.
  - N2: a replayed bank transfer tells the admin "Already recorded — no new payment was created."
  - N3: the admin "Pending rewards" tile has a vitest.

## Non-goals
- **Preventing duplicate purchases** (two open checkouts, wallet double-submit, P2-03). A duplicate is legitimate money in and gets refunded; this phase makes its refund correct.
- **Serializing two different bank references for one (learner, course)** (6c deferred note). It is two real transfers.
- **The lossy `RefundApproved` publish** (P1-17): Phase 9b's outbox.
- **Recording which payment granted an entitlement** (a new `enrollments.payment_id`). Rejected below.
- `claimForEmail` → `grant()` double publish: enrollment's `activate` already treats the second as a no-op.
- `assignSeats`' seat-count race (P2-03), and the index for 6c's A2 failed-row sweep (Phase 11, 6c M7).
- Allowing several payers on one request, or blocking a second payer from opening a request: the design allows several open checkouts per request.

## Current state
(Line numbers at `21a11c8`; find code by content.)
- **Refund path:**
  - `api/services/financial/src/refund.service.ts`: `request` (:40-144) auto-approves under 20% progress within 7 days (:93-95) and calls `approveWith` (:217-230) in one transaction. Admin `decide` (:153-175) also calls `approveWith`.
  - `approveWith` flips `confirmed → refunded` and voids the purchase's pending credits. `finalizeApproval` (:233-241) → `emitDecision` (:268-287) publishes `RefundApproved {payment_id, learner_id, course_id, …}`.
  - `api/services/enrollment/src/enrollment.service.ts` `revokeFromRefund` (:454-460) does `findOne({learner_id, course_id})`, sets `REFUNDED` and `save()`s the whole row. It ignores the payment and the entitlement's `source`.
  - `enrollments` is one row per (learner, course), with `source` (payment, sponsorship, free) and `sponsor_id`, and no payment id. `activate` (:444-452) returns early when the row is already active, so a second payment or sponsorship leaves no trace.
  - `api/services/notification/src/notification.service.ts` (:267-274): the refund email says "Access to the course has been revoked."
  - `quality.service.ts` (:161-170) counts refunds and is unaffected.
- **How a learner gets two paid sources for one course today:**
  - two open Chapa checkouts (two tabs; `createSession` inserts a row each time and only the coupon path supersedes);
  - a superseded coupon checkout paid late (6c A2 confirms it);
  - a wallet purchase while a Chapa page is open;
  - a gift, pay request or bulk seat plus the learner's own purchase, when either checkout was open before the other paid (for example, a learner asks a relative to pay, buys it themselves, and the relative pays anyway);
  - a bank transfer recorded while a Chapa page is still open.

  Self-serve refunds cover the learner's own Chapa course payments (`refund.service.ts:46-51` excludes sponsored and wallet payments).
- **Pay requests:** `api/services/financial/src/sponsorship.service.ts` has no transaction or lock. `payRequest` (route `growth.controller.ts:266-273`) reads the row (:196, `byToken` :585-589), then `save()`s the whole row three times:
  - **cancel** when the learner is already entitled (:200-203);
  - **open**, which sets sponsor to the caller (:207-210);
  - **attach**, which adds `payment_id` after checkout (:234-237).

  Other writes:
  - the A3 undo (:228-232) is a conditional `update`;
  - the grant handler `onSponsoredPaymentConfirmed` (:419-428) is a conditional `update` on status, but it never sets `sponsor_id` from the payment;
  - gift attach (:109-112) and bulk attach (:296-299) are whole-row saves, not reachable by a race today;
  - `withProgress` (:536-553) shows sponsored learners to the recorded sponsor.
- **The house pattern for this bug class** (6c A1):
  - `payment.service.ts` claims with `update({id, status, nudged_at: IsNull()}, …)` and checks `affected` (:578-582);
  - `createSession` (:282-291) writes the URL only onto a still-pending row, and throws 409 without the URL otherwise;
  - `pessimistic_write` inside `dataSource.transaction` appears in the coupon checkout (:324-335).
- **Tests:**
  - `sponsorship.service.spec.ts` (fake DB; handlers :99-204, A3 undo :206-330);
  - `refund.service.spec.ts` (fake DB);
  - the fake DB's `persist` merges whole objects (`testing/fake-db.ts:132-144`) and already has the Payment and Sponsorship repos (:175-187);
  - `enrollment.service.spec.ts` has no revoke test;
  - `scripts/e2e-payments.mjs` never pays a gift, a pay request or a bulk order.
- **6c nits:**
  - N1: `sponsorship.service.spec.ts:237-245`;
  - N2: `web/src/app/(admin)/admin/page.tsx:165-174` (the alert at :171), where `api()` returns only the body and `controllers.ts:202-206` sets 201 or 200;
  - N3: `web/src/app/(admin)/admin/growth-tabs.tsx:22` has no test file.

## Design and key decisions
1. **Financial decides whether access is kept, and enrollment follows a flag.**
   - Lock the learner's confirmed **course-purpose** payments for that course: `find({ where: {learner_id, course_id, purpose: COURSE, status: CONFIRMED}, order: {id: 'ASC'}, lock: {mode: 'pessimistic_write'} })`, in one small helper used by both paths.
     - In `request()`, the ordered lock is the **first statement** of the transaction, before the refund mark (`refund.service.ts:127-130`). Marking first would lock the refunded payment out of order, and two simultaneous auto-approved refunds of two duplicates would deadlock (40P01, one request 500s; review S1).
     - In admin `decide`, `approveWith` takes it before the flip. That path locks the refund row first, not a payment, so it can't deadlock.
     - With the lock first, the second transaction waits, then re-reads `status = confirmed` and sees only its own payment, so it revokes.
   - After the flip, `access_kept` is true when another of those rows is still confirmed, or when `m.getRepository(Sponsorship)` has a row `{recipient_user_id: learner, course_id, status: 'granted'}`. That one query covers gifts, pay requests and bulk seats: bulk seats are `Sponsorship` rows (`source: 'bulk'`, `assignSeats` :344-366), and institution access arrives as bulk seats (review, confirmed in code).
   - Return `access_kept` alongside `voided`. `finalizeApproval` passes it to `emitDecision`.
   - The lock serializes two refunds of the two duplicates. Without it, two simultaneous auto-approvals each see the other as still confirmed and neither revokes.
   - The `purpose: COURSE` filter matters: a gift the learner bought for someone else has the same `learner_id` and `course_id`.
   - **Rejected:**
     - a new `enrollments.payment_id` column (a migration with nothing to backfill from; `activate` never records a second source);
     - enrollment asking financial before revoking (a new internal endpoint and a cross-service call inside an event consumer).
2. **Contract:** add `access_kept?: boolean` to `RefundDecisionPayload` in `api/packages/contracts/src/events.ts`. It is optional and additive.
3. **Enrollment:**
   - `revokeFromRefund` returns without a change when `p.access_kept` is true.
   - Otherwise it runs a conditional `update({learner_id, course_id, entitlement_status: ACTIVE}, {entitlement_status: REFUNDED})` instead of the whole-row `save()`, so a refund can't write back stale progress fields.
   - Log at info in both branches with `learner_id`, `course_id`, `payment_id`, and `affected` on the revoke (the update loads no row, so there's no `enrollment.id`).
4. **Notification:** with `access_kept`, the refund email leaves out the "Access to the course has been revoked." sentence. Everything else stays the same.
5. **Pay-request attribution:**
   - The grant handler (:419-428) also sets `sponsor_id = payment.learner_id` (the payer) and `sponsor_name`, in the same conditional update. That makes the payer who actually paid the recorded sponsor, whatever happened to the row while checkouts were open.
   - `sponsor_name` comes from `this.user(payment.learner_id)`, as `payRequest` does (:206). `Payment.meta` holds only `sponsorship_id`, and payments in flight at deploy wouldn't carry a new field. The purpose handler is re-run by its cron if the lookup fails.
   - The handler already resolves the payment, so this adds no new table, column or event field.
6. **Pay-request writes:** replace the three saves with conditional updates scoped by `{id, status: In(['requested', 'pending_payment'])}`:
   - **cancel** → `{status: 'cancelled'}`;
   - **open** → `{status: 'pending_payment', sponsor_id, sponsor_name}`. On 0 rows, re-read and throw the existing 400 for that state;
   - **attach** → the same fields plus `payment_id`. On 0 rows, throw 400 ("This request has already been paid") **without** returning the checkout URL. That is createSession's move: the orphan checkout stays pending and expires, and the 6c sweep handles it like any abandoned one.
   - The A3 undo stays as it is.
7. **Gift and bulk attach:** `update({id, status: 'pending_payment'}, {payment_id})` instead of `save()`. This is for consistency only: nothing races them today, so they get no race tests.
8. **N2 (replayed bank transfer):**
   - The record-bank-transfer response body gains `replayed: boolean`, false on a create (201) and true on a replay (200). It is additive. `recordBankTransfer` already returns `{payment, created}` (`controllers.ts:202-206`), so this is `replayed: !created`.
   - The admin page shows "Already recorded — no new payment was created." when `replayed` is true.
   - Update `controllers.spec.ts` (:43, :50), which assert the raw payment.
9. **Keep it simple (user rule):** no new table, column, env var, job, endpoint or helper beyond what decisions 1–8 need.

## Data model and migrations
None. Contract change: one optional event field (decision 2). Response change: one additive field (decision 8).

## API contract
- `RefundApproved` event: `RefundDecisionPayload` gains `access_kept?: boolean`. Old consumers ignore it and behave as today, so deploy order doesn't matter.
- `POST /api/v1/pay-requests/:token/pay`: a request that is already granted or cancelled, including one that becomes so between the read and the attach, answers **400** with the existing message style and no URL.
- The admin bank-transfer endpoint: the response gains `replayed`, and the status codes are unchanged (201 create, 200 replay).

## Steps
- [x] 1. Branch `fix/sponsor-refund-integrity` from the base above. Commit the plan folder with `git add -f`.
- [x] 2. **Refunds:**
  - `approveWith` gets the lock and `access_kept`;
  - `finalizeApproval` and `emitDecision` carry the flag;
  - the contracts field is added;
  - tests in `refund.service.spec.ts`:
    - two confirmed, refund one: `access_kept` true and the credits voided;
    - then refund the other: false;
    - a granted sponsorship plus the learner's own payment: true;
    - the learner's own **gift** payment for the same course doesn't count;
    - a refunded or failed other payment doesn't count;
    - the admin `decide` path carries the flag.
  - `testing/fake-db.ts` `find` accepts the `lock` option as a no-op. The fake DB has no isolation between transactions, so the unit tests cover the decision logic with sequential calls, and the e2e covers the lock.
  - Verify: `pnpm -C api test -- refund`.
- [x] 3. **Enrollment and notification:**
  - `revokeFromRefund` gets the early return and the conditional update. Add `enrollment.service.spec.ts` revoke tests: flag true → still active; flag absent → refunded; an already refunded row stays refunded.
  - The notification copy branch, with a spec.
- [x] 4. **Pay requests:**
  - the grant handler records the payer;
  - the three conditional writes in `payRequest`;
  - gift and bulk attach.
  - Tests in `sponsorship.service.spec.ts`, using the existing mock-interleaving patterns (:255-266, :299-316):
    - **A-1:** B opens, A opens, B's payment confirms → the row and `SponsorshipGranted` name B;
    - **A-2:** A's payment confirms inside B's `chapa.initialize` → the row stays granted with A's payment, and B gets 400 with no URL;
    - **A-3:** a grant lands inside the `/entitlements` call → the row stays granted, not cancelled;
    - **A-4:** B settles by wallet after A's refused checkout reset the row → the grant names B;
    - **N1:** the pay-request undo on a wallet refusal (`it.each` like the gift test at :222-235).
- [x] 5. **N2 and N3:**
  - the `replayed` field, the admin alert, and the `controllers.spec.ts` updates;
  - a `page.test.tsx` replay case;
  - a new `growth-tabs.test.tsx` for the Pending rewards tile.
- [x] 6. **e2e (`scripts/e2e-payments.mjs`, real Postgres):**
  - **Sequential:** a learner initiates two Chapa checkouts for one paid course before completing either, then `mockComplete`s both. Refund one: the entitlement is still active (`waitFor`), and enrollment and notification honour `access_kept`. Refund the other: it becomes refunded.
  - **Concurrent (review S1/S2):** a second learner with two duplicate payments sends both refund requests together with `Promise.all`. Both answer 2xx (no deadlock 500), and the entitlement ends `refunded` (`waitFor`). Requests don't always overlap, so this can miss a deadlock on some runs, but it never fails a correct build.
  - Two learners open the same pay request. The first one's checkout is completed, so the request's `sponsor_id` is the first learner, checked with SQL as the script already does elsewhere.
- [ ] 7. **Gate:**
  - `pnpm -C api build && pnpm -C api typecheck && pnpm -C api test`;
  - `db:check`;
  - `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`;
  - every e2e script in CI order, then Playwright;
  - all images build.
- [ ] 8. Code review by ethio-reviewer.

## Test plan
Steps 2–6. The decision logic is unit-tested with sequential calls through the fake DB, which can't model a blocking `FOR UPDATE`. The lock and its ordering are covered by step 6's concurrent e2e on real Postgres. No new jest harness: 7b's `TEST_DATABASE_URL` pattern isn't on this base.

## Rollout and ops
- No migration, env var or config.
- Deploy order: none needed. Old enrollment and notification services ignore `access_kept` and behave as today until they redeploy, a few minutes on Render.
- Money phase: push only when it can merge and deploy the same day.
- **Read-only production check for the user, any time; it blocks nothing** (goes into DEPLOYMENT.md as "Phase 6d" and into USER-ACTIONS as a tested one-liner): learners whose course entitlement is `refunded` while another confirmed course payment or a granted sponsorship still exists for the same course. These are past wrong revocations; each is for the user to decide on (re-grant by hand). 6d doesn't touch those rows, so the result doesn't affect the merge (review S3).
- Rollback: revert the code. Nothing to undo in data.

## Risks and open questions
- Both planning-time risks are settled in code (review round 1): bulk seats are `Sponsorship` rows, and enrollment has no institution source (institution access arrives as bulk seats).
- The concurrent e2e can't force an overlap; it guards against the deadlock rather than proving its absence on every run. The lock order in decision 1 is what prevents it.

## Progress and deviations (implementer)

Worktree `../ethi0-6d`, branch `fix/sponsor-refund-integrity` from 6b's approved tip `46e9ff6`; `git merge origin/main` once 6b is on main.

- **Step 1:** d7e28f7.
- **Step 2:** ddbe3b9. One helper, `lockCoursePayments`, is the first statement of `request()`'s transaction and is called again in `approveWith` (a second `FOR UPDATE` in the same transaction is a no-op). It reads after the wait, so a row a concurrent refund flipped drops out. A unit test checks that the first lock comes before the mark.
- **Step 3:** 2b3308b.
- **Step 4:** ed10129. Three of the new tests fail on the old code (A-1, A-2, A-3). A-4 already passed before, and stays as a guard.
- **Step 5:** 23db4aa.
- **Step 6:** 7ed2931, including DEPLOYMENT.md "Phase 6d". The query was tested on a scratch DB (the enrollment and financial schemas from el_e2e, plus fixtures). It listed exactly the learner with a second confirmed purchase and the one with a granted pay request. It left out a learner with only a refunded payment, one with their own gift payment, an active learner, and one with a pending sponsorship. It also runs on el_e2e's real schema.
- **Step 7, so far:** api build, typecheck and tests (1264 passed, 1 skipped); web typecheck and tests (590). The stack part (db:check, e2e, Playwright, images) waits for a stack window.

Deviations:
- **Grant handler (decision 5):** `sponsor_id`/`sponsor_name` are written only when the row's sponsor isn't already the payer. For a gift, or a pay request whose last opener paid, nothing changes and there's no user lookup. `user()` returns `''` when the lookup fails, and an unconditional write would blank a correct name.
- **Enrollment has no `updated_at`,** so the Phase 6d query shows `enrolled_at`; the refund time isn't recorded on the enrollment.
- **`closedRequest`:** the 400 after a conditional write matched nothing is "This request has already been paid" for `granted` or `pending_claim` (paid, with the learner not signed up yet), and otherwise the existing `Request is <status>`.
- **The admin replay message** reads `replayed` from the body (`api<{ replayed?: boolean }>`).
