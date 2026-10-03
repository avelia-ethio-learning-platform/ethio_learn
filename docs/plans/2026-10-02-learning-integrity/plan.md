# Phase 6b: Security hardening II, learning integrity

Status: approved (round 2); drift check (2026-10-03) folded in; round 3 (D2/D4 additions) APPROVED, N1–N2 taken
Size: L (sessions: 4; ethio-impl implements, ethio-reviewer reviews the code)
Base branch: stacked on `fix/money-integrity` (6c); 6a is on main (PR #24) and 6c has merged it. No push or PR until 6c has merged, then `git merge origin/main`. 6b uses 6a's `internalPath` and `UuidParam` in the code it touches. 6c is financial-only, so its migrations don't clash with 6b's (enrollment, course, outcomes). 6b also touches `learn/[courseId]/page.tsx`, which Phase 5 edited. · Feature branch: `fix/learning-integrity`
Roadmap: phase 6b (6a is `2026-10-02-security-hardening`) · Findings: P1-04, P1-09, P1-10

## Goal
Make certificates and assessment results mean something:
- **P1-04:** a learner can complete any lesson, and so the course, without watching anything. They can send `position = duration = 1`, or call `POST /progress/lessons/:id/complete`, which needs no evidence at all. `CourseCompleted` then issues the certificate, counts toward the educator's trust tier, and clears the 20% review gate.
- **P1-09:** parallel starts bypass quiz attempt limits and cooldowns. Viva and project assessments have no limits at all, and each viva start costs a Groq call. Per-question correctness is returned while retries remain.
- **P1-10:** a project upload has no size cap, and a project can be submitted with no file.

Acceptance criteria:
- **Video lessons:**
  - A video lesson completes only when the learner has reached 90% of its duration, and at least 45% of that duration has passed in real time since they started it. That allows 2× playback with a little slack.
  - The duration is the server's **measured** video duration when the lesson has one. The educator's upload now measures it and stores it apart from the editor's rounded "minutes" estimate, which never becomes a requirement. Lessons without a measured duration use the client-reported one, capped.
  - A client-reported duration is capped, and position can't exceed duration.
  - `/complete` on a video lesson applies the same rule: 409 with "Finish watching this lesson to complete it."
  - Lessons without video still complete with `/complete`.
- **Attempts:**
  - However many start requests run at once, a learner has at most one open attempt per assessment.
  - `max_attempts` and the cooldown hold for quiz, viva and project. Viva and project get defaults of 3 attempts and no cooldown, and educators can configure both for every type.
  - Two concurrent submits of one attempt record one result and publish one event.
  - Per-question results (`breakdown`) are returned only once the learner has passed or used every attempt.
- **Projects:**
  - The upload URL is signed for the exact declared size, which can't exceed 50 MB.
  - Submit refuses an attempt whose file is missing or larger than the cap, and deletes an oversized object.

## Non-goals
- **Reading-time rules for lessons without video.** There is no server-side signal of reading. For courses without video, assessments remain the certificate gate.
- **Probing media duration on the server** (ffprobe, MP4 box parsing) and backfilling measured durations of existing lessons. Lessons without a measured duration fall back to the client-reported one, as today but capped. The rollout step counts them.
- **Serializing progress across lessons,** so watching several lessons in parallel tabs still counts.
- **Withholding the study coach's list of missed prompts.** It is a deliberate learning feature, and the now-enforced attempt limit bounds answer-key mining.
- **A sweeper for abandoned open attempts, and a lifecycle rule for orphaned project uploads.** The per-upload size cap and the attempt limits bound both.
- Phase 6a's scope: internal paths, password, email caps, coupons.

## Current state
- **Progress** (`api/services/enrollment/src/`):
  - `VideoProgressDto` takes `position_seconds` and `duration_seconds`, both `@Min(0)`, with no upper bound (`enrollment.controller.ts:12-20`). `/complete` has no body (`:80-85`).
  - `saveVideoProgress` (`enrollment.service.ts:156-182`) works like this:
    - `duration = max(stored, client)`;
    - `percent = round(position/duration*100)` as a high-water mark;
    - `recordCompletion` runs at 90% or more.

    The first call can claim 100%.
  - `completeLesson` (`:140-148`) completes unconditionally.
  - `recordCompletion` (`:219-227`), then `detectCompletion` (`:585-634`), publishes `CourseCompleted` (`:621`). Its consumers:
    - certificate issuance (`outcomes/src/certificate.service.ts:36-46`);
    - trust tier (`quality.service.ts:147-153`);
    - the "you finished" email.

    Derived progress feeds the 20% review gate (`quality.service.ts:592-597`), refunds (`refund.service.ts:50`) and the sponsor view.
  - `liveLesson()` (`:213-217`) calls the internal lesson endpoint, which returns only `{id, course_id, title, live}` (`course/src/internal.controller.ts:41-45`).
  - `Lesson.duration_seconds` (`course/src/entities.ts:195-196`, default 0) is set only by the educator's optional "minutes" field (`sections-editor.tsx:205,218,360`). No pipeline measures it; transcoding doesn't exist (`storage/src/index.ts:28-30`). "Has video" means `video_s3_key` is set (`course.service.ts:1217`).
  - `video_progress` has `updated_at` but no start time (`entities.ts:71-97`).
  - Video is never cached offline (`web/public/sw.js:11,48`). The offline queue collapses heartbeats and replays them with the replay time (`offline-queue.ts:58-62,87`).
  - **Phase 5 also queues on a `WakingError`** (`offline-queue.ts`, `isNetworkError`), which a hibernation 429 raises. So a sleeping enrollment service queues heartbeats and `/complete` too, not only a dropped connection. On replay, a non-network error such as a 409 is dropped silently (`flushOutbox`).
  - **Replacing a video on a live course:** `onRevisionApplied` (`enrollment.service.ts`, ~:487) resets `position_seconds`, `duration_seconds` and `percent_watched` on the replaced lessons' rows but keeps the rows.
  - The web sends a heartbeat every 10 s and on pause, hide and lesson switch (`learn/[courseId]/page.tsx:60,125-150,264`). `markComplete` runs on `ended` and from an always-visible button (`:265-268,306`).
  - The upload's `completedResult` attaches the key through `updateLesson` (`course/src/upload.service.ts:416-426`). That DTO already accepts `duration_seconds` (`dto.ts:36-39,60-63`).
  - **Where the web upload finishes:** `teach/courses/[id]/video-upload.tsx` (~:152-183). Multipart uploads are attached by the server (`completedResult`). The single-PUT path (videos under 16 MiB) attaches the key itself with `PUT /lessons/:id { video_s3_key }`.
  - **Lesson fields are copied by name** in several places, and each needs the new column:
    - revision approval: the lesson loop in `staging.ts` (~:79-86) writes only `title`, `summary`, `duration_seconds` and `video_s3_key` from `mergedLesson` (`revision-diff.ts` ~:155-163; types `LessonPendingFields` and `LessonLike`), then sets `pending: null`;
    - `insertSection` (`course.service.ts` ~:1466-1495, used by course create and outline import) and `createLesson` (~:630-645);
    - the revision's canonical hash lists an added lesson's fields by name (`revision-diff.ts` ~:459). A staged live lesson's `pending` jsonb is hashed whole.
  - `LessonPending` is a jsonb interface on `lessons.pending` (`entities.ts:23-28`), not a table.
  - Scripts: `demo-seed.mjs:351` completes lessons through `/complete`; `e2e-smoke.mjs:76-110` sends `duration_seconds: 100`. Seeded video lessons are created through the sections payload, so through `insertSection` (`demo-seed.mjs` ~:230-269).
  - **CI order (Phase 5):** demo-seed → e2e-revisions → e2e-institution → e2e-payments → Build web → Playwright → e2e-smoke (`ci.yml` ~:106-135). Building web takes over a minute, which lets the login limiter refill before Playwright and the smoke step. Playwright needs demo-seed's learner enrollment and certificate (`web/e2e/support.ts`, `layout.spec.ts`, `verify.spec.ts`).
  - Tests: `enrollment.service.spec.ts:84-131,172-191`.
- **Attempts** (`api/services/outcomes/src/assessment.service.ts`):
  - **Types:** quiz, ai_viva and project (`contracts/src/enums.ts:161-165`). Only quizzes get `max_attempts` (default 3, clamped 1–20) and `cooldown_minutes` (default 0) (`:28,113-130`).
  - **`startAttempt`** (`:309-403`):
    - Only quizzes reuse an open attempt (`submitted_at IS NULL`, `:318-333`).
    - It counts rows, refuses after a pass, and checks max and cooldown (`:334-346`), then inserts with a plain `save` (`:349-359`). There is no transaction, lock or unique index.
    - Viva calls Groq after the insert (`:382-387`); a failure leaves an orphaned open row.
    - Project presigns `projects/<learner>/<uuid>` with no length (`:390-401`) and stores the key in `detail.file_key`.
  - **`submitAttempt`** (`:405-460`) checks `submitted_at` in memory and grades. Quiz written answers call Groq per question (`:528`). It then saves and publishes `AssessmentPassed`/`AssessmentFailed` (`:446-448`). The response includes `breakdown` with MCQ `{correct, selected_index, earned, points}` (`:449-459,539`), and `proctorReport` returns it too (`:620,650`).
  - **Indexes:** `assessment_attempts` has single-column indexes on `assessment_id` and `learner_id` only (`entities.ts:40-84`; same in Phase 2's baseline). Appendix B of the audit recommends `(assessment_id, learner_id)`.
  - **Web:**
    - `assessments-panel.tsx` (mounted at `learn/[courseId]/page.tsx:336`) shows only score, passed and feedback (`:45-49`). Start POSTs with no body (`:32-36`), and submit is `PUT /attempts/:id/submit` (`:44`; outcomes `controllers.ts:138`);
    - the exam page renders `breakdown` only when present (`exam/[assessmentId]/page.tsx:38,301-328`);
    - the teach form sets max attempts and cooldown for quizzes only (`teach/courses/[id]/page.tsx:354-355,385-386`).
  - **Tests:** `assessment.anticheat.spec.ts` (harness `:21-46`) and `assessment.revision.spec.ts` (`fakeRepo` `:27`).
- **Project upload:**
  - `PROJECT_MAX_BYTES` (50 MB, `:26`) is only advertised (`max_bytes`) and checked client-side (`assessments-panel.tsx:169-173`).
  - The storage package already signs `content-length` when given a length (`storage/src/index.ts:111,118-124`, spec `index.spec.ts:37-48`) and has `headObject` (`:61,194-202`). The course upload service uses both (`upload.service.ts:120,135,304,399`).
  - `ProjectForm` calls `putFile` with octet-stream (`assessments-panel.tsx:147-199`, `upload.ts:409`). It renders only after Start has returned `upload_url`, so today the file is chosen **after** the start.

## Design and key decisions
### A. Lesson progress (P1-04)
1. **The server knows the measured duration (round-1 B1):**
   - **A new column, `lessons.video_duration_seconds int NULL`,** is the measured length of the current video. It is mirrored in `LessonPending`, so a staged video carries its duration and both go live on approval.
   - **The lesson update DTO accepts it.** Setting `video_s3_key` to a new key or to null clears it, unless the same update sends a new value.
   - **The internal lesson endpoint** adds `video_duration_seconds` and `has_video` (live values).
   - **Every place that copies lesson fields by name carries it (drift D1).** Otherwise approval drops a staged duration and live keeps the old one, which locks learners out of a shorter replacement video:
     - the `staging.ts` approval loop and `mergedLesson` (plus `LessonPendingFields` and `LessonLike`);
     - `insertSection` and `createLesson`, with the field on their input DTOs, so a lesson created with a video can carry its duration (demo-seed uses this);
     - the canonical hash of an added lesson includes `video_duration_seconds` **only when it is not null**, so a revision submitted before the deploy still hashes the same at apply (the pattern the hash already uses for assessments).
   - **No migration for `LessonPending`:** it is a jsonb copy, so the mirrored field is a type change only.
   - **Probe:** the web reads the local file's duration (a detached `<video>` with an object URL, `loadedmetadata`) in `video-upload.tsx`, starting when the file is chosen, so it runs alongside the upload (drift D8):
     - **single-PUT path:** the attach call waits for the probe and sends `PUT /lessons/:id { video_s3_key, video_duration_seconds: Math.floor(duration) }` in one request. Sending the key alone would clear the duration under the rule above;
     - **multipart path:** the server attaches the key (which clears the duration), then the web sends `PUT /lessons/:id { video_duration_seconds }`.
     - It handles `error` and gives up after 10 s, because browsers fire no `loadedmetadata` for formats they can't decode (round-1 N2).
     - On failure it sends the key alone (single PUT) or skips the follow-up (multipart).
   - **The editor's "minutes" (`duration_seconds`)** stays a display estimate and is never used for completion. It is `Math.round(minutes * 60)`, so it is often longer than the video.
   - Educators are the trusted side here.
2. **`required` and the rule, with `started_at` on `video_progress`:**
   - `required` = `video_duration_seconds` when set, else the client-reported duration (the stored maximum).
   - The DTO caps `duration_seconds` at 86,400 (`@Max`), and position is clamped to `required + 5`.
   - The percent high-water mark is computed against `required`.
   - The lesson completes when `percent >= 90` **and** `now - started_at >= 0.45 * required`.
   - `started_at` is set on the first heartbeat: `started_at = COALESCE(started_at, now())`. A null `started_at` means the time check isn't met.
   - **A replaced video restarts the clock (drift D2):** `onRevisionApplied` also sets `started_at = NULL` on the rows it resets, so the time check runs again for the new video. Setting it to `now()` instead would let a learner who returns days later complete the lesson with one 90% heartbeat.
   - A heartbeat that claims 90% too early just records progress: no error, and `completed: false` in the response.
   - Rejected: crediting watched time per heartbeat (a delta ledger). The start time plus the high-water mark gives the same guarantee for a single lesson with one column.
3. **`/complete` for video lessons:**
   - It accepts an optional `{ position_seconds }`, applied as a final heartbeat. That covers the race between `ended` and the last 10 s heartbeat.
   - It then applies the rule: 409 "Finish watching this lesson to complete it." when unmet.
   - Lessons without video complete as today.
   - The web shows the 409 message next to the "Mark complete" button, and `markComplete` on `ended` sends the final position.
   - **When only the time is missing** (percent ≥ 90, elapsed too short), the 409 body adds `retry_after_seconds`, the time left rounded up to a whole second (round 3 N1). If it is at most 120 s, the web waits that long and re-sends `/complete` once with the final position, so a late `started_at` costs a short wait, not a rewatch. A longer wait shows the 409 message instead of a hidden timer (round 3 N2). The rule is public, so the number reveals nothing new.
   - **`/complete` on a video lesson is not queued (drift D4).** The web sends it with `api()`, not `queuedApi()`, because a queued call that gets a 409 on replay is dropped silently. When the server is unreachable or waking, the button shows "We couldn't reach the server. Your progress is saved, so try again in a moment." Heartbeats stay queued. `/complete` on a lesson without video stays queued, because it can't return 409.
4. **Scripts:**
   - `demo-seed.mjs` declares short measured durations (`video_duration_seconds: 2` in the sections payload, which `insertSection` now carries) on seeded video lessons and completes them through a heartbeat at 0, a 1 s wait, then a heartbeat at 2. Text lessons still use `/complete`. The seeded learner must still end with a certificate, since Playwright's `verify.spec.ts` and `layout.spec.ts` rely on it.
   - `e2e-smoke.mjs` asserts the new refusal: a 100% claim right after starting → `completed: false`, and `/complete` → 409.

### B. Attempts (P1-09)
5. **Start under a transaction-scoped advisory lock.** In one transaction:
   1. Take `pg_advisory_xact_lock(hashtextextended('attempt:' || $assessment || ':' || $learner, 0))`, one lock per learner per assessment:
      - blocking (not `try`), so a concurrent start waits, then finds and reuses the new row;
      - transaction-scoped, because the Neon URL is pooled.
   2. Find the newest open attempt, and reuse it for every type. An expired quiz is closed as today.
   3. Count finished attempts (`submitted_at IS NOT NULL`), refuse after a pass, then check `max_attempts` and the cooldown.
   4. Insert the new open row.

   Then:
   - Groq and storage calls happen after commit.
   - **Viva:** generate the question only when `detail.question` is missing (a reused or orphaned row), and save it with a conditional update `WHERE detail->>'question' IS NULL`. Concurrent starts then show one question.
   - **Project:** presign on every start, reusing the stored key (decision 9).
   - Older duplicate open rows from before this change are never reused and never counted, so no data migration is needed.
   - Rejected: a partial unique index on open attempts. Production very likely has duplicate open viva and project rows, since those types never reuse, so building the index would need a destructive cleanup first.
6. **Limits for every type:** `max_attempts` and `cooldown_minutes` are read with the same defaults for viva and project (3 and 0), and the teach form shows both fields for every type. Existing viva and project assessments pick up the defaults.
7. **Submit once:** grade first. Then claim the result with `UPDATE … SET submitted_at = now(), score, passed, detail WHERE id=$1 AND submitted_at IS NULL` (QueryBuilder, `affected`), and publish only when `affected === 1`. The loser returns 409 "Attempt already submitted." Rejected: claiming before grading. A crash or Groq error in between would burn an attempt.
8. **Withhold `breakdown` from the learner:** the submit response, and `proctorReport` **when the caller is the attempt's learner** (round-1 N3: course staff keep it, `assessment.service.ts:614-621`), include `breakdown` only when the attempt passed, or when no attempts remain (`finished >= max_attempts`). Otherwise they return score, passed and feedback. The stored detail is unchanged, so the study coach still works.

### C. Project uploads (P1-10)
9. **Sign for the declared size:**
   - For projects, the start request carries `{ file_size }`, an int from 1 to `PROJECT_MAX_BYTES`, required for this type. The presign passes it as the content length, as the course service does.
   - The browser sets `Content-Length` from the Blob, so a different size fails at storage.
   - A reused open attempt gets a fresh URL for the stored key with the new size.
   - **The web picks the file before the start (drift D7).** Today Start sends no body and the picker appears only once `upload_url` exists, so a required `file_size` would break the Start button with a 400. For a project, the panel shows the file picker instead of a Start button. Choosing a file calls `POST /assessments/:id/attempts { file_size: file.size }`, then uploads to the returned `upload_url`. Choosing another file starts again, which reuses the open attempt and returns a URL for the new size. "Submit project" stays disabled until an upload succeeds. A file over the cap gets the server's 400 message before any upload. Quiz and viva starts are unchanged (no body).
10. **Check at submit:** `headObject(detail.file_key)`.
    - Missing → 400 "Upload your file before submitting."
    - Larger than the cap → delete the object, then 400 with the limit.

## Data model and migrations
Phase 2 pattern; entities updated so `db:check` stays at 0.
- **Enrollment migration (transactional):**
  - `ALTER TABLE enrollment.video_progress ADD COLUMN started_at timestamptz NULL`;
  - `UPDATE … SET started_at = updated_at - make_interval(secs => duration_seconds)` (round-1 N1);
  - `ALTER … SET DEFAULT now()`. The column stays nullable: a replaced video resets it to null (decision 2).

  Backfilling to a lesson length before the last heartbeat means a learner mid-lesson at deploy isn't blocked. Rows that existed before the deploy aren't an attack path. The rollout step checks the row count first, in case it is large.
- **Course migration (transactional):** `ALTER TABLE course.lessons ADD COLUMN video_duration_seconds int NULL CHECK (video_duration_seconds IS NULL OR video_duration_seconds > 0)`. `LessonPending` is a jsonb copy, so it needs no migration.
- **Outcomes migration (`transaction = false`, drop-if-exists first, one statement per query):** create `outcomes.assessment_attempts (assessment_id, learner_id, submitted_at)`, then drop the single-column `assessment_id` index, whose prefix the new index covers. The `learner_id` index stays.
- `down()` reverses each migration (local only). No unique indexes, so no production duplicate check is needed.

## API contract
- **`POST /progress/lessons/:id/video`:** `duration_seconds` max 86,400. The response adds `completed: boolean`.
- **`POST /progress/lessons/:id/complete`:**
  - optional body `{ position_seconds }`;
  - 409 "Finish watching this lesson to complete it." for a video lesson whose rule isn't met, with `retry_after_seconds` in the body when only the elapsed time is missing.
- **`POST /assessments/:id/attempts`:**
  - projects require `{ file_size }` (400 if missing or above the cap);
  - every type returns the open attempt when one exists;
  - every type enforces `max_attempts` and the cooldown (existing messages).
- **`PUT /attempts/:id/submit`:**
  - 409 on a concurrent duplicate;
  - `breakdown` only when passed or out of attempts;
  - projects: 400 when the file is missing or too large.
- **Internal `GET /internal/lessons/:id`:** adds `video_duration_seconds` and `has_video`.
- **Lesson create, update and the sections payload (course):** accept an optional `video_duration_seconds` (int > 0). It is cleared when the video changes without a new value.

## Steps
- [x] 1. Branch per the base rule. Remove this folder's line from `.git/info/exclude` and commit the folder.
- [x] 2. Migrations and entity changes. `db:check` at 0 on a fresh and an existing local DB. Revert round-trips with `-t none`.
- [x] 3. Course: the new field in the DTOs, `updateLesson`'s clear rule, `createLesson`, `insertSection`, the `staging.ts` approval loop, `mergedLesson` and the canonical hash (decision 1), with course unit tests. The internal lesson endpoint fields. Then enrollment: the progress rule, `started_at` (and its reset in `onRevisionApplied`), and `/complete` with `retry_after_seconds`, decisions 1–3, with enrollment unit tests.
- [x] 4. Web, with vitest: the duration probe in `video-upload.tsx` on both upload paths; the learn page's final position, the 409 message and one retry after `retry_after_seconds`; `/complete` on a video lesson through `api()`, not the queue.
- [x] 5. Attempt start under the lock, reuse for every type, limits, viva question guard, decisions 5–6, with outcomes unit tests.
- [x] 6. Submit claim and `breakdown` withholding, decisions 7–8, with tests. The teach form shows the limit fields for every type.
- [x] 7. Project size signing and submit check, decisions 9–10, with tests. The project picker comes before the start, and the start sends `file_size`.
- [x] 8. Update the scripts (decision 4). Add `scripts/e2e-learning.mjs` to CI right after e2e-payments, so Build web still sits between the e2e scripts and Playwright and the login limiter refills (Phase 5's order). Reuse its tokens: one login per role. It checks:
  - 5 parallel quiz starts → one attempt id;
  - after `max_attempts` finished, start → refused;
  - a heartbeat claiming 100% right after the start → not completed;
  - `/complete` on a video lesson → 409;
  - project start with `file_size` above the cap → 400;
  - submit without upload → 400.
- [ ] 9. Full gate: api build, tests and `db:check`; web typecheck, tests and build; every e2e script; `pnpm -C web exec playwright test` (after a fresh demo-seed, before e2e-smoke); both image builds.
- [ ] 10. Code review by ethio-reviewer. The user approves push and PR (same-day merge and deploy).

## Test plan
- **Enrollment unit:**
  - early 100% claim → recorded, not completed;
  - after `0.45 × required` → completes;
  - a measured duration overrides a smaller client duration;
  - an editor estimate of 300 s with a 250 s video, at player position 250 after enough elapsed time → completes, because the estimate is never `required`;
  - changing or removing `video_s3_key` clears `video_duration_seconds`;
  - live-course case (round-2 N4): replace the video, the probe fails, approve the revision → the live `video_duration_seconds` is null;
  - live-course case (drift D1): replace the video with a measured duration, approve the revision → the live `video_duration_seconds` is the staged value;
  - `insertSection` and `createLesson` store `video_duration_seconds`; the canonical hash of a revision without it is unchanged;
  - a replaced video resets `started_at` to null (drift D2) → the next early 90% claim doesn't complete;
  - client duration capped, position clamped;
  - `/complete` on a video lesson → 409, then with the final position after enough time → completes; at 90% with too little time → 409 with `retry_after_seconds`;
  - lesson without video → completes;
  - a backfilled `started_at` (a lesson length before the last heartbeat) lets in-progress rows complete.
- **Outcomes unit:**
  - concurrent starts serialize (lock fake or a real-Postgres test, whichever the codebase supports; the implementer chooses) and return one attempt;
  - reuse for viva and project;
  - limits and cooldown for viva and project with defaults;
  - viva question generated once for a reused row;
  - concurrent submits → one publish and one 409;
  - `breakdown` withheld or returned per decision 8;
  - project `file_size` validation, presign called with the length, submit missing → 400, oversized → delete + 400.
- **Web vitest:**
  - the duration probe: the single-PUT attach sends the key and `video_duration_seconds` together; the multipart path sends a follow-up with the duration; on `error` or the 10 s timeout, the key alone or no follow-up;
  - "Mark complete": the 409 message; one retry after `retry_after_seconds`; a video lesson's `/complete` isn't queued when the server is waking;
  - project: choosing a file starts with `file_size`, then uploads; Submit stays disabled until the upload succeeds;
  - the teach form shows the limit fields for every type.
- **E2E:** `scripts/e2e-learning.mjs` plus the updated `demo-seed.mjs` and `e2e-smoke.mjs`, and the Playwright suite (it relies on demo-seed's certificate).
- **Commands:** `pnpm -C api build && pnpm -C api test && pnpm -C api db:check`; `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`; the e2e scripts; `pnpm -C web exec playwright test`.

## Rollout and ops
Production steps belong to the user, or to a session only on the user's explicit request.
1. **Before merge (read-only):**
   - `SELECT count(*) FROM enrollment.video_progress`, to size the backfill;
   - the number of video lessons, all of which start without a measured duration and fall back to client durations: `SELECT count(*) FROM course.lessons WHERE video_s3_key IS NOT NULL`. A re-upload measures the duration;
   - the number of viva and project learners already at 3 or more finished attempts, who will hit the new default limit.
2. Push and open the PR only when it can be merged and deployed the same day.
3. **After deploy:**
   - a test learner's early 100% heartbeat doesn't complete the lesson;
   - a real watch-through does;
   - a project upload over 50 MB fails at storage.
- **Logging:** refused completions log the lesson, `required` and the elapsed time; attempt refusals log the reason.

## Risks and open questions
- **Lessons without a measured duration,** which at deploy means every existing video lesson, remain weakly protected: a client can claim a short duration and wait 45% of it. Step 1 of the rollout sizes this. New uploads always record a duration, and a re-upload fixes an old lesson. Rejected: using the editor's minutes as a floor (round-1 B1), because they overstate the length and would block honest learners.
- **A learner whose first heartbeat was queued** gets `started_at` at replay time. That happens on a dropped connection, and also, since Phase 5, while a sleeping enrollment service answers with a hibernation 429 (drift D4). On the free tier that is common, and it hits short videos hardest. If the learner reaches the end before enough time has passed, `/complete` returns 409 with `retry_after_seconds`, and the web retries once after that wait. They don't have to rewatch. `/complete` on a video lesson is never queued, so a refusal is never dropped silently.
- **New default limits on viva and project** may stop a few learners mid-course. The educator can raise them in the form, and rollout step 1 counts the affected learners.

## Progress and deviations (implementer)

Executed with subagent-driven development: one implementer per task, then a task review, then a fix round where needed. Commits are on `fix/learning-integrity`.

- **Step 1:** done (8b030cb).
- **Step 2:** done (8977ed1). `db:check` is at 0 on a fresh DB and after the backfill. The backfill sets `started_at = updated_at − duration_seconds`. The revert round-trips with `-t none` for all three migrations.
- **Step 3:** done.
  - Course: 4d6c4e3, 21c67aa, 6125abb.
  - Enrollment: 98a140c.
  - Origin/main was merged in after 6c landed (3e72a3b).
- **Step 4:** done.
  - The duration probe on both upload paths: 1ecf677.
  - The learn page (final position, the 409 message, one retry of at most 120 s, and `/complete` on a video lesson through `api()`): 50274bf and 788dbaf. 788dbaf ignores a result that lands after the learner moved to another lesson.
  - `ApiError` now carries the parsed error body.
- **Step 5:** done (1af1615, a854ab0).
- **Step 6:** done.
  - Submit claim and `breakdown`: 32d6ed1, 94c08b9.
  - Teach form limits for every type: f1abd7b.
- **Step 7:** done.
  - api: 1f63f1d (`file_size` signing, the submit HEAD and size check, the storage `deleteObject`) and dff2b9b (the planner's ruling P-1 below).
  - web: 059928b (the project file flow).
- **Step 8:** done.
  - demo-seed: ebe2fc3.
  - e2e-smoke, the new `scripts/e2e-learning.mjs`, and its CI step right after e2e-payments: f40b386.
- 7b (#27) was merged in from origin/main at 09a1564, with no conflicts.

Deviations and rulings (the plan left these open, or the review surfaced them):
- **Deploy skew:** an internal lesson response without `has_video` is treated as a lesson without video. A course service older than 6b, during the deploy window, would otherwise 409 every text lesson.
- **Old duplicate open attempts:** an open attempt is reused only if it was created after every finished attempt of that learner and assessment. Older open rows from before this change are ignored: never reused, closed or counted. Without this rule, a learner with a duplicate open row left over from before the change could replay it after passing, skipping the pass check, the limits and the cooldown. Found in the task review.
- **Start refusals are thrown after commit.** The start transaction returns a refusal and the service throws it after commit, so an expired quiz attempt's close still persists before the refusal (today's behaviour).
- **Old project rows without a key:** a reused open project attempt with no `file_key` (from before this change) gets one inside the transaction.
- **Duplicate submit:** a sequential duplicate submit also answers 409 `Attempt already submitted.` (it was 400), the same answer the concurrent loser gets. The proctor-event check keeps its 400.
- **Refusal messages:** viva and project refusals use the quiz texts with "assessment" in place of "quiz"; quizzes keep today's exact texts.
- **Project size text:** a size above the cap gives `Project files can be up to 50 MB.` (start and submit). The original missing-size 400 was replaced by the planner's ruling P-1 below.
- **Storage:** `@ethiopialearn/storage` gains a minimal `deleteObject(key)` for decision 10.
- **Multipart duration:** a failed duration follow-up PUT is silent. The upload ends as done and the lesson stays unmeasured.
- **`proctorReport`:** it returns `breakdown: null` to the learner while retries remain (the shape it already used); the submit response omits the field.

- **Planner ruling P-1, amending D7 and D9:** `file_size` is optional on a project start.
  - Without it, the start opens or reuses the attempt and returns the project brief (`instructions`) with no `upload_url`. The panel's Start shows the brief and the file picker before any file is chosen.
  - Choosing a file starts again with `{ file_size }`, which reuses the open attempt and returns a URL signed for that size, then uploads.
  - No upload URL is ever issued without a declared size.
  - An invalid size gives 400 `Invalid file size.`; above the cap it gives `Project files can be up to 50 MB.`.
  - Why: under D7 the brief only arrived after a file was chosen.
- **e2e-smoke and the refusal:** the refusal assertions (an early 100% claim is not completed; `/complete` answers 409 with `retry_after_seconds`) live in `e2e-learning.mjs`, which uses a fresh learner and its own course each run. The smoke reuses the demo learner, whose seeded lesson is already complete, and a rerun after the time window would pass an early claim. The smoke's video checks now fit a measured 2 s lesson.
- **`e2e-learning.mjs` builds its own free course per run,** created as a draft and then approved. The course has:
  - an uploaded stand-in video lesson measured at 600 s;
  - a text lesson;
  - a quiz with `max_attempts: 2`;
  - a project.

  This way the script doesn't depend on demo-seed's best-effort sample-video download.

Gate: not run yet (step 9). Each task ran `pnpm -C api build`, `typecheck` and `test` (the last api run: 64 suites, 1202 tests) or `pnpm -C web typecheck` and `test` (55 files, 488 tests).

### In flight / next step
- Step 9 gate running on f40b386, alongside the final whole-branch review. Then the fix wave if needed, then code review round 1 with ethio-reviewer (base: origin/main ff1d89e).
- Phase 6d (`2026-10-03-sponsor-refund-integrity`) is queued to start once 6b's code review is APPROVED.
