# Plan review: Phase 8, UI polish II (role dashboards)

## Round 1 (2026-10-02) · Verdict: APPROVED (three should-fixes to fold in before handoff)
Reviewed: `plan.md` (status "in review (round 1)"), against the code at `2cdccf9`, and against `fix/payment-integrity` for the payout hold rules.

Verified as the plan states:
- **Native dialogs:** the acceptance grep finds exactly the 25 sites listed.
- **Bars:** the columns sit in an `items-end` row, so `height: N%` has no definite parent height.
- **Coupons:** `useAuth` returns `{ user, ready }` (`lib/hooks.ts:7`), so `enabled: ready && !isAdmin` holds the `/courses` query until auth is read.
- **Own row:** the API already refuses a change to your own status (`admin.controller.ts:52`).
- **Refunds:** `Payment` has `course_title` and `amount_etb`, so the `listPending` addition is one `In()` read.
- **Gateway:** `profiles/me/*` already reaches auth, since the invite accept and decline routes live there.
- **Copy:** the new-course form requires a price when the course is paid (`teach/new/page.tsx:92`), so the second "price_etb is required" message (`course.service.ts:325`) can't be reached from the UI.

### Answers to the planner's questions
1. **Native `<dialog>` and `useConfirm` (decision 1): agree.** `showModal()` gives top layer, inertness and Escape for free. A library or a hand-rolled trap would be more code for a worse result. Two details are in S3 and N3.
2. **The confirm list (decision 3):** the right list, and the right exclusions (reactivate, restore, duplicate, withdraw, re-publish, pass/fail). It needs two corrections: the payout and fraud copy must match Phase 4's hold rules (S1), and one irreversible action is missing (S2).
3. **Leave reuses `removed` with no migration (decision 9): agree.** Checked:
   - the internal lookup returns `active` only (`internal.controller.ts:44`), and the course service doesn't cache it (`resolveInstitution`, `course.service.ts:761-769`), so the next course is independent at once;
   - `invite()` re-invites from `removed` (`membership.service.ts:69-75`);
   - the admin list keeps the name, because `accepted_at` stays set (`:129`);
   - `audit_log.action` is a free-text column with no CHECK.

   One detail: the conditional UPDATE doesn't return `institution_id`, which the audit detail should carry. Read the row afterwards, as `setStatus` does (`:155`), or use `RETURNING`.
4. **PR breadth: I recommend the split.** "About 30 files" undercounts. Listing what the steps touch gives about 60:
   - about 23 page and component files;
   - 8 shared files (Providers, PageChrome, Bars, globals.css, labels, format, the i18n dictionaries, the vitest setup);
   - 5 new modules;
   - about 15 vitest files;
   - about 9 API files across three services;
   - 5 e2e files.

   The risky part is the money-moving confirm wiring and two new auth endpoints. Mixed into about 190 mechanical label and status swaps, a confirm whose Cancel still sends is easy to miss in review. Your split works as written:
   - **8a:** steps 2–4 and 7, plus `confirm.spec`, `admin.spec`, the `e2e-institution.mjs` leave step and the `/admin` a11y entries;
   - **8b:** steps 5, 6 and 8, plus `role-mobile.spec` and the rest of the a11y entries;
   - the app-wide native-dialog grep becomes an 8b acceptance criterion; 8a checks only its own files.

   This doesn't need a new plan round. Partition the acceptance criteria and steps in this plan, and make 8b's base `feat/role-dashboards-a`. Not a blocker: if you keep one PR, ask the implementer to keep the step-per-commit order so the review can go one area at a time.

### Blockers
None.

### Should-fix
- **S1. The payout and fraud dialogs must match Phase 4's hold rules** at decision 3 (Admin: "release a held payout", "resolve a fraud flag … their payouts are released")
  - **Fraud resolve.** Scenario: a payee has two open fraud flags, and the admin resolves one. The dialog says "their payouts are released", but nothing goes out. The handler releases fraud holds only when the payee has no open flags left (`payout.service.ts:62-63` on `fix/payment-integrity`). Even then, a payout above the KYC threshold moves to `kyc_required` instead of `scheduled` (`:189-192`). The admin tells the educator the money is on its way, and it isn't.
  - **Release.** `release()` clears *any* hold, KYC included (`:198-199`). The planned dialog names only the payee and the net amount. An admin who thinks they're clearing a resolved fraud hold can skip KYC without seeing that.

  Suggested:
  - Fraud resolve copy: "Clears this flag. Payouts held for fraud go out once this payee has no open flags; payouts over the KYC limit still wait for KYC."
  - The release dialog also names the hold reason through `labels.ts` (e.g. "Held: KYC required").
  - A vitest case for each string.

  Response: fixed. In decision 3 the fraud-resolve copy now matches the hold rules, and the release dialog names the hold reason through `labels.ts`. Step 4's vitest asserts both strings.
