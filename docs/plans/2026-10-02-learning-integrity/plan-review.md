# Plan review: Phase 6b, security hardening II (learning integrity)

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)"), against `origin/main`:
- enrollment: progress service, controller and entities;
- outcomes: assessment service and controllers;
- course: the lesson entity and the lesson editor.

Checked and OK:
- **Progress lookup.** `saveVideoProgress` and `completeLesson` already call `liveLesson()` on every request (`enrollment.service.ts:141,157,213-217`). Adding `duration_seconds` and `has_video` to that internal response costs no extra call.
- **Attempt lock.** A transaction-scoped advisory lock is the right choice behind the pooled Neon URL. Blocking (not `try`) plus "reuse the newest open row" gives one open attempt per learner and assessment without a unique index, and the reason for rejecting the unique index holds.
- **Breakdown leaks.** `myAttempts` returns no `breakdown` (`assessment.service.ts:740-760`), so the submit response and `proctorReport` are the only places that do, as decision 8 says. With the study coach listing missed prompts (a non-goal, with a reason), decision 8 mostly hides the selected answers. That's fine as a deliberate trade-off.
- **Claim after grading** (decision 7). It doesn't burn an attempt on a Groq error. The cost is a duplicate grading call when two submits race, which is acceptable.

### Blockers
- **B1. Legacy durations are the editor's rounded "minutes". Once they become the required length, learners who watch the whole video can't complete the lesson** at Decisions 2 and 3
  Today the completion percent is computed against the row's own client-reported duration (`enrollment.service.ts:166-168`). The lesson's `duration_seconds` is never used, and `/complete` always succeeds.

  6b makes the lesson's `duration_seconds` the `required` length whenever it's above 0. For every existing lesson, that value comes from the editor's optional "minutes" field, `Math.round(minutes * 60)` (`sections-editor.tsx:218,360`). An estimate, typically rounded up to whole minutes.

  Scenario: a 4:10 video entered as "5" minutes gives `required = 300`. At `ended` the player reports position 250, which is 83%. The heartbeat never reaches 90%, and decision 3 now turns "Mark complete" into 409 "Finish watching this lesson". That repeats on every retry, so the learner can't complete the lesson, the course or the certificate. Any lesson whose entered minutes exceed the real length by more than about 11% is affected. For short videos, rounding up to the next minute is usually enough: 2:30 entered as 3 gives 83%. The new upload probe only fixes videos uploaded after the deploy.

  Suggested fix: treat only a measured duration as authoritative. For example:
  - Store the probe's value separately, such as `video_duration_seconds`, set by the post-upload probe through the lesson update DTO. Use it as `required`, and leave the minutes field as a display estimate. Legacy lessons then use the client fallback, which the plan already accepts as a risk.
  - Or keep one column, but when the client-reported duration is within 60 s below the server duration (the rounding error), use the client value.

  Add a test: a lesson with an entered duration of 300 s, a player duration of 250 s and enough elapsed time → completes. Rollout step 1 can also count lessons whose stored duration isn't a whole-minute multiple, to see how many were measured.
  Response: **Fixed with your first option.** The editor's minutes are never a requirement.
  - A new `lessons.video_duration_seconds` column holds the measured length. It is mirrored in pending staging, so a staged video carries its duration. It is set by the post-upload probe through the lesson update DTO and cleared when the video changes without a new value.
  - `required` is that value, else the capped client duration.
  - Your 300 s / 250 s test is in the test plan.
  - Rollout step 1 now counts video lessons, which all start without a measured duration. Your whole-minute heuristic isn't needed, because no existing value is treated as measured.

### Should-fix
None.

### Nits (optional)
- **N1.** Migration backfill: `started_at = updated_at` is the *last* heartbeat. A learner mid-lesson at deploy who reaches 90% within `0.45 × required` of it gets 409 for a while, which contradicts "isn't blocked". Backfill existing rows with an older time instead (for example `updated_at - make_interval(secs => duration_seconds)`). Rows that exist before the deploy aren't a meaningful attack path.
- **N2.** The post-upload duration probe needs an `error` handler and a timeout. Browsers fire no `loadedmetadata` for formats they can't decode (HEVC or MKV in Chrome, for example), so without them the probe never resolves. On failure, skip the update and leave the minutes field as it is.
- **N3.** `proctorReport` serves both the learner and course staff (`assessment.service.ts:614-621`). Apply decision 8's withholding only when the caller is the attempt's learner, and keep the breakdown for staff.
  Nit responses:
  - N1: taken. The backfill is `updated_at - make_interval(secs => duration_seconds)`.
  - N2: taken. The probe handles `error` and has a 10 s timeout; on failure it skips the update.
  - N3: taken. `proctorReport` withholds `breakdown` only from the attempt's learner.

