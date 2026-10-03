# Phase 8: UI polish II, role dashboards

Status: 8a in progress (ethio-planner, `feat/role-dashboards-a`); 8b queued. Approved in round 1; split into 8a and 8b (see "Split" below); drift check (2026-10-03) folded in
Size: M (sessions: 3 — ethio-impl implements, ethio-plan-review reviews plan and code)
Base branch: the tip of the stack when this phase starts. With one implementer the order is 5 → 6a → 6c → 6b → 7a → 7b → 8, so that is `feat/public-learner-pages`, or `origin/main` if 7b has merged by then. This phase needs 7a's primitives (`Field`, `FormStatus`, `useFormStatus`, `labels.ts`, `format.ts`, `use-dismiss.ts`), 6a's "Uses per learner" coupon field and 6c's "Bank reference" field, so it can't start earlier. · Feature branches: `feat/role-dashboards-a` (8a) from that base, then `feat/role-dashboards-b` (8b) from `feat/role-dashboards-a`
Roadmap: phase 8 · Findings: P1-41, P1-42, P1-44, P1-46, P1-47 (everything except the bell panel, which 7a fixes), the role-page parts of P1-43, P1-45 and P1-48; P2-38, P2-39, P2-41; the member-initiated "Leave institution" deferred from Phase 3 (plan-review N3). Picked up because they touch the same files: the role-page parts of P2-29 (editor tap targets), P2-35 (emoji status icons), P2-36 (`btn-danger`, `btn-sm` only) and P2-37 (debounced admin searches).

## Goal
Educators, institution admins, quality officers and platform admins should be able to trust their pages. A money-moving or destructive action never runs on one click, and its failure is never silent. Charts draw and empty states resolve. Admin lists reach past row 20 and find people by name. Every control has a name. The phone layout works. Phase 7a built the building blocks; this phase applies them to every role page.

Acceptance criteria:
- **Native dialogs are gone (P1-42).** `git grep -nE '\b(window\.)?(confirm|alert|prompt)\(' web/src` finds nothing outside tests. That covers all 25 sites, learner and account included.
- **Confirmation (P1-42).** Each action in decision 3's list asks first in a styled, translated, keyboard-safe dialog that names the object and, where there is one, the amount:
  - Escape and Cancel send nothing (the P0-10 rule, now app-wide);
  - a reason, when the action takes one, is typed in the dialog.
- **No silent failure (P1-42, P1-43).** Every role-page action catches its error and shows it as an error (`role="alert"`, danger style). Successes are polite and look different. A button is disabled while its request runs.
- **Analytics (P1-41):**
  - bars draw at their real height, with month names and visible values;
  - a screen reader gets each month's value;
  - an educator with no courses sees an empty state, not an endless skeleton;
  - empty admin lists ("By purpose", "Top courses") say so.
- **Admin workflows (P1-44):**
  - no raw UUID inputs: the wallet user, the coupon course and the bank-transfer learner and course are type-to-search pickers;
  - Users and Payments page past 20 rows and show "Showing 21–40 of N";
  - user search matches name or email.
- **Admin tabs (P2-38):**
  - the selected tab is in the URL (`?tab=payments`), so a reload or a shared link opens it;
  - the tabs are real ARIA tabs (arrow keys, Home, End);
  - at 375 px they are one scrollable row.
- **Small admin fixes:**
  - the Coupons tab makes no `GET /courses` call, so no 403 (P2-39);
  - an admin sees no Suspend or Ban on their own row (P2-41).
- **Preview (P1-46):**
  - the editor has a "Preview as learner" link;
  - the preview player shows a prompt until a lesson plays;
  - the playing lesson has `aria-current`;
  - the outline headings sit under the page `h1`.
- **Mobile (P1-47):** at 375 px no role page scrolls sideways, and the header actions ("New course"), the editor's AI topic, the tutor note title and the invite inputs are full width.
- **Words (P1-45):**
  - no raw enum, vendor name, env var or file name on a role page;
  - the API's submit blocker says "Set a price before submitting a paid course".
- **Leave institution:** an instructor can leave their institution from `/account/invites`. Leaving ends routing through that institution for new courses. Courses already made for it stay with it, and the role stays educator.
- **Regression gate:** 7a's axe check also covers the role pages listed in step 9 (light and dark, zero serious or critical). A 375 px check finds no horizontal overflow on `/teach`, the editor, `/institution` and `/admin`.

## Split (plan-review round 1, point 4)
The work is about 60 files. The money-moving confirm wiring and two new auth endpoints would sit inside about 190 mechanical label and status swaps, so it ships as two PRs from this one plan:
- **8a, admin console, shared dialog and leave** (`feat/role-dashboards-a`):
  - steps 2, 3, 4 and 7;
  - from step 9: the rewritten `admin.spec.ts` (it absorbs the dialog cases; drift D1), the `e2e-institution.mjs` leave step and the `/admin` a11y entries.
  - **Acceptance:** confirmation and no-silent-failure for every admin, learner and account action; admin workflows; admin tabs; the small admin fixes; words on the admin pages (role, method, payee, fraud signal and subject, purpose, the broadcast note); Leave institution; the native-dialog grep finds nothing in the files 8a touches; the API copy.
