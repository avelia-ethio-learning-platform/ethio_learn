# Handoff: Phase 6d, money integrity III

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 1; S1–S3 and N1–N3 folded in; see [plan-review.md](plan-review.md))
Code review goes to: ethio-reviewer (size L)
Start: after 6b is code-review APPROVED. Base: the `fix/learning-integrity` tip, or `origin/main` if 6b has merged by then.

## What to build
- **Refunds (P1-63):**
  - a refund revokes the course only when the learner has no other confirmed course payment and no granted sponsorship for it;
  - financial decides this as `access_kept` inside the refund transaction, under an ordered row lock, and sends it on `RefundApproved`;
  - enrollment and notification follow the flag.
- **Pay requests (P2-47):**
  - the grant records the payer whose payment confirmed;
  - `payRequest`'s three whole-row saves become conditional updates, so a stale call can't reopen or cancel a granted request;
  - gift and bulk attach become conditional too.
- **6c nits:** N1, the wallet-refusal undo test; N2, `replayed` plus the admin alert; N3, a `growth-tabs` vitest.
- No migration, env var, endpoint or new table.

## Read first, in order
1. `plan.md`, decisions 1–9, then `plan-review.md` round 1:
   - S1: why the ordered lock comes **before** the refund mark in `request()`;
   - S2: why the lock is proven in e2e and not in jest;
   - the "Confirmed in code" list: bulk seats are `Sponsorship` rows.
2. `api/services/financial/src/refund.service.ts`, all of it: `request`, `decide`, `approveWith`, `finalizeApproval`, `emitDecision`.
3. `api/services/financial/src/sponsorship.service.ts`:
   - `payRequest` and `byToken`;
   - the gift and bulk attach;
   - `onSponsoredPaymentConfirmed`;
   - the A3 undo (keep it as it is).
4. `api/services/enrollment/src/enrollment.service.ts`: `revokeFromRefund` and `activate`. Then `api/services/notification/src/notification.service.ts`: the refund email.
5. `api/packages/contracts/src/events.ts` (`RefundDecisionPayload`).
6. `api/services/financial/src/testing/fake-db.ts`: `find`, `persist`, the repos.
7. `scripts/e2e-payments.mjs`:
   - `buyCourse`, `newLearner`, `waitEnrolled`, `race`, `sql`;
   - the 6c refund block (around "a refund at 0 % progress is auto-approved").
8. Web: `(admin)/admin/page.tsx` (`BankTransferForm`) and `(admin)/admin/growth-tabs.tsx`.

The plan's line numbers are from `21a11c8`; find code by content.

## Decisions already made (don't relitigate)
- **Lock:** one helper locks the learner's confirmed `purpose: COURSE` payments for the course with `pessimistic_write`, ordered by id.
  - `request()` calls it as the first statement of its transaction, before the mark.
  - `decide` calls it in `approveWith`, before the flip.
- **`access_kept`:** decided after the flip, in the same transaction. It is true when another locked row is still confirmed, or when a `Sponsorship {recipient_user_id, course_id, status: 'granted'}` exists. The learner's own gift payments don't count, which is what the `purpose` filter is for.
- **Contract:** `access_kept?: boolean` is optional. Old consumers behave as today.
- **Enrollment:** an early return on the flag; otherwise a conditional `update` from ACTIVE to REFUNDED, never a `save()`.
- **Pay-request writes:** scoped to `status IN ('requested', 'pending_payment')`.
  - Open with 0 rows → re-read and throw the existing 400.
  - Attach with 0 rows → 400 **without** the checkout URL.
- **Grant:** sets `sponsor_id = payment.learner_id`, and `sponsor_name` via `this.user(...)`, in the existing conditional update.
- **Rejected:** `enrollments.payment_id`, enrollment calling financial, and a `TEST_DATABASE_URL` jest harness.

## Gotchas learned while planning
- **Deadlock order (S1):** the mark in `request()` (`UPDATE payments SET refund_requested_at …`) locks the refunded row. Any lock taken after it is out of order, so the ordered `find` must come first.
- **The fake DB has no isolation and no `FOR UPDATE`:** make `find` accept `lock` as a no-op. Unit tests cover the decision with sequential calls; the e2e covers the lock.
- **Self-serve refunds exclude wallet and sponsored payments** (`refund.service.ts`, top of `request`). The e2e duplicates must be two **Chapa** checkouts.
  - `initiate` checks ownership only at checkout start, and `confirmPayment` doesn't re-check it (verified on main, `5f5fe7d`).
  - So: `initiate` twice, then `mockComplete` both.
  - Fresh purchases are under 20% progress and inside 7 days, so both refunds auto-approve.
- **Concurrent e2e:** send both refund POSTs with `Promise.all`. Expect both to answer 2xx, then `waitFor` the entitlement to be `refunded`. Don't assert on which one revoked.
- **Pay-request e2e:** read `sponsor_id` with the script's `sql()` helper, as the 6c checks do.
- **N2:** `api()` on the web returns only the body, so the alert must read `replayed` from the body, not the status code.

## Reminders
- **No over-engineering (user rule):** nothing beyond decisions 1–9. One helper for the lock, no new abstractions.
- **Money phase:** push only when it can merge and deploy the same day.
- **DEPLOYMENT.md "Phase 6d":** add the single read-only wrong-revocation query, marked "any time; blocks nothing". Test it on a scratch DB. The planner puts it in USER-ACTIONS.
- **Stack windows:** coordinate with ethio-planner. 7b's code review may still need one.