## Round 2 (2026-10-02) · Verdict: APPROVED
Reviewed: the round-1 rework in `plan.md` (status "in review (round 2)"): decisions 1, 2 and 8, the migrations, the API contract and the tests. I checked only the changed parts.

Round-1 findings:
- **B1** resolved. Only `video_duration_seconds`, the probe-measured length, is ever `required`. The editor's minutes no longer gate anything, and the 300 s / 250 s test is in the plan.
  - On a live course, the clearing works through the existing staging. `updateLesson` builds its changes with `definedFields`, which keeps an explicit `null`, and stages them over the live row (`course.service.ts:578-591`). The video change from the upload's `completedResult` stages `null` for the duration, the probe's update then stages the value, and approval applies both.
  - FYI for the user: every existing video lesson starts unmeasured, so for existing courses P1-04 is closed only as each video is re-uploaded. Until then they use the capped client fallback, as the non-goals say. Rollout step 1 sizes it.
- **N1, N2, N3** taken.

### Nits (optional)
- **N4.** Extend the test "changing or removing `video_s3_key` clears `video_duration_seconds`" to cover the staged case:
  1. On a live course, replace the video and let the probe fail (no duration update).
  2. Approve the revision.
  3. The live `video_duration_seconds` should be null, not the old video's value.

  A shorter new video with a stale, longer measured duration would bring back the B1 lockout.

No open blockers.
  Nit response (round 2):
  - N4: taken. The live-course clear case is in the test plan.

## Drift check (2026-10-03, against origin/main 4b4a64c and fix/security-platform)
Not a review round: the plan stays APPROVED. A read-only check of the code this phase will be built on, after Phases 3–5 merged (`origin/main` 4b4a64c) and with 6a in flight (`fix/security-platform`). Subagents did the sweep; I verified every blocker against the code myself. The planner folds these into the plan before the handoff. Blocker here means the implementer would build something wrong or silently break a merged behaviour or test.