- **8b, educator, institution, QA and preview** (`feat/role-dashboards-b`, based on 8a):
  - steps 5, 6 and 8;
  - from step 9: the role pages added to `layout.spec.ts`'s 375 px block (drift D2) and the remaining a11y entries.
  - **Acceptance:** analytics; preview; mobile; words and labels on the educator, institution and QA pages; the app-wide native-dialog grep finds nothing outside tests.
- **Shared steps:**
  - step 10 (screenshots) and step 11 (full gate) run for each part;
  - step 12 is one code review per part.
- Each part has its own Progress section at the end of this plan.

## Non-goals
- **Payee names on payouts.** That needs a batched cross-service user lookup (P1-22, Phase 9). Payouts show the payee's role label and a short id.
- **Unbounded lists:** payouts, refunds and analytics reads (P2-04, Phase 9). This phase pages only the two lists the API already pages.
- **A toast system** (decision 2).
- **Around leaving an institution:**
  - a distinct `left` membership status, which would need a CHECK migration;
  - a notification to the institution owner when someone leaves.

  Leaving sets `removed` with the reason "Left the institution" (decision 9).
- **Translating role pages into Amharic** (English-first, Phase 10). Generic dialog strings (Cancel, Confirm) get `t()` keys in both dictionaries.
- **The wider styling-drift cleanup** (P2-36) beyond `btn-danger` and `btn-sm`; `next/image` (P2-26, Phase 10); chat polling in hidden tabs (the messages part of P2-37).
- **Money logic.** Dialogs wrap the existing calls. No endpoint changes behaviour, except the two read additions in the API contract and the new leave endpoints.

## Current state
Line numbers are from `fix/payment-integrity` at `2cdccf9`. Phases 5, 6a, 6c, 6b, 7a and 7b edit several of these files first, so re-find each site by its code, not its line.

- **Native dialogs (25 sites).** These numbers are from the grep in the acceptance criteria:
  - `admin/page.tsx:149,151,217,315,323,350,407,425`;
  - `qa/page.tsx:215`;
  - `institution/instructor-manager.tsx:39,43,48,113`;
  - `institution/page.tsx:92`;
  - editor: `teach/courses/[id]/page.tsx:131`, `course-tools.tsx:180`, `revision-banner.tsx:139`, `sections-editor.tsx:65,135`, `structure-generator.tsx:160`, `video-upload.tsx:331`;
  - learner and account: `(learn)/dashboard/page.tsx:420,424,426` (refund reason via `prompt`, result via `alert`) and `(account)/account/page.tsx:144` (delete account).
- **One-click money and destructive actions with no confirmation:**
  - run payouts (`admin/page.tsx:213-222`), release a held payout (`:232-240`);
  - refund approve and deny (`:266-267`), resolve a fraud flag (`:290-298`);
  - mark a bank transfer (`:143-156`), unlist (`:423`);
  - broadcast (`growth-tabs.tsx:94-114`), wallet adjust (`:138-150`);
  - coupon deactivate (`coupon-manager.tsx:97-105`);
  - editor unpublish (`teach/courses/[id]/page.tsx:125`);
  - institution unlist (`institution/page.tsx:137`).
  - Payouts, refunds, fraud and coupon deactivate have no try/catch, so a failure is an unhandled rejection and nothing visible happens.
- **No dialog or toast exists in `web/src`.** `globals.css` has `.btn`, `.btn-secondary` and `.btn-ghost`, but no danger or small button.
- **`SearchPicker`** is a private function in `admin/page.tsx:161-204`:
  - no debounce;
  - its label isn't linked to its input;
  - no combobox semantics;
  - the bank-transfer learner picker filters `role === 'learner'` on the client after the API returns 20 rows, so learners past the first 20 matches never appear.
- **Admin lists:**
  - `GET /admin/users` already takes `page` and `limit` and returns `total` (`auth/src/admin.controller.ts:25-47`), but searches `email ILIKE` only (`:30`);
  - `GET /admin/payments` takes `page` and `limit` (`financial/src/controllers.ts:199-204`, `payment.service.ts:644-671`);
  - the web shows page 1 only.
  - Wallet adjust takes a raw "User id (from the Users tab)", but the Users tab shows no ids (`growth-tabs.tsx:142`). The admin coupon course is a raw UUID input (`coupon-manager.tsx:49`).
- **Refund rows** (`refund.service.ts:135-138`) carry the reason but no amount or course, so a confirmation can't name them yet.
- **Admin tabs** (`admin/page.tsx:13-61`):
  - `useState`, so a reload returns to Analytics;
  - plain pills that wrap into four rows at 375 px;
  - no tab semantics.
- **Coupons** (`coupon-manager.tsx:15`): `enabled: !isAdmin` runs before auth is ready (`useAuth` returns `{ user, ready }`, `lib/hooks.ts:7`).
- **Own row:** Suspend and Ban show on the admin's own row (`admin/page.tsx:345-351`); the API refuses (`admin.controller.ts:52`).
- **Charts:**
  - `Bars.tsx:7-11`: columns lack `h-full`, so `height: N%` resolves to 0. Labels are `month.slice(5)` ("10"), values show on hover only, and the text is 9–10 px.
  - `teach/analytics/page.tsx:17-21`: `enabled: ids.length > 0`, so with no courses the enrollments chart is a skeleton forever. The 8-column table has no horizontal scroll (`:86`).
  - `growth-tabs.tsx:43-70`: "By purpose" and "Top courses" render bare titles when empty. `EmptyRows` is private to `admin/page.tsx:63-73`.