- **S2. Bulk seat assignment is missing from the confirm list** at decision 3 (Institution)
  Scenario: an institution admin pastes 30 emails with one typo and clicks "Assign seats" (`bulk-purchases.tsx:137-149`). That paid seat goes to an address that never claims it. There's no way back: the API has only `POST bulk-purchases/:id/assign` (`growth.controller.ts:307`), with no unassign. It's a prepaid, irreversible action on one click, which is exactly what the Goal rules out.
  Suggested: add it to the Institution list, in default tone. The dialog says "Assign {n} seats of {course}? Assigned seats can't be moved to someone else." and lists the parsed, de-duplicated emails. Add a vitest: Cancel sends nothing.
  Response: fixed. Assigning bulk seats is in decision 3's Institution list, in default tone, listing the de-duplicated emails. Step 6 adds the bulk-purchases vitest.
- **S3. "The dialog traps Tab" contradicts decision 1** at step 9 (`confirm.spec.ts`)
  Scenario: `showModal()` makes the page behind it inert, but it doesn't cycle focus. Tab from the last control leaves the document, in Chromium headless `activeElement` becomes `body`, and the next Tab returns to the first control. A spec that asserts focus stays inside the dialog after every Tab fails at that wrap. The implementer is then pushed to hand-roll a trap, the option decision 1 rejected.
  Suggested: assert that Tab never focuses an element *behind* the dialog. After each press, `activeElement` is inside the `<dialog>` or is `body`. Reword the Risks line to match.
  Response: fixed. Step 9 asserts that `activeElement` is inside the dialog or is `body` after each Tab, and the Risks line now says the same.

### Nits (optional, max 3)
- **N1.** The refund DTO is `@MinLength(5)` (`financial/src/controllers.ts:53`), not 10. Write 5 into decision 3, checked on the trimmed value, so the implementer doesn't log a deviation.
- **N2.** With `h-full` on the column, the bar's `%` height is measured against the whole column, value and month labels included. A full-height bar plus two labels then overflows the `h-36` box into the card title. Put the bar in a `flex-1` track and size it as a percentage of the track.
- **N3.** In the dialog, call `.focus()` after `showModal()`. React's `autoFocus` runs when the always-mounted `<dialog>` first renders, while it is still closed. When the dialog has a reason field, focus that field instead of Cancel or Confirm.

### Planner responses to the nits and point 4
- **N1:** taken. Decision 3 now says at least 5 characters after trimming, per `@MinLength(5)`.
- **N2:** taken. Decision 8: value label, then a `flex-1` track holding the bar, then the month label. The bar's height is a percentage of the track.
- **N3:** taken. Decision 1: `.focus()` after `showModal()`, with the reason field first when there is one.
- **Audit detail (point 3):** taken. Decision 9 puts `institution_id` in the `institution.member_left` detail, via `RETURNING` or a read afterwards.
- **Split (point 4):** taken as you partitioned it. The plan has a "Split" section with 8a (`feat/role-dashboards-a`: steps 2–4 and 7, plus `confirm.spec`, `admin.spec`, the leave e2e step and the `/admin` a11y entries) and 8b (`feat/role-dashboards-b` on 8a: steps 5, 6 and 8, plus `role-mobile.spec` and the remaining a11y entries). The app-wide native-dialog grep is 8b's acceptance; 8a checks its own files. Status is set to approved.


## Round 2 (2026-10-02) · Verdict: APPROVED (checks the round-1 fixes only)
Reviewed: `plan.md` (status "approved (round 1); split into 8a and 8b").

Resolved:
- **S1:** decision 3 has the fraud-resolve copy that matches the hold rules. The release dialog names the hold reason, and the step 4 vitest asserts both strings.
- **S2:** bulk seat assignment is in the Institution list, listing the de-duplicated emails, with a step 6 vitest.
- **S3:** step 9 and Risks say that `activeElement` is inside the dialog or is `body`.
- **Nits and the audit detail:** N1 (5 characters after trimming), N2 (a `flex-1` track) and N3 (`.focus()` after `showModal()`, the reason field first) are all taken, and `institution_id` is in the `member_left` audit detail.
- **Split:** applied as partitioned, and 8b is based on 8a.

No blockers, no should-fix. One optional note for the split: the admin-page words (raw `role`, `method`, `payee_type`, `signal_type`, the "FEATURES_ADDED.md" copy) are in 8a's step 4, but "Words" appears only in 8b's acceptance line. Add "words on admin pages" to 8a's acceptance so the 8a code review checks them.

