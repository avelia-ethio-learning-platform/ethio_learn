# Handoff: Phase 6b, learning integrity

From ethio-planner to ethio-impl
Plan: [plan.md](plan.md) (approved in round 2, plus the 2026-10-03 drift check folded in; see [plan-review.md](plan-review.md))
Code review goes to: ethio-reviewer (size L)

## What to build
- **Lesson completion:** a video lesson completes only after 90% of its measured duration, with at least 45% of that duration passed in real time since the learner started it. `/complete` on a video lesson follows the same rule.
- **Attempts:**
  - starts are serialized per learner and assessment;
  - limits apply to every assessment type;
  - a submit is recorded once;
  - per-question results are withheld from the learner while retries remain.
- **Project uploads:** signed for the declared size, and checked at submit.

## Read first, in order
1. `plan.md` decisions 1–10, then round 1 B1 in `plan-review.md`. It explains why only the measured `video_duration_seconds` counts: the editor's minutes are rounded, and using them would block honest learners. Then the "Drift check" section at the end of `plan-review.md`, with the planner's answers.
2. Enrollment:
   - `enrollment.controller.ts:12-20,80-93`;
   - `enrollment.service.ts:140-227` (`completeLesson`, `saveVideoProgress`, `liveLesson`, `recordCompletion`), `onRevisionApplied` (~:474-495) and `:585-634` (`detectCompletion`);
   - `entities.ts:71-97`;
   - the spec at `enrollment.service.spec.ts:84-131`.
3. Course:
   - `internal.controller.ts:41-45`;
   - `entities.ts:26,195-196` (`LessonPending`, `Lesson`);
   - `dto.ts:36-39,60-63`;
   - `course.service.ts:575-640` (`updateLesson`: `definedFields` keeps an explicit null, which the clear-on-video-change rule relies on; `createLesson`) and `insertSection` (~:1466-1495);
   - `staging.ts` (the lesson loop of the approval, ~:79-86) and `revision-diff.ts` (`LessonPendingFields`, `LessonLike`, `mergedLesson` ~:155-163, the canonical hash ~:450-465);
   - `upload.service.ts:416-426`.
4. Outcomes:
   - `assessment.service.ts:26-28,113-141,309-460` (create, start, submit) and `:614-650` (`proctorReport`);
   - `entities.ts:40-84`;
   - `assessment.anticheat.spec.ts:21-46` and `assessment.revision.spec.ts:27,81-89` for the fakes.
5. Web:
   - `learn/[courseId]/page.tsx:60,125-150,264-268,306,336`;
   - `assessments-panel.tsx:32-49,147-199` (Start with no body, `PUT` submit, `ProjectForm`);
   - `teach/courses/[id]/page.tsx:354-386`;
   - `video-upload.tsx` (~:152-183, where the video upload finishes: the single-PUT path attaches the key itself; multipart is attached by the server);
   - `lib/offline-queue.ts` (it also queues on a `WakingError`, and drops a replay that gets a 409);
   - `lib/upload.ts:409`.

## Decisions already made (don't relitigate)
- **Measured duration:** `video_duration_seconds` is the only authoritative duration. It is set by the upload's probe and cleared when the video changes without a new value. The editor's minutes are display only. Every by-name copy of lesson fields carries it (approval, `mergedLesson`, `insertSection`, `createLesson`, and the canonical hash only when not null).
- **The probe** starts when the file is chosen. The single-PUT attach sends the key and the duration in one PUT; multipart sends a duration-only follow-up after the server attaches.
- **The completion rule:**
  - `required` = measured duration, else the client duration (capped at 86,400);
  - the lesson completes when percent ≥ 90 and `now - started_at ≥ 0.45 × required`;
  - an early claim records progress and returns `completed: false`;
  - `/complete` on a video lesson takes an optional final position and returns 409 when the rule isn't met, with `retry_after_seconds` when only the time is missing (the web retries once);
  - `started_at` is nullable: set by the first heartbeat (`COALESCE`), reset to null by `onRevisionApplied` for a replaced video;
  - `/complete` on a video lesson is sent directly, never through the offline queue.
- **Starting an attempt:** a blocking `pg_advisory_xact_lock` per learner and assessment, the newest open row reused for every type, and no unique index. AI and storage calls happen after commit. The viva question is generated only when missing, and saved conditionally.
- **Limits:** defaults of 3 attempts and no cooldown for viva and project, with the teach form showing both fields for every type.
- **Submit:** grade, then a conditional claim (`submitted_at IS NULL`), then publish only when `affected === 1`.
- **`breakdown`:** withheld from the learner (the submit response, and `proctorReport` when called by the learner) unless they passed or used every attempt. Staff keep it, and so does the study coach.
- **Projects:** `{ file_size }` is required on project start and signed as the content length; submit HEADs the object. On the web the file is chosen first: choosing it starts the attempt with `file_size`, then uploads. Submit is `PUT /attempts/:id/submit`.