- **Preview** (`(admin)/preview/[id]/page.tsx`):
  - always the live version, roles educator, institution admin, QO and admin (`:820-826`);
  - an empty black `<video>` until a lesson is clicked (`:138-140`);
  - no active-lesson marker;
  - section titles are `h3` directly under the `h1` (`:147`).
  - The editor has no link to it; only the revision panel links to the revision diff (`revision-banner.tsx:99,146`).
- **Labels and messages:**
  - role pages have about 88 controls; most have no programmatic label. Editor quiz builder: `teach/courses/[id]/page.tsx:426-470`, including the ✕ buttons and the correct-answer radio.
  - About 100 `setMessage`/`setStatus`/`setNote`/`badge-info` sites share one style for success and error. Examples: `teach/courses/[id]/page.tsx:77,139`, `coupon-manager.tsx:74`, `growth-tabs.tsx:112,149`, `admin/page.tsx:393`.
  - `EducatorSetup` (`teach/page.tsx:138-146`) and `InstitutionSetup` (`institution/page.tsx:67-74`) have no try/catch.
- **Raw words on role pages:**
  - `u.role` (`admin/page.tsx:342`);
  - `p.method`, `p.payee_type` (`:106,110,227`);
  - `signal_type`/`subject_type` (`:287`);
  - `c.category · c.pricing_type` (`teach/page.tsx:94`, `preview:134`);
  - `course.pricing_type` and "AI viva (Groq)" (`teach/courses/[id]/page.tsx:109,428`);
  - "set GROQ_API_KEY…" (`:372`);
  - `a.type.replace('_',' ')` (`:415`);
  - "see FEATURES_ADDED.md" (`growth-tabs.tsx:114`);
  - `k.replace('_',' ')` (`:50`);
  - `owner_type`/`trigger` (`qa/page.tsx:256-257`);
  - "Preview · status: {course.status}" (`preview:127`);
  - knowledge source chips (`course-tools.tsx:167`);
  - "price_etb is required for paid courses" (`api/services/course/src/course.service.ts:681`);
  - emoji status icons at `teach/courses/[id]/page.tsx:144,252-266` and `structure-generator.tsx:281`.
- **Mobile:**
  - `PageHeader` actions are already `flex max-w-full shrink-0 flex-wrap` (Phase 5, `fe8ce18`, `PageChrome.tsx:39`), and Phase 5's 375 px sweep of 35 routes found no overflow. They still sit beside the title at their own width, so decision 12 is the full-width change, not an overflow fix (drift D3);
  - the AI topic input is about 50 px (`teach/courses/[id]/page.tsx:440`), the tutor note title about 35 px (`course-tools.tsx:134`), and the instructor invite inputs about 65 px.
- **Membership** (Phase 3):
  - `institution_instructors.status` is one of `invited | active | suspended | removed | declined` (CHECK). There is a partial unique index on `(user_id) WHERE status = 'active'`.
  - Members can see and answer invites (`GET /profiles/me/institution-invites`, accept, decline; `membership.service.ts:168-237`), but they can't list their memberships or leave.
  - `/account/invites` (learner and educator) lists pending invites only. Only `PendingInvitesBanner` links to it.
  - `instructor-manager.tsx` (`:85` at `4b4a64c`) shows `status_reason` only when `status === 'suspended'`, so a removed row shows no reason today (drift D4).
- **Tests:**
  - vitest specs exist for the editor (`page.test.tsx`, `revision-banner.test.tsx`, `structure-generator.test.tsx`, `video-upload.test.tsx`), `admin/page.test.tsx` (the P0-10 cancel rule), `instructor-manager.test.tsx` and `invites-list.test.tsx`;
  - `auth/src` has no spec for `AdminUsersController`;
  - Phase 5 adds Playwright with one saved login per seeded role; 7a adds `e2e/a11y.spec.ts`.
  - **Phase 5 already ships `web/e2e/admin.spec.ts`** (the P0-10 cancel rule in a browser). It opens Users with `getByRole('button', { name: 'Users' })` and waits for a native `dialog` event matching `/Reason for suspended/`, so both break in step 4. It never confirms, because suspending a seeded account breaks the other specs (drift D1).
  - **Overflow checks:** `globals.css` sets `overflow-x: clip` on html and body, so `scrollWidth <= innerWidth` can't fail. Phase 5's `horizontalOverflow()` (`e2e/support.ts`) lifts the clip first, and `layout.spec.ts` already checks `/teach` at 375 px with it (drift D2).
  - **Vitest runs happy-dom 20.11** (`web/vitest.config.mts`), not jsdom. Its `HTMLDialogElement` implements `showModal()` and `close()`, and `close()` fires `close`. Escape doesn't fire `cancel`. There's no vitest setup file (drift D5).
  - **6a adds `coupon-manager.test.tsx`**, which mocks `useAuth` as `{ user }` with no `ready` (drift D6).