### Blocker
- **D1. Decision 1 and the data model: "a staged video carries its duration, and both go live on approval". Approval drops it.**
  - Revision approval copies only `title`, `summary`, `duration_seconds` and `video_s3_key`, then sets `pending: null` (`api/services/course/src/staging.ts:79-86`; `mergedLesson` in `revision-diff.ts:155-163`).
  - So a staged `video_duration_seconds` is lost, and live keeps the old duration. That's the N4/B1 lockout: a learner can't complete a lesson whose required time is the old video's length.
  - `insertSection` also lists the lesson fields by name (`course.service.ts:1479-1491`), and every seeded video lesson is created that way (`demo-seed.mjs:230-269`).

  **Fix:** add `staging.ts`, `mergedLesson` and `insertSection` to steps 2–3. This gap predates the plan.
  → Planner: fixed. Verified (`staging.ts` lesson loop, `mergedLesson`, `insertSection`). Decision 1 now lists every by-name copy, adding `createLesson` and the canonical hash (an added lesson's duration is hashed only when not null, so revisions submitted before the deploy still match). `LessonPending` is jsonb, so there's no migration for it. Also covered in Current state, step 3 and two tests.

### Fixes
- **D2. Decision 2.** When a video is replaced, `onRevisionApplied` resets the percent and position but keeps the row (`enrollment.service.ts:487-494`). `started_at` survives, so the time check is already met for the new video. Reset `started_at` there too.
  → Planner: fixed (decision 2, data model, test plan). `started_at` stays nullable: the reset sets it to null, the next heartbeat sets `COALESCE(started_at, now())`, and null fails the time check. A reset to `now()` would let a learner who returns later complete the lesson with one 90% claim.
- **D3. API contract.** The submit route is `PUT /attempts/:id/submit` (outcomes `controllers.ts:138`; web `assessments-panel.tsx:44`), not POST.
  → Planner: fixed (API contract, Current state).
- **D4. The risk "queued offline needs a connection drop", and decision 3's 409.**
  - Phase 5 also queues writes on a `WakingError`, which a hibernation 429 raises (`web/src/lib/offline-queue.ts:49`). A sleeping enrollment service therefore delays `started_at`, and short videos get false 409s.
  - A queued `/complete` that gets a 409 on replay is silently dropped (:92-96).

  Restate the risk, and decide whether `/complete` should be queued at all.
  → Planner: fixed (decision 3, Risks, API contract). `/complete` on a video lesson is no longer queued; the web sends it directly and shows a "try again" message while the server is waking. Text lessons stay queued (they can't 409). When only the elapsed time is missing, the 409 carries `retry_after_seconds` and the web retries once, so a late `started_at` costs a short wait, not a rewatch.
- **D5. Step 8 ("before the smoke step"), step 9, and the handoff's "How to run".**
  - Phase 5 put Build web and Playwright between e2e-payments and e2e-smoke, timed so the login limiter refills (`ci.yml:106-135`).
  - Playwright's verify.spec needs demo-seed's certificate (`web/e2e/support.ts:70-73`), and layout.spec opens `/learn/<course>` (`layout.spec.ts:70-76`).

  Run e2e-learning right after e2e-payments, and add `pnpm -C web exec playwright test` to the gate.
  → Planner: fixed (Current state, decision 4, steps 8–9, test plan). e2e-learning runs right after e2e-payments with one login per role; demo-seed must still issue the learner's certificate; the gate adds Playwright.
- **D6. The Base line.** It says "after Phase 6a", but the order is 6a → 6c → 6b (6c's plan :6). Base on main after 6a *and* 6c. 6c is financial-only, so there's no migration clash.
  → Planner: fixed (Base line, handoff Branch). Per the user's stacked order, 6b branches from `fix/money-integrity` (6c, itself on `fix/security-platform`) and merges `origin/main` once 6a and 6c have merged.
- **D7. Decision 9, "the file is chosen before the start", is the other way round.**
  - Start POSTs with no body (`assessments-panel.tsx:32-36`), and the picker is in ProjectForm, which appears only once `upload_url` exists (:158-180).
  - So a required `file_size` breaks today's Start button with a 400.

  State this, and move the picker before Start.
  → Planner: fixed (decision 9, Current state, step 7, test plan). For a project, choosing the file starts the attempt with `file_size` and then uploads; quiz and viva starts are unchanged.
- **D8. The handoff's "sections-editor.tsx (where the video upload finishes)".**
  - The upload finishes in `video-upload.tsx:152-183`.
  - Its single-PUT path sends `PUT /lessons/:id {video_s3_key}` (:159), which clears the duration under the new rule.

  Point the handoff there, and send the duration in that PUT.
  → Planner: fixed (decision 1, Current state, step 4, handoff). The probe starts at file choice. The single-PUT attach sends the key and the duration together; multipart sends a duration follow-up after the server attaches.

No 6a collisions: 6a only swaps `@Param` for `UuidParam` and wraps internal calls in `internalPath` on these routes, so 6b's added `@Body` fits on top.

## Round 3 (2026-10-03) · Verdict: APPROVED (the two additions to decisions 2 and 3 only)
Reviewed: the changes that go beyond the drift items, checked against `enrollment.service.ts` `onRevisionApplied` (:474). The drift answers D1–D8 are all present.

- **`started_at` stays nullable and is reset on a replaced video: OK.**
  - `onRevisionApplied` already zeroes `position_seconds`, `duration_seconds` and `percent_watched` in the same update. Adding `started_at: null` there means the new video needs both 90% and the elapsed time again.
  - A null start fails the time check, so a missed first heartbeat can only delay a completion, never grant one.
  - `DEFAULT now()` covers inserts, and the `COALESCE` covers updates.
- **`retry_after_seconds` on the 409, and `/complete` sent directly: OK.** An offline learner loses nothing. Queued heartbeats replay later and can still complete the lesson, because heartbeats check the rule too, measured at replay time.

### Blockers
None.

### Should-fix
None.

### Nits (optional)
- **N1.** Say the server rounds `retry_after_seconds` up (`Math.ceil`). If it rounds down, the one retry can arrive up to 1 s early and get a second 409. The learner then sees "Finish watching this lesson" after watching to the end.
- **N2.** Bound the automatic wait. For example, auto-retry only when `retry_after_seconds` ≤ 120, and otherwise show the 409 message. A learner who skips to the end of a long video gets a wait of tens of minutes. A silent timer that long completes the lesson much later, with nothing on screen to explain why.

No open blockers.

→ Planner (2026-10-03): N1 and N2 taken (decision 2, the `retry_after_seconds` bullet: rounded up; auto-retry only when ≤ 120 s, otherwise the 409 message).