## Gotchas learned while planning
- **Existing video lessons start unmeasured.** P1-04 only fully closes for an existing lesson once its video is re-uploaded. Say this plainly in your summary to the user.
- **The migrations:**
  - The `started_at` backfill is `updated_at - make_interval(secs => duration_seconds)`, so learners mid-lesson aren't blocked.
  - The outcomes index migration is CONCURRENTLY (`transaction = false`, drop-if-exists first, one statement per query). Check its predicate-free column list in `pg_indexes`.
  - The course migration adds `video_duration_seconds` to `lessons`. Check whether `LessonPending` is a table or a jsonb copy.
- **The probe needs an `error` handler and a 10 s timeout.** Chrome fires no `loadedmetadata` for HEVC or MKV. On failure, skip the update.
- **`UPDATE … RETURNING` through `manager.query`** returns `[rows, rowCount]` in TypeORM's Postgres runner. Prefer the QueryBuilder (`affected`), as in Phase 4.
- **Seeded and e2e flows:**
  - `demo-seed.mjs` declares 2 s measured durations (`video_duration_seconds` in the sections payload) on seeded video lessons and completes them by heartbeat 0 → wait 1 s → heartbeat 2. The seeded learner must still get a certificate: Playwright relies on it;
  - `e2e-smoke.mjs` asserts the refusal;
  - the new `e2e-learning.mjs` runs right after e2e-payments in CI (Build web then refills the login limiter before Playwright and the smoke step), with one login per role.
- **Secrets:** the secret-guard hook scans untracked files for `api/.env` values. Use variable names in docs, scripts and tests; seed credentials come from the seed script or env.
- **Public repo:** the plan folder is in `.git/info/exclude`. On your branch, remove its line and commit the folder, or use `git add -f` if editing the exclude file isn't allowed in your session; ask the user. Push only when the user can merge and deploy the same day.
- **Environment:**
  - the node PATH export and pnpm `--store-dir`;
  - Postgres on 55432;
  - restart the backend with `scripts/stop-backend.sh && scripts/start-backend.sh`, and web by killing the `next-server` PID.
- **Production is off-limits.** Rollout step 1's counts are for the user.

- **7b runs alongside (ethio-planner, worktree `../ethi0-web`, `feat/public-learner-pages`).** Its Task 4 restructures the lesson player `web/src/app/learn/[courseId]/page.tsx` (layout, Start/Resume, states) without touching `markComplete`, the heartbeat or the 409 message. If 7b merges first, your `git merge origin/main` resolves that file: keep 7b's layout and your progress logic.

## How to run
- `pnpm -C api build && pnpm -C api test && pnpm -C api db:check`
- `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`
- Every e2e script: `demo-seed.mjs`, `e2e-revisions.mjs`, `e2e-institution.mjs`, `e2e-payments.mjs`, `e2e-learning.mjs`, `e2e-security.mjs`, then `pnpm -C web build` and `pnpm -C web exec playwright test`, then `e2e-smoke.mjs` last (it exhausts the login limiter on purpose).
- Migrations: apply on a fresh and an existing local DB, and check that `migration:revert -t none` round-trips.

## Branch
Stacked: create `fix/learning-integrity` from the tip of `fix/money-integrity` (6c). 6a is already on main (PR #24), and `fix/money-integrity` has merged `origin/main`. The review base is `fix/money-integrity` until 6c merges; then run `git merge origin/main` once and tell ethio-reviewer the new base (`origin/main`). Under the user's standing authorization (`~/.claude/CLAUDE.md`), ethio-planner pushes, opens the PR and merges once CI is green and the code review is APPROVED; as a security phase, it is pushed only when it can merge and deploy the same day. The plan folder is git-excluded: commit it with `git add -f`. Stage paths explicitly, because several plan folders are untracked.

**Keep it simple (user rule, 2026-10-03):** no new table, column, service, job, env var or abstraction that the plan's decisions don't require. Prefer extending what exists; reviewers raise anything extra as a should-fix.

## Definition of done
- The acceptance criteria are met, and the e2e checks in step 8 pass.
- The api build, tests and `db:check` pass; the web typecheck, tests and build pass; the images build.
- The plan checklist is ticked, with deviations logged.
- Then request code review from ethio-reviewer.
