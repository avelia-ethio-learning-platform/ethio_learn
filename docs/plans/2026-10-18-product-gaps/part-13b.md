# 13b: exam room link and results, course comments, admin tools and Messages link

Part of [plan.md](plan.md). Branch `feat/product-gaps-b`, web only (plus the docs). Lines at `origin/main` `ec8549e`.

## Gap 1: quizzes go through the exam room; educators see results
**Learner** (`learn/[courseId]/assessments-panel.tsx`):
- Delete `QuizForm` :114-150 and its mount :107. In the row list :85-101 a quiz row renders a `Link` to `/learn/${courseId}/exam/${a.id}` ("Open exam") instead of the Start button :96-98, with "Proctored · camera" and "{n} min limit" tags when `proctored` / `time_limit_minutes` are set. `AssessmentSummary` :14-20 gains `proctored?` and `time_limit_minutes?`: the API already sends them (`assessment.service.ts:217-222`).
- Viva and project keep the Start flow :50-58 and their forms :152-230.
- The exam room needs no change: it handles unproctored quizzes (exam `page.tsx:284`), posts `responses` (:99-108), returns to the course (:294) and retakes (:408). `completion-card.tsx:41` refetches `/attempts/mine` on return.
- Test: `assessments-panel.test.tsx:177-187` ("a quiz Start still posts with no body") becomes "a quiz row links to the exam room"; a written-only quiz renders (no `options` access).

