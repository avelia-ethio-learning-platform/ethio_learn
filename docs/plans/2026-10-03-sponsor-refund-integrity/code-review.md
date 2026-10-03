# Phase 6d: code review (ethio-reviewer)

## Round 1 (2026-10-03) · Verdict: APPROVED (no blockers; two optional nits)
Reviewed `git diff bbd6146...37465db`. I read all the production code myself: refund, sponsorship, enrollment, notification, controllers, contracts, the admin page and the fake DB. I also read the new refund specs, the e2e additions and the DEPLOYMENT.md query.

**Does what the plan says, and nothing unplanned:**
- **Refunds (decisions 1–4):**
  - `lockCoursePayments` (filtered to the course purpose, ordered by id, `pessimistic_write`) is the first statement of `request()`'s transaction, before the mark, and it runs again in `approveWith`, where it's a no-op. That fixes the lock order for every path:
    - two auto-approvals take the locks in the same order;
    - `decide` takes the refund row first, then the payments, so there's no cycle with `request()`.
  - After the wait, Postgres re-checks `status = confirmed`, so the second refund sees only its own payment and revokes. That is exactly once, and the e2e `Promise.all` check covers it.
  - `access_kept` is true when another confirmed course payment or a granted sponsorship exists. The learner's own gift purchase is excluded by purpose, and a test covers it.
  - The credits are still voided whether access is kept or not, and a test asserts it.
  - Enrollment returns early when `access_kept` is set. Otherwise it runs a conditional `update` on `ACTIVE`, so it no longer does a whole-row save. `EntitlementStatus` is only none, active or refunded, so the `ACTIVE` filter misses no state that grants access.
  - The email copy branch is right. A denial carries no flag.
- **Pay requests (decisions 5–7):**
  - All three `payRequest` writes are conditional on `In(['requested','pending_payment'])`.
  - A refused attach throws without the URL and leaves the checkout to expire.
  - `closedRequest` maps `granted` and `pending_claim` to "already paid".
  - The A3 undo still requires `payment_id IS NULL`, so another payer's attached checkout stays.
  - The grant handler names the payer inside the same conditional update. Gift and bulk attach are conditional.
- **N2:** `{ ...payment, replayed: !created }`. There is no `ClassSerializerInterceptor` or `@Exclude` in financial, so spreading the entity leaks nothing new.
- **N3:** the tile has a vitest.
- **DEPLOYMENT.md query:** read-only, with the same predicates as `access_kept`.
- **Complexity:** no new table, column, env var, job or endpoint. There is one helper and one optional event field. Nothing extra.

**Gate (my run, review worktree `../ethi0-review-6a` detached at `37465db`, lockfile unchanged):**
- api build and typecheck: clean.
- api jest: 1264 passed, 1 skipped.
- web vitest: 590 passed.
- I didn't rerun the stack parts (db:check, e2e, Playwright, images). impl reports them green on `3ef1439`, and `3ef1439..37465db` changes only `plan.md`.

**Checked, not findings:**
- A payout run that claims both duplicates with `UPDATE … id IN (…)` while a refund holds them could in theory deadlock. The claim locks in pkey order, the same as ours, and the loser gets a retryable error. Not realistic.
- A grant that lands between the refund's commit and enrollment consuming `RefundApproved` could revoke a just-granted sponsorship. That's a window of seconds, which is the existing event-delivery class (P1-17, Phase 9b).

### Nits (optional, no new round)
- **N1:** the grant handler writes `sponsor_name: ''` when `user()` swallows a lookup failure and the payer isn't the last opener. Example: the users service is hibernating on Render at grant time. `sponsor_id` is still right, but the learner dashboard shows "from a sponsor" for good. Plan decision 5 expected a re-run on failure. If you want it, skip the payer patch, or throw, when the name comes back `''`. This is display only, and deferring it is fine.
- **N2:** `refund.service.ts`: the new `type Approval` sits between `purchasedAt`'s JSDoc and its `const`, so that doc comment now documents the type. Move the type above the comment.

### Implementer replies (round 1)
- **N1: deferred.** A blank name only shows "from a sponsor"; it never names the wrong person, and `sponsor_id` is right. Keeping the old name would name the last opener, not the payer. Throwing to force a re-run depends on event redelivery, which is P1-17 (Phase 9b). Revisit it there.
- **N2: fixed.** `type Approval` now sits above `purchasedAt`'s JSDoc. Refund specs 45/45, and api typecheck is clean.
