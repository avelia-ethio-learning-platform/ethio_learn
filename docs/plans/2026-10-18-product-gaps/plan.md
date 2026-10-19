# Phase 13: product gaps

Status: APPROVED WITH NITS (round 2, 2026-10-18; both nits folded into part-13a) · Size: M, split into 13a (API, roles, language: ~28 files, 1 migration) and 13b (web links and admin UI: ~16 files) · Base branch: `origin/main` after 12b merges (Phase 13 is built last: after 7c, 9c, 9d, 9e, 11b, 11c, 12a, 12b) · Feature branches: `feat/product-gaps-a`, `feat/product-gaps-b`, in the one checkout (no worktrees) · Roadmap: `docs/plans/2026-10-02-refinement-audit/roadmap.md:45` · Gaps: `docs/FEATURES_AND_ROADMAP.md:233-245`.

All line numbers are at `origin/main` `ec8549e` (code unchanged since `40c40f2`; the diff is docs only). Parts: [part-13a.md](part-13a.md) (gaps 3, 4, 5), [part-13b.md](part-13b.md) (gaps 1, 2, 6). Review: [plan-review.md](plan-review.md).

## Goal
Close the six known product gaps with the smallest change each. Done when:
1. A learner's quiz row on `/learn/[courseId]` leads to the exam room, and educators see exam results (gap 1).
2. The public course page shows the comments the notification links point to (gap 2).
3. Marking a role-wide notification read marks it for that person only (gap 3).
4. An institution admin can open `/teach`, create a course on `/teach/new`, and the course and every later revision go to the QO queue when submitted (gap 4).
5. A course can be marked Amharic at creation and in the editor, and the catalog can filter by language (gap 5).
6. An admin can send a test email and force-verify an email from the admin page; every signed-in user has a Messages link with an unread count (gap 6).

## Root causes (what the code does today)
| Gap | Cause |
|---|---|
| 1 | `assessments-panel.tsx:114-150` is a second quiz UI (`QuizForm`) that only maps `q.options` (:124, crashes on written questions, which the API sends with `options: undefined`, `assessment.service.ts:983`) and posts the legacy `{ answers }` body (:145). Nothing links to `/learn/[courseId]/exam/[assessmentId]`. No web code calls `GET /courses/:id/attempts` (`controllers.ts:185-190`). |
| 2 | `CommentsSection.tsx` is complete but imported nowhere (`git grep CommentsSection`); the inbox links already point to `/courses/:id#comments` (`community.service.ts:104,115`) and the component carries `id="comments"` (:89). |
| 3 | One `read_at` on the shared row (`entities.ts:224-225`); `markRead`/`markAllRead` update it for any row matching `user_id` OR `target_role` (`controllers.ts:116-140`). |
| 4 | Web gates are educator-only (`teach/page.tsx:183`, `teach/new/page.tsx:113`) and `course.service.ts:342-345` throws for `INSTITUTION_ADMIN`; the API routes already allow the role (`course.controller.ts:184-196`). `/institution` links only `/preview/:id` (`institution/page.tsx:168`), not the editor the role may open (`teach/courses/[id]/page.tsx:585`). |
| 5 | `dto.ts:125-127` `@IsIn(['en'])`, `UpdateCourseDto` has no `language` (:148-177), the new-course form hardcodes `'en'` (`teach/new/page.tsx:36`), staging has no `language` key (`staging.ts:57-69`, `revision-diff.ts:14-21,85`). |
| 6 | API-only: `POST admin/notifications/test-email` (notification `controllers.ts:234-252`), `POST admin/users/:id/verify-email` (auth `admin.controller.ts:107-112`), `POST fraud/signals` (quality `controllers.ts:126-137`), `GET messages/unread-count` (`community.controller.ts:69-74`), `GET admin/notifications` (:207-211). No Messages link in `Header.tsx` (bell only, :182, :214). |

## Split and order
| Slice | Gaps | Why together | Files |
|---|---|---|---|
| 13a, first | 3, 4, 5 | the API changes and the one migration; carries decisions 1 and 4, so review lands early | ~28 |
| 13b, second | 1, 2, 6 | web only; one new panel on the existing attempts endpoint; all doc edits | ~16 |

13b can run on `impl2` in parallel: the only code files both touch are `Header.tsx` (13a adds one role link, 13b adds the Messages link) and the i18n dictionaries. The doc edits (`FEATURES_AND_ROADMAP.md`, `docs/i18n/am-review.md`, roadmap row 13) are 13b's only, including 13a's `filter_language` row.