**Educator** (`teach/courses/[id]/`): new `exam-results.tsx`, mounted below the `AssessmentManager` mount (`page.tsx:257`) as a collapsed "Exam results" panel.
- `GET /courses/:id/attempts?page&limit` (outcomes `controllers.ts:185-190`; rows `assessment.service.ts:795-812`; 9e pages it with `pageQuery`, 50/200). Normalizes an array or `{ items }`.
- Columns: learner (name, "Learner" when 9e's degraded read gives none), type (`assessmentTypeLabel`, `labels.ts:165-167`), score, passed, flags (`flagged`, `terminated`, `violation_count`), submitted. `Pager` for pages; `EmptyRows` with an icon when empty.
- A "Proctor report" expander per proctored row calls `GET /attempts/:id/proctor-report` (:177-182, staff via `canManageCourse`) and lists events with their snapshot links. Kept because a "flagged" row is unactionable without it; the first thing to cut if 13b runs long.
- Test: `exam-results.test.tsx`: renders rows, the fallback name, and the report on expand.

## Gap 2: mount the comments
- `courses/[id]/page.tsx`: `<CommentsSection courseId={course.id} />` inside the left column, after the reviews block (:216-237) and before the column's closing `</div>` :238 (the two-column grid closes at :240; `MobileBuyBar` :242 is outside it). Re-find after 12b (motion plan step 7 touches this page, no restructure). The component is a client component that polls every 15 s with `auth: false` (`CommentsSection.tsx:51-55`), shows the sign-in prompt to visitors (:114-116) and surfaces the API's 403 for non-enrolled learners (`community.service.ts:67-74`) through `FormStatus` (:72, :107). Its `id="comments"` (:89) is the anchor the inbox links use (`community.service.ts:104,115`).
- `page.test.ts:6-7` mocks one more client component (`@/components/CommentsSection`).
- 9e's "Load earlier" and 7c's colors are already in the component; 13b changes none of it.

## Gap 6: admin tools and the Messages link
**Shown in the UI.**
| Endpoint | Where | Why before launch |
|---|---|---|
| `POST admin/notifications/test-email` (notification `controllers.ts:234-252`) | Announce tab (`growth-tabs.tsx:115-173`): an "Email delivery" card with "Send test email to me"; shows `provider`, `to`, `message_id` or `error` via `FormStatus` | the one check that email works on a deployment (the endpoint's own doc, :229-233) |
| `POST admin/users/:id/verify-email` (auth `admin.controller.ts:107-112`) | Users tab: "Verify email" action on rows with the "unverified" label (`admin/page.tsx:525`), same `useConfirm` pattern as Suspend/Ban :529-543; invalidates the users query | a learner locked out of verification has no other way in |
| `GET messages/unread-count` (`community.controller.ts:69-74`, returns `{ unread }`, `community.service.ts:219`) | new `MessagesLink.tsx` beside `NotificationBell` (`Header.tsx:182`, `:214`): icon link to `/messages`, `aria-label="Messages, N unread"`, `.badge-count` bubble (7c plan :87), `useQuery` every 20 s like the bell (`NotificationBell.tsx:34-39`), `enabled: ready && !!user` | messages exist (`messages/page.tsx`, no role gate) but are unreachable from the shell |

**Left out, and why.**
- `POST fraud/signals` (quality `controllers.ts:126-137`): the live detectors write signals themselves (`quality.service.ts:447-450`, :874-878) and the Users tab already suspends and bans (`admin/page.tsx:529-543`). A free-text signal form is a post-launch tool.
- `GET admin/notifications` (:207-211): the test-email result returns the provider's answer inline; a log viewer is post-launch.

**Tests.** `Header.test.tsx` adds one case (signed in → Messages link with the count in the label; signed out → none; `:11-14` already mocks `useAuth` and `api`; re-find after 11b, which edits `Header.tsx:107`). `admin/page` tests (if present) add the verify action; `growth-tabs` gets a test for the card's success and error states. New keys `messages` (en "Messages", am "መልዕክቶች") and `verify_email` are UI-only strings in the admin page (English, like the rest of the admin), so only `messages` goes into both dictionaries (parity `i18n.test.ts:9-11`).

## Steps
- [ ] 1. Branch from `origin/main` after 12b (or from 13a's tip if 13a is open; rebase on merge).
- [ ] 2. Gap 1 learner side + test. 3. Gap 1 educator panel + test. 4. Gap 2 mount + test mock.
- [ ] 5. Gap 6: `MessagesLink`, Users tab action, Announce card, i18n, tests.
- [ ] 6. Gate: `pnpm -C web typecheck && pnpm -C web test && pnpm -C web lint`; Playwright `course-page`, `admin`, `a11y` (the header gains a link), `layout`.
- [ ] 7. Docs, for both slices: `docs/FEATURES_AND_ROADMAP.md` :233-240 and :245 go (all six gaps closed), :241-245 shrinks to its one open item :244 ("raising a fraud signal by hand"); :306-310 leave the product list and :311 becomes "An admin form for raising a fraud signal by hand". `docs/i18n/am-review.md` gets the `filter_language` (13a) and `messages` rows. Roadmap row 13 → `done (#PRs)`.

## Risks
- The exam room is `RequireRole roles={['learner']}` (exam `page.tsx:563`); the panel is on the learner page, so the link is only shown to learners.
- The Header has a mobile and a desktop bell (:182, :214); the Messages link goes in both, and `a11y.spec.ts` (axe, serious/critical, :79) must stay clean.
- `learner_email` is in the attempts rows (`assessment.service.ts:804`); the panel does not render it (nothing needs it) and nothing logs it (9d).

## Progress
- Built in parallel with 13a, 12a/12b and 11b (not after 12b). Merged `feat/product-gaps-a` in.
- Overlaps: `Header.tsx` (13a Teach link, 11b line 107, 12a/12b motion): only a `MessagesLink` import and two JSX lines. `courses/[id]/page.tsx` (12b): one import and one block after the reviews. `teach/courses/[id]/page.tsx`: one import and one line.
- Deviation: the attempts endpoint is not paged yet (9e), so `exam-results.tsx` fetches once and pages client-side with `Pager`; switch to server paging when 9e returns `{ items, total }`.
- Review fixes: console email provider is an error, `dm-unread` key, label-in-name, comments translated (am-review), revision-diff language label dropped.