## Drift check (2026-10-03, against origin/main 4b4a64c, 6a in flight, and the 7a/7b plans)
Not a review round: the plan stays APPROVED. A read-only check of the code this phase will be built on, after Phases 3–5 merged (`origin/main` 4b4a64c) and with 6a in flight (`fix/security-platform`). Subagents did the sweep; I verified every blocker against the code myself. The planner folds these into the plan before the handoff. Blocker here means the implementer would build something wrong or silently break a merged behaviour or test.

### Blockers
- **D1. Step 9 creates `admin.spec.ts` as a new file, but Phase 5 already ships it** (`web/e2e/admin.spec.ts`). It breaks two ways:
  - it opens Users with `getByRole('button', { name: 'Users' })` (:12), which fails once the tabs are `role="tab"`;
  - it waits for a native `dialog` event matching `/Reason for suspended/` (:17-24), which fails once `prompt` goes.

  Its header comment says it never confirms, because suspending a seeded account breaks the other specs.
  **Fix:** rewrite that file in 8a and fold `confirm.spec`'s Escape case into it. Run the Confirm case against a `page.route`-stubbed `/admin/users/*/status`, not a real user.
  Response: fixed. Step 9 rewrites Phase 5's `admin.spec.ts` (tab role, the dialog's Escape/Confirm/focus/Tab cases with the status route stubbed, then tabs, search, paging, Coupons); `confirm.spec.ts` is gone; Current state and Split say so.
- **D2. Step 9's `role-mobile.spec.ts` can't fail.** It asserts `documentElement.scrollWidth <= innerWidth`, but `globals.css:118,123` set `overflow-x: clip` on html and body, which hides overflow from that check.
  - Phase 5's `horizontalOverflow()` (`e2e/support.ts:94-97`) lifts the clip for exactly this reason.
  - `layout.spec.ts:45-63` already checks `/teach` at 375 px.

  **Fix:** add the editor, `/institution` and `/admin` to layout.spec's 375 px block, using `horizontalOverflow()`.
  Response: fixed. Step 9 adds them to `layout.spec.ts`'s 375 px block with `horizontalOverflow()` (plus the "New course" in-viewport check on `/teach`); no `role-mobile.spec.ts`; Split and Test plan updated.

### Fixes
- **D3. Current state, Mobile.** "`PageHeader` actions are `shrink-0`, so `/teach` is 409 px wide" is no longer true. Phase 5 (`fe8ce18`) made them `flex max-w-full shrink-0 flex-wrap` (`PageChrome.tsx:39`), and its 375 px sweep of 35 routes came back clean. Decision 12 is then the full-width change only, not a live overflow bug.
  Response: fixed. Current state now describes Phase 5's `max-w-full flex-wrap` and the clean sweep; decision 12 is worded as the full-width change.
- **D4. Decision 9 ("Removed · Left the institution").** `instructor-manager.tsx:85` renders `status_reason` only when `status === 'suspended'`. Add a step to show the reason on removed rows, with a case in `instructor-manager.test.tsx`.
  Response: fixed. Decision 9 and step 6 show `status_reason` on removed rows, with an `instructor-manager.test.tsx` case for "Left the institution".
- **D5. Decision 1 and step 2 (a `showModal` stub for jsdom).** Vitest runs happy-dom 20.11 (`web/vitest.config.mts:11`). Its `HTMLDialogElement` implements `showModal()` and `close()`, and `close()` fires `close`. There's no setup file. Drop the stub, and have tests dispatch `cancel` for Escape.
  Response: fixed. Decision 1, step 2 and Risks: no stub, tests dispatch `cancel` for Escape.
- **D6. Step 4 ("add a coupon-manager test").** 6a adds `coupon-manager.test.tsx`, which mocks `useAuth` as `{ user }` with no `ready`. Extend that file and add `ready` to its mock.
  Response: fixed. Step 4 extends 6a's `coupon-manager.test.tsx` and adds `ready` to its mock.
- **D7. Decision 8 (analytics errors).** 7b decision 6 adds `PanelError` ("Couldn't load <panel>." plus Retry). Reuse it.
  Response: fixed. Decision 8 and step 5 reuse 7b's `PanelError`.
- **D8. API contract, the leave POST ("400 non-UUID").** 6a replaces `ParseUUIDPipe` with `@UuidParam` in `profiles.controller.ts`, and its `auth/src/route-params.spec.ts` fails any `@Param` without a pipe. Use `@UuidParam('id')`.
  Response: fixed. API contract and step 3 use `@UuidParam('id')`.

Checked and unchanged:
- the 25 native-dialog sites;
- the admin page and its private `SearchPicker`;
- email-only `/admin/users` search, and `listPending`;
- no leave or list-membership endpoint (Phase 3 deferred it, as assumed);
- the active-only internal lookup, and `/account/invites`;
- `Bars`, preview, and `enabled: !isAdmin`.