## Dependencies on the phases built before 13
| Phase | What 13 assumes |
|---|---|
| 7c | `.badge-count` exists for count bubbles (color-system plan :87); the exam page, editor, admin page and `Header` already use tokens, so 13 adds no literal colors. |
| 9c | `pageQuery({ defaultLimit, maxLimit })` is a factory (read-paths drift A3; `fix/calls-and-jobs:api/packages/common/src/http/page-query.ts:23-33`); `search` keeps separate `@Query('…')` params beside `@Query() paging` (`course.controller.ts:148-157` there), so 13a's `@Query('language')` is additive. |
| 9e | `GET /courses/:id/attempts` is paged with that factory, bounded 50/200 with batched names (read-paths plan :146, :175); 13b's panel sends `page`/`limit`. `CommentsSection` requests `paged=1` and has "Load earlier" (:160-162); 13b mounts it unchanged. |
| 11b | Non-auth calls stay direct through `api()` with the in-memory bearer; the Messages poll is gated on `useAuth().ready`. 11b edits `Header.tsx:107`, `e2e/a11y.spec.ts`, `e2e/support.ts` and moves e2e to per-test login (`loggedInAs`, auth-transport drift "Keep"), so 13a's `roles.spec.ts` flip and 13b's `Header.test.tsx` case re-find their lines after it. |
| 11c | `courses/page.tsx` and `courses/[id]/page.tsx` read `await searchParams` / `await params` (deps-next15 plan :194-197); 13a reads `language` from the awaited object. |
| 12a/12b | `EmptyRows` takes an icon and an action; the admin tabs keep their `layoutId`; 12b's step 7 touches `courses/[id]/page.tsx` without restructuring it, so the comments mount re-finds its line. |
| 9d | No new log line carries an email or a name (its guard scans `email|to|recipient` arguments; 13 adds no API log line). |

## Product decisions (decided 2026-10-18: 1-3 by the user, 4-6 the plan's defaults)
1. Institution admins author courses on `/teach`; the owner is the institution (`resolveOwner`, `course.service.ts:1543-1553`). `institution_id` stays null on such a course (the lookup at :352 is the instructor membership, `auth/src/internal.controller.ts:42-45`, null for an admin), so the first submit (:726) and every revision (`revision.service.ts:181`) go to the QO queue, never to the admin's own queue. The course lists on `/teach` (`listOwn` :1394-1398, by `owner_id`), not on `/institution` (`institutionCourses` :821-825, by `institution_id`). Payouts, certificates and outcomes already key on `owner_id`/`owner_type` (`payment.service.ts:186`, `payout.service.ts:224-233,267`, `certificate.service.ts:144-145`, `assessment.service.ts:1028`).
2. Every quiz, proctored or not, runs in the exam room, and the inline `QuizForm` is deleted (the room already handles unproctored quizzes, exam `page.tsx:284`).
3. Comments mount on the public course page only (where the links point), not on `/learn/[courseId]`.
4. The catalog gets a language filter now: one pill group next to pricing (`explore-client.tsx:212-220`).
5. Manual fraud signals and the email-log viewer stay API-only (see part-13b "Left out").
6. Role rows already marked read before the migration stay read for everyone; there is no record of who read them.

## Non-goals
Tutor and structure-generator prompts stay language-unaware; per-recipient delivery of role rows; a comments moderation UI; dropping the `read_at` column on role rows; an admin fraud form; listing an admin's own courses on `/institution`; naming the institution instead of the admin as the author on the public page (`publicDetail` :1295 links `created_by`, which `educatorProfile` :1210-1215 resolves, so the link works; goes in the handoff).

## Risks and open questions
- 9e may change the attempts response from an array to an object; the panel normalizes both (`Array.isArray`), as 9e does for comments.
- Quality's `CourseSubmitted` intake stores `owner_type` as sent (`quality.service.ts:247,258`), and the QO queue card names the institution (`ownerContact` :1557-1559 → `owner_name`; `qa/page.tsx:260`). Verified in review.
- `/teach` for an admin without an institution: `listOwn` throws "Create your institution profile before creating courses" (`course.service.ts:1543-1553`); the page shows it with a link to `/institution`.
- No e2e covers the bell; gap 3 gets an opt-in Postgres spec with its own CI step and scratch database (part-13a).

## Review round 1 → changes
- B1: fixed. `create` keeps `institution_id` from the membership lookup (null for an admin); `submit` :726 and `revision.service.ts:181` untouched; decision 1, the spec and the gap 4 text reworded (part-13a).
- B2: fixed. A `ci.yml` step after :134 with its own `el_ci_inbox_reads` database, and the local gate with `TEST_DATABASE_URL` (part-13a gap 3, step 1).
- N1: fixed. Doc lines :233-245 and :306-311; all doc edits in 13b (step 7); 13a's doc step dropped.
- N2: fixed (`{ ownerId, ownerType }`). N3: fixed (handoff :35). N4: fixed (9c row above). N10: fixed (11b row above).
- N5: fixed. The FK is a `@ManyToOne` + `@JoinColumn` relation; no extra index.
- N6: fixed. Mount inside the left column after the reviews block (:237); re-find after 12b.
- N7: fixed. Row list :85-101, quiz branch :107; `written_count` dropped; proctor expander kept, first to cut.
- N8: fixed. One "Edit" link per row on `/institution` (part-13a gap 4 web).
- N9: accepted as a non-goal (above) and a handoff note; no scope added.