## Design and key decisions
1. **One confirmation dialog, `useConfirm()`, on the native `<dialog>`:**
   - **Where it lives:** `web/src/components/confirm/ConfirmProvider.tsx` is mounted once in `Providers`. It renders one `<dialog>` and opens it with `showModal()`, which gives a real modal for free: top layer, inert background, Escape through the `cancel` event, `::backdrop`.
   - **API:**
     ```ts
     const ask = useConfirm();
     const ok = await ask({ title, body?, confirmLabel, tone?: 'danger' | 'default', reason?: { label: string; required?: boolean; minLength?: number; maxLength?: number } });
     // ok: false | { reason: string }
     ```
     Call sites stay one line: `if (!(await ask({...}))) return;`. The returned function is called `ask`, never `confirm`, so the acceptance grep for native dialogs stays meaningful.
   - **Focus:** call `.focus()` right after `showModal()`, never React `autoFocus`, because the always-mounted dialog first renders closed. With a reason field, that field gets focus. Otherwise Cancel gets it for `danger` and Confirm for `default`. Closing returns focus to the element that had it.
   - **Labelling:** `aria-labelledby` (title) and `aria-describedby` (body).
   - **The reason field** is a 7a `Field`. Confirm stays disabled until a required reason meets `minLength`.
   - **A second call while one is open** resolves the first as `false`. Only one dialog is ever shown.
   - **Strings:** Cancel and the default Confirm label use `t()`.
   - **Tests:** happy-dom implements `showModal()` and `close()` (and `close()` fires `close`), so there's no stub. Tests dispatch a `cancel` event on the dialog for Escape. Playwright exercises the real element (drift D5).
   - **New CSS:** `.btn-danger` (red, 4.5:1 in both themes) and `.btn-sm` for row actions (min 32 px tall, the P2-29 part) go in `globals.css`.
   - **Rejected:**
     - a headless UI library (Radix or Headless UI) for one dialog;
     - a hand-rolled `div role="dialog"` with a focus trap, because `showModal` does modality and inertness better than our own code would;
     - reusing 7a's `useDismiss`, which is for non-modal popovers.
2. **Outcomes go through 7a's `FormStatus`, per card; no toasts.**
   - Each card or section with actions gets one `useFormStatus()`. Every action is `try { … setOk(…) } catch (e) { setError(message(e)) }`, and its button is disabled while it runs. This also stops double clicks on "Run payouts" and "Mark bank transfer".
   - The status sits next to the action, and `FormStatus`'s two live regions announce it.
   - Rejected: a global toast queue. Auto-dismiss timing is a WCAG 2.2.1 problem, and it's a second pattern next to `FormStatus` for the same job.
3. **What confirms.** The dialog names the object, plus the amount where there is one. ✱ = danger tone.
   - **Admin:**
     - run payouts ("Pay every eligible educator and institution now?");
     - release a held payout (payee, net ETB and the hold reason through `labels.ts`, e.g. "Held: KYC required", because `release()` clears any hold, KYC included);
     - approve a refund ✱ and deny a refund (course, amount and the learner's reason);
     - resolve a fraud flag (signal and subject). Copy: "Clears this flag. Payouts held for fraud go out once this payee has no open flags. Payouts over the KYC limit still wait for KYC." This matches Phase 4's hold rules (`payout.service.ts`: fraud holds release only when no flag is left open; payouts over the KYC threshold move to `kyc_required`);
     - mark a bank transfer (learner, course, bank reference; "grants access now");
     - wallet credit or debit (user, signed amount);
     - broadcast (audience, e.g. "every user");
     - unlist; archive ✱ (terminal);
     - suspend ✱ and ban ✱ (reason, optional);
     - coupon deactivate ✱ (irreversible).
   - **Educator:**
     - unpublish ("hidden from the catalog; enrolled learners keep access") and archive ✱;
     - remove a section or lesson ✱;
     - replace the outline draft;
     - discard staged changes ✱;
     - remove a tutor note ✱;
     - restart a mismatched upload.
   - **Institution:** unlist; suspend ✱ (reason, optional); remove ✱; assign bulk seats (default tone: "Assign {n} seats of {course}? Assigned seats can't be moved to someone else.", listing the parsed, de-duplicated emails), because there is no unassign endpoint.
   - **QA:** decisions that already carry `opt.confirm`.
   - **Learner and account:**
     - refund request (reason required, at least 5 characters after trimming, matching the DTO's `@MinLength(5)`, `financial/src/controllers.ts:53`);
     - delete account ✱;
     - leave institution ✱.
   - Reversible actions don't confirm: reactivate, restore, duplicate, withdraw, re-publish, project pass/fail.
   - **Refund rows** get `amount_etb` and `course_title` from their payment rows, with one `In()` query in `listPending` (API contract), so the approve dialog can name them.
4. **`SearchPicker` becomes `web/src/components/SearchPicker.tsx`, an accessible combobox:**
   - `Field`-labelled `input role="combobox"` with `aria-expanded`, `aria-controls` and `aria-activedescendant`;
   - `ul role="listbox"` of `role="option"`;
   - ArrowUp, ArrowDown, Enter and Escape;
   - a "No matches" row;
   - 300 ms debounce through a tiny `useDebouncedValue` (`web/src/lib/use-debounced-value.ts`), also used by the Users, Courses and bulk-purchase searches (P2-37 part);
   - the selected value shows as a chip with a named clear button ("Clear learner").
   - **Uses:**
     - bank-transfer learner and course;
     - wallet user;
     - admin coupon course (empty means every paid course, as today).
   - **Learner pickers send `&role=learner`**, so the API filters before paging. The client-side filter goes.
   - **Rejected:** `<datalist>`, which has no async results and no id/label split.
5. **Admin user search matches name or email:**
   - `where: [{ email: ILike(p), ...role }, { name: ILike(p), ...role }]`, with `p = %${escapeLike(q.trim())}%`;
   - `escapeLike` escapes `\`, `%` and `_`, so "a_b" matches literally;
   - `q` is capped at 100 characters (400 above);
   - no index: a leading-wildcard `ILIKE` can't use a btree, and the users table is small at launch. Trigram search, if ever needed, is a Phase 9 or 10 call.
6. **Pagination.** A small `Pager` (`web/src/components/Pager.tsx`): Previous and Next buttons plus "Showing 21–40 of 132" in a `role="status"`.
   - The page is in the query key, with `placeholderData: keepPreviousData`, so the list doesn't flash.
   - Page size 20 (the API default). The page resets to 1 when the search changes.
   - Users and Payments use it.
   - Rejected: keyset or infinite scroll. Offset is fine for admin lists with totals at this size.
7. **Admin tabs:**
   - **URL:** `?tab=` read with `useSearchParams` inside a `Suspense` boundary, the way the editor does (`ManageCourseFromUrl`). In Next 14.2, a bare `useSearchParams` fails `next build` on a static page (7a round-1 S2). Writes use `router.replace(`?tab=${id}`, { scroll: false })`. An unknown value falls back to Analytics.
   - **ARIA tabs:**
     - `role="tablist"` with `aria-label="Admin sections"`;
     - each tab is `role="tab"` with `aria-selected`, `aria-controls` and a roving `tabIndex`;
     - Left, Right, Home and End move and activate (automatic activation, as clicking does today);
     - the panel is `role="tabpanel"` with `aria-labelledby`.
   - **Mobile:** one row, `flex-nowrap overflow-x-auto` with scroll snap, and the selected tab scrolled into view.
8. **`Bars` draws and explains itself:**
   - each column is a flex column: value label, then a `flex-1` track holding the bar, then the month label. The bar's height is a percentage of the track, so a full-height bar plus its labels stays inside the `h-36` box;
   - month labels come from 7a's `format.ts`, extended with a `'month'` style (`{ month: 'short' }`, with the year on January and in the screen-reader text);
   - values are visible above non-zero bars at `text-xs` (7a's 12 px floor);
   - the chart is a `ul` with an `aria-label` (the chart title), and each `li` has sr-only text: "October 2026: 1,200 ETB";
   - all-zero data renders an empty state, e.g. "No revenue in the last 12 months", instead of flat bars;
   - a `format` prop keeps ETB through `formatETB`.
   - **Loading:** `teach/analytics` treats "courses loaded, none" as loaded-empty, so the enrollments chart and table show `EmptyRows` ("Publish a course to see analytics"). Query errors show 7b's `PanelError` ("Couldn't load <panel>." plus Retry calling the query's `refetch`) instead of a skeleton, so there's one error pattern (drift D7).
   - `EmptyRows` moves to `web/src/components/EmptyRows.tsx`, and the admin "By purpose" and "Top courses" lists use it when empty.
   - The analytics table gets an `overflow-x-auto` wrapper.
   - Rejected: a chart library for two bar charts.
9. **Leave institution (consent both ways):**
   - **API** (auth, `membership.service.ts`):
     - `myMemberships(userId)` returns the user's `active` and `suspended` rows with the institution name;
     - `leave(userId, membershipId)` is one conditional `UPDATE … SET status = 'removed', status_reason = 'Left the institution' WHERE id = $1 AND user_id = $2 AND status IN ('active','suspended')`. Zero rows → 404, the same answer for "not yours" and "not leavable", so there's no oracle. It then writes the audit row `institution.member_left`, with `institution_id` in the detail (from `RETURNING institution_id`, or a read afterwards as `setStatus` does).
     - **No migration:** `removed` already exists. The institution admin's list shows "Removed · Left the institution" from the existing `status_reason`; today `instructor-manager` renders the reason only for suspended rows, so step 6 shows it on removed rows too (drift D4). Re-inviting works as it does from `removed` today.
     - **Effects come from Phase 3's rules:** the internal lookup only returns `active`, so new courses are independent. Existing institution courses keep their `institution_id`, and the role stays educator.
   - **Web:**
     - `/account/invites` becomes "Institutions": pending invitations first, then "Your institution" with a Leave button (danger confirm: "Leave {name}? New courses you create won't go through their review. Courses you already made for them stay with them.");
     - if the GET returns 404 (web deployed before the API), the section hides;
     - `/account` gets an "Institutions" link for learners and educators, because today only the pending-invite banner reaches the page.
   - Rejected: a separate `left` status (needs a CHECK migration for a label) and an owner notification (non-goal).
10. **Words on role pages:**
    - 7a's `labels.ts` gains `paymentMethodLabel`, `payeeLabel`, `fraudSignalLabel`, `fraudSubjectLabel`, `assessmentTypeLabel`, `purposeLabel`, `knowledgeSourceLabel`, `qaTriggerLabel` and `ownerTypeLabel`. Unknown values fall back to sentence case, never the raw enum.
    - **Rewritten strings:**
      - "AI questions are unavailable right now — add questions manually.";
      - "AI oral check (viva)";
      - "Delivered to each user's notification bell. Email announcements aren't sent from here.";
      - correct plurals;
      - the preview badge "Preview · {statusLabel}".
    - Payees show as "Educator · c536c035" (non-goal: names).
    - **Emoji status icons** on role pages become lucide icons with `aria-hidden`.
    - The API's submit blocker reads "Set a price before submitting a paid course."
11. **Every role-page control gets a name:**
    - **`Field`:** a visible label where there's room. Examples:
      - editor assessment type, pass score and integrity settings;
      - coupon form, including the expiry date;
      - wallet amount and reason;
      - broadcast title, message, link and audience;
      - staff invite;
      - instructor invite;
      - bulk purchase;
      - educator and institution setup;
      - tutor note title and file;
      - AppealBox.
    - **`aria-label`** on inline searches and repeated rows: "Search users", "Question 2 prompt", "Option 3 of question 2", "Correct answer for question 2" (radio), "Remove option 3 of question 2", "Remove question 2".
    - **Messages:** the editor `message`, AssessmentManager `note`, course-tools status, coupon, broadcast, wallet, staff, bulk purchases, instructor manager, institution review and QA all go through `FormStatus` with the right tone.
12. **Mobile (P1-47):**
    - `PageHeader` actions become `flex w-full flex-wrap gap-2 sm:w-auto` (no `shrink-0`). Phase 5 already stops them overflowing (`max-w-full flex-wrap`); this makes them full width below `sm` (drift D3);
    - inline inputs get `min-w-0 basis-full sm:basis-auto`;
    - admin and teach rows wrap their action groups;
    - editor lesson actions use `btn-sm`, at least 32 px (P2-29).
13. **Preview (P1-46):**
    - the editor header gets a "Preview as learner" link to `/preview/{id}`, which shows what learners see. For a live course with staged changes, the revision panel keeps its "Preview changes" diff link.
    - The empty player shows an overlay, "Choose a lesson to start the preview", over a poster (the thumbnail when there is one), on a fixed-dark surface (`text-white/80`, 7a decision 4).
    - The playing lesson's button gets `aria-current="true"` and a visible active style.
    - Section titles become `h2`.
    - The implementer confirms on the local stack that the owner of a draft can open `/preview/{id}`. If the API refuses drafts, the link shows only once the course is past draft, and that goes under Deviations.
14. **Small fixes:**
    - `CouponManager`: `enabled: ready && !isAdmin` (P2-39);
    - `UsersTab` hides Suspend and Ban when `u.id === user.id` and shows a "You" badge (P2-41).

## API contract
| Endpoint | Auth | Request | Response |
|---|---|---|---|
| `GET /admin/users` (changed) | platform_admin | `q?` (≤100 chars, matches name or email, case-insensitive, wildcards literal), `role?`, `page?`, `limit?` | 200 `{ total, items }` as today; 400 when `q` > 100 |
| `GET /refunds/pending` (changed, additive) | platform_admin | — | 200 each row as today plus `amount_etb`, `course_title` (from its payment; `null` if the payment is missing) |
| `GET /profiles/me/institution-memberships` (new) | any signed-in role | — | 200 `[{ id, institution: { id, name }, status: 'active' \| 'suspended', joined_at }]` |
| `POST /profiles/me/institution-memberships/:id/leave` (new) | any signed-in role, own membership | — | 200 `{ status: 'removed' }`; 404 if not the caller's or not active/suspended; 400 non-UUID (through 6a's `@UuidParam('id')`) |

The `:id` param uses 6a's `@UuidParam('id')`, not `ParseUUIDPipe`: 6a's `auth/src/route-params.spec.ts` fails any `@Param` without one of its pipes (drift D8). The implementer checks that the gateway already routes `profiles/me/*` to auth, and that the new POST falls in the general write bucket. If either needs a line in `routes.ts` or `rate-policy.ts`, that goes under Deviations.

## Data model and migrations
None. Leaving reuses the existing `removed` status and `status_reason`.

## Steps
- [ ] 1. Branch `feat/role-dashboards` from the base above.
- [x] 2. Shared pieces (decisions 1, 4, 6, 8):
  - `ConfirmProvider`/`useConfirm` mounted in `Providers`;
  - `.btn-danger` and `.btn-sm`;
  - `SearchPicker` moved and made a combobox;
  - `useDebouncedValue`, `Pager`, `EmptyRows`, the `Bars` rewrite;
  - the `format.ts` month style and the `labels.ts` additions.
  - No `showModal` stub: happy-dom has the methods; tests dispatch `cancel` for Escape (drift D5).

  vitest:
  - the dialog: Cancel and Escape resolve `false` and return focus; Confirm resolves with the reason; a required reason disables Confirm; a second call resolves the first `false`;
  - `SearchPicker`: debounce, arrow keys and Enter select, Escape closes, the chip clears;
  - `Pager`: range text and disabled ends;
  - `Bars`: non-zero height styles, sr-only month and value text, the empty state when all values are zero;
  - the new labels: known values and the unknown fallback.
- [x] 3. API (decisions 3, 5, 9):
  - users search;
  - `listPending` amount and course;
  - `myMemberships` and `leave`, with routes and DTO; the leave route's `:id` uses `@UuidParam('id')` (drift D8);
  - the submit-blocker copy.

  Specs:
  - new `auth/src/admin.controller.spec.ts`: name or email match, role filter kept on both branches, `%`/`_` literal, `q` > 100 → 400;
  - membership spec: list returns only active and suspended rows; leave active → removed and audited; leave suspended → removed; another user's id → 404; an invited or removed row → 404; after leaving, the internal lookup returns nothing;
  - refund spec: `listPending` carries `amount_etb` and `course_title` with one payments query;
  - the course spec string.

  Run `pnpm -C api test`.
- [x] 4. Admin console (decisions 2–8, 10, 11, 14):
  - tabs;
  - Payments (Pager, bank transfer with pickers, 6c's reference as a `Field`, confirm, `FormStatus`);
  - Payouts (confirm run and release, labels);
  - Refunds (confirm with course and amount);
  - Fraud (confirm, labels);
  - Users (debounced search, Pager, own row, a confirm with reason replacing `prompt`/`confirm`, labels);
  - Staff form;
  - Courses (confirm unlist and archive);
  - growth tabs: analytics empty states, broadcast confirm, wallet picker and confirm, copy;
  - Coupons (P2-39, course picker, `Field`, deactivate confirm).

  vitest: update `admin/page.test.tsx` (Cancel on the suspend dialog sends nothing; a reason is sent; no Suspend or Ban on your own row; `?tab=users` opens Users; ArrowRight moves the tab; the fraud-resolve and payout-release dialog strings, including the hold reason) and extend 6a's `coupon-manager.test.tsx` (add `ready` to its `useAuth` mock; no `/courses` call for an admin, including while `ready` is false) (drift D6).
- [ ] 5. Educator pages (decisions 2, 3, 8, 10–13):
  - `/teach` (labels, wrapping actions, EducatorSetup with `Field` and try/catch);
  - `/teach/new` (`Field`);
  - `/teach/analytics` (Bars, loaded-empty state, 7b's `PanelError` for errors, table scroll);
  - the editor page (Preview as learner, `FormStatus`, confirm unpublish and archive, AssessmentManager `Field`s and quiz-builder names, words, icons);
  - `sections-editor`, `structure-generator`, `video-upload`, `revision-banner`, `course-tools` (confirms, `Field`, `FormStatus`, `btn-sm`, icons).

  vitest: update the editor specs for the dialog, plus one for the quiz builder's accessible names and one for analytics loaded-empty (no skeleton when `/courses` returns `[]`).
- [ ] 6. Institution, review, QA and preview:
  - institution page (setup `Field` and try/catch, unlist confirm);
  - `instructor-manager` (confirms with reason, `FormStatus`, `Field`; show `status_reason` on removed rows too, drift D4);
  - `bulk-purchases` (`Field`, debounce, `FormStatus`);
  - `institution/review` (`FormStatus`);
  - `qa` (the dialog replaces `window.confirm`, labels);
  - preview (decision 13).

  vitest: update `instructor-manager.test.tsx`, with a case for a removed row showing "Left the institution"; add a bulk-purchases test (Cancel on the assign dialog sends nothing; the dialog lists the de-duplicated emails); add a preview test (prompt before play, `aria-current` after).
- [x] 7. Learner and account:
  - dashboard refund (confirm with required reason, `FormStatus` instead of `alert`);
  - account delete (confirm);
  - `/account/invites` → Institutions with Leave;
  - the `/account` link.

  vitest: extend `invites-list.test.tsx` (Leave → confirm → POST → the section refreshes; a 404 on the GET hides the section).

  Verify: the native-dialog grep from the acceptance criteria finds nothing outside tests.
- [ ] 8. Mobile pass (decision 12) at 375 px over every role page touched above.
- [ ] 9. Playwright (8a parts written, run in step 11), reusing Phase 5's saved logins (no new `auth-strict` calls):
  - **`a11y.spec.ts` gets the role pages**, at 1440 in light and dark:
    - `/teach`, `/teach/new`, `/teach/analytics`, `/teach/coupons`, the editor of a seeded draft;
    - `/institution`, `/institution/review`;
    - `/admin?tab=` analytics, payments, users, coupons, wallet and broadcast;
    - `/qa`, `/preview/{seeded course}`.
  - **`layout.spec.ts`'s "no sideways overflow at 375 px" block** gains the editor of a seeded draft (educator), `/institution` (institution admin) and `/admin` (platform admin), each checked with Phase 5's `horizontalOverflow()`; `/teach` is already there. On `/teach`, the "New course" link is fully inside the viewport. No new `role-mobile.spec.ts`: a plain `scrollWidth <= innerWidth` check can't fail under the `overflow-x: clip` on html and body (drift D2).
  - **`admin.spec.ts` is rewritten** (Phase 5's file; its Users button and native `prompt` are gone after step 4; drift D1). It keeps the header comment's rule: never suspend a real seeded user.
    - Users is opened with `getByRole('tab', { name: 'Users' })`;
    - Suspend → Escape → no request to `/admin/users/*/status` (the P0-10 guard, now on the dialog);
    - Suspend → type a reason → Confirm, with `page.route('**/admin/users/*/status', …)` answering 200 so no real account changes → the stubbed request's body has the reason;
    - focus returns to the Suspend button;
    - Tab never focuses anything behind the dialog: after each press `document.activeElement` is inside the `<dialog>` or is `body`. `showModal()` makes the page inert but lets focus wrap out through the document, so this spec doesn't assert a full trap;
    - `/admin?tab=users` opens Users, and a reload keeps it;
    - a name search finds a seeded user by name;
    - Next shows rows 21+ when the seed has more than 20 users (skip with a note if it doesn't);
    - the Coupons tab triggers no 403 response.
  - **`scripts/e2e-institution.mjs`** (API e2e, already in CI) gains a leave step: the member leaves → the membership is `removed` with the reason → the member's next course is independent → leaving again → 404.
- [ ] 10. Screenshots: before and after of every touched role page at 375 and 1440 (light; dark for the editor and admin), plus the confirm dialog, into `docs/plans/2026-10-02-refinement-audit/screenshots/after-phase8/` (git-ignored).
- [ ] 11. Full gate:
  - `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`;
  - `pnpm -C api build && pnpm -C api test && pnpm -C api typecheck && pnpm -C api db:check` (no drift, since there's no migration);
  - the Playwright suite against the local stack, with Phase 5's build order and restart rule;
  - `scripts/e2e-institution.mjs`;
  - on the PR, the CI `web`, `api` and `e2e` jobs pass.
- [ ] 12. Code review by ethio-plan-review; the user approves push and PR.

## Test plan
- **API (jest, the codebase's mock style):** the admin users search, refund listing, membership list and leave, and the submit-blocker copy (step 3).
- **vitest:** the shared pieces (step 2), the admin console (step 4), editor and analytics (step 5), institution and preview (step 6), invites and Leave (step 7). The i18n parity test covers the new dialog keys.
- **Playwright:** a11y on role pages, role-page overflow in `layout.spec.ts`, the rewritten `admin.spec.ts` (the dialog, admin tabs, search and paging, the Coupons tab) (step 9), plus every Phase 5, 7a and 7b spec still green.
- **API e2e:** the leave step in `scripts/e2e-institution.mjs`.
- **Commands:**
  - `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`;
  - `pnpm -C api test`;
  - with the stack running and web on :3000, `pnpm -C web exec playwright test`;
  - `node scripts/e2e-institution.mjs`.

## Rollout and ops
- **No migration, no env change.** Auth, course and financial redeploy with additive changes.
- **Order:** Render (API) and Vercel (web) both deploy on merge. If web lands first, the Institutions section hides on the 404 and refund dialogs omit the amount until financial is live. Nothing breaks either way.
- **Logging:** leaving writes the audit row `institution.member_left`. The other changes are reads or UI.
- **Production checks for the user** (read-only, after deploy):
  - open `/admin?tab=users` and search a known name;
  - open a refund's approve dialog and cancel it, so nothing is sent.

## Risks and open questions
- **Line drift:** six phases edit these files first. The implementer re-finds sites by code; 7a's primitive names are taken from what 7a shipped.
- **PR size:** about 60 files, so the work ships as 8a and 8b (see "Split"). Within each part, commits follow the steps, so the reviewer can read one area at a time.
- **happy-dom has no real `<dialog>` modality** (no top layer, inertness or Escape → `cancel`): unit tests check the contract (resolve values, focus calls, a dispatched `cancel`), and Playwright checks real modality, Escape, and that Tab never reaches the page behind.
- **Native `<dialog>` support:** Safari 15.4+, Chrome 37+, Firefox 98+. All are older than anything the app already needs (Next 14 targets them).
- **Seed data:** the paging spec needs more than 20 users. If the seed has fewer, the spec skips with a note, and the vitest Pager test plus the API spec carry the check.

## Progress and deviations (implementer)

### 8a

Steps 2, 3, 4 and 7 are done, and the 8a parts of step 9 are written (the `/admin` a11y entries, the `admin.spec.ts` rewrite, the institution leave step). Steps 10 and 11 are not ticked: the gate (full Playwright suite, `scripts/e2e-institution.mjs`, web and api build/test) runs in a stack window. The final review's fix wave (refund copy, reason hint, `q` array guard, picker focus, wallet reset, payments refresh) is applied.

Deviations and controller rulings:
- `holdReasonLabel` added to `labels.ts` for the release dialog.
- The wallet picker searches all roles, not only learners.
- The refund reason `maxLength` is 500 (the DTO allows 1000).
- The gateway already routes `profiles/me/*` to auth with the leave POST in the `write` bucket: no `routes.ts` or `rate-policy.ts` change.
- Users row buttons use `aria-disabled` plus a busy guard instead of `disabled`, so focus stays on the button. After a real suspend the row swaps to Reactivate, so focus drops there anyway.
- The `admin.spec.ts` paging test skips on a fresh seed of 5 users; the vitest paging and `Pager` tests carry it.
- `Bars` draws compact visible values (a 375 px overflow finding).
- The `e2e-institution.mjs` step reactivates the membership before leaving.
- `course.service.ts` create still says "price_etb is required for paid courses"; reachable only from `/teach/new`, folded into 8b step 5.

### 8b
