# Phase 6b: code review (ethio-reviewer)

## Round 1 (2026-10-03) · Verdict: CHANGES REQUESTED (one blocker, a one-line fix)
Reviewed `git diff ff1d89e...cfbd780`. The head is `4c0c836`, and `cfbd780..4c0c836` changes only `plan.md`. I read the enrollment and outcomes code myself; an agent covered course, web, scripts and CI, and I checked its findings against the code.

**Gate, rerun in the review worktree at `cfbd780`:**
- api: build and typecheck clean; jest 1234 passed, 1 skipped.
- Scratch DB `el_verify_6b`, with every service migrated: db:check reports no drift. `IDX_assessment_attempts_lookup (assessment_id, learner_id, submitted_at)` has no predicate.
- Revert and re-run of the 3 new migrations (outcomes CONCURRENTLY, enrollment, course) round-trips, and db:check is still clean.
- web: typecheck clean; vitest 587/587; build ok.
- I didn't rerun e2e and Playwright; those results are from impl's run 2.

### Blocker
**B1. A duplicated course loses its measured video durations.**
- Where: `course.service.ts:71-79`. The exported `mergedLesson` (used by `duplicate()` at `:915`) copies `title`, `summary`, `duration_seconds` and `video_s3_key`, then `...lesson.pending`, but not the live `video_duration_seconds`.
- Scenario: an educator duplicates a course whose videos were measured. The copy's lessons keep the video keys with a null duration. Once the copy is published, enrollment falls back to the client-reported duration, so a learner sends `duration_seconds: 2` and completes a 2-hour lesson after about 1 s. That is P1-04 again, and decision 1 says "every by-name copy" carries the field.
- A duration that is only staged is copied, through the `pending` spread; the live value is what goes missing.
- Fix: add `video_duration_seconds: lesson.video_duration_seconds` before `...lesson.pending`, plus a `duplicate()` unit test that asserts it.
- The display caller at `:1289` is unaffected.

### Should-fix
**S1. A stale open attempt left over from before 6b can still be submitted.**
- Where: `assessment.service.ts`. `startAttempt` ignores open rows older than the newest finished attempt (deviation "Old duplicate open attempts"). `submitAttempt` (~:476-480) checks only the owner and `submitted_at`, not that rule or the limit.
- Scenario: before 6b, every viva or project start inserted a row. A learner who started a viva 5 times keeps 5 open rows. After 6b, they finish 3 attempts and start is refused. They can still `PUT /attempts/<old id>/submit` on the other rows. Each submit is a Groq evaluation and a recorded result, and it can be a pass. That bypasses "max_attempts holds for viva and project" for exactly the population P-2 counted.
- It is limited to rows that already exist, which is why it isn't a blocker.
- Simplest fix: in `submitAttempt`, before grading, refuse (409 "Attempt already submitted." or the limit's 403) when a finished attempt of this learner and assessment was created after this one, or when one of them passed. That is one `count`/`exists` query on the new index. If you defer it instead, say so in Progress with the reason.

### Nits (optional)
- N1: `e2e-learning.mjs` ~:236 sends `duration_seconds: 600`, the course's measured value, so it doesn't show that the server ignores a smaller client duration. The unit tests cover it. A heartbeat of `{ position_seconds: 2, duration_seconds: 2 }` asserting `completed: false` would cover it end to end.
- N2: during the hidden retry wait (≤120 s, plan round 3 N2), "Mark complete" does nothing and says nothing. A `role="status"` line such as "Almost done. Finishing in a moment…" would tell the learner something is happening. The plan chose the hidden timer, so this is optional.

### Checked and fine
**Enrollment**
- `applyHeartbeat`: `started_at ??=` on the first heartbeat; position clamped to `required + 5`; the percent high-water mark is taken against `required`; one re-read on a unique violation.
- `completeIfWatched`: the 90% and `0.45 × required` rules; a null `started_at` or an unknown length never completes; `retry_after_seconds` only when just the time is missing; the refusal is logged.
- `/complete` on a lesson without video completes as before.
- `onRevisionApplied` resets `started_at` to null.
- A `has_video` missing during the deploy window counts as false (deviation).
- The migration's backfill and its nullable default.

**Outcomes**
- Start: the advisory xact lock; the newest open row is reused only when it is newer than every finished attempt; an expired quiz is closed and counted; the pass, limit and cooldown checks now apply to every type; a refusal is returned and thrown after commit.
- Viva: the question is generated only when missing, with a conditional save.
- Project: the presign is signed for the declared size only when one is given (P-1), and the size is validated before the lock.
- Submit: grade, then the conditional claim, then publish on `affected` only. Projects get a HEAD check and a delete when oversized.
- `breakdown`: withheld in the submit response and from the learner in `proctorReport`.
- Proctor event: a conditional column update.
- The CONCURRENTLY index migration is drop-first and repeatable.

**Course, web, scripts and CI** (agent, spot-checked):
- `updateLesson`'s clear rule, including undoing a staged replacement and a second replacement.
- The staging approval, `revision-diff` `mergedLesson`, `insertSection` and `createLesson`.
- The hash includes the field only when it isn't null.
- The internal endpoint returns live values. The DTOs cap at 86,400, and the CHECK is > 0.
- The probe has an `error` handler and a 10 s timeout. A single PUT sends the key and duration together; multipart sends a follow-up.
- `/complete` on a video lesson goes through `api()`. It retries once at ≤120 s, and the epoch guard ignores a stale result.
- Project flow: Start shows the brief; the file picker starts with `file_size`; Submit is disabled until the upload succeeds; submit goes to the attempt the upload used.
- e2e-learning asserts every check in step 8, and none is vacuous. CI order: payments → learning → security → Build web → Playwright → smoke.

**Complexity check:** nothing extra. `deleteObject` is the minimum decision 10 needs. `attemptLimits` replaces inline code that was duplicated. No new env var, table or job.

Round 2 will check B1 (and S1, if fixed) and review only `cfbd780..<new head>`.

### Round 1 response (impl, 47bbc2c)
- **B1: fixed.** `mergedLesson` copies the live `video_duration_seconds` before the `pending` spread. A new `duplicate()` test checks both the live length and a staged one, and it fails without the fix.
- **S1: fixed.** `submitAttempt` now applies start's rule before grading. It refuses with 409 "This attempt is no longer open." when a finished attempt of this learner and assessment was created at or after this one, or when one passed.
  - It reads the learner's finished rows (at most max_attempts) on the existing index, the same as start.
  - It runs for every type, so there's no Groq call and no stored result.
  - Three new tests: a stale row, an attempt after a pass, and the current row is still graded.
  - Two anticheat fixtures had finished rows created in the same millisecond as the open row; they now date the finished rows a minute back.
- **N1: deferred.** The local stack is held for 8a's gate, and the unit tests already cover the server ignoring a smaller client duration.
- **N2: deferred.** The plan chose the hidden retry.
- **Tests:** api jest 1238 passed, 1 skipped; tsc clean for outcomes and course.

## Round 2 (2026-10-03) · Verdict: APPROVED
Reviewed `cfbd780..46e9ff6` (the code is `47bbc2c`).
- **B1: resolved.** `mergedLesson` copies the live `video_duration_seconds` before the `pending` spread. The new `duplicate()` test covers both a live duration and a staged one. The display caller is unaffected.
- **S1: resolved.** `submitAttempt` refuses before grading (409 "This attempt is no longer open.") when a finished attempt is the same age or newer, or one passed, so there's no Groq call and nothing stored. There are three tests: a stale row, after a pass, and the current row still graded. The two anticheat fixtures were updated to backdate finished rows and keep the same-millisecond tie out of the way; on real rows that tie is effectively impossible.
- **N1 and N2:** deferral accepted.
- **Gate at `46e9ff6`, in the review worktree:** api build and typecheck clean; jest 1238 passed, 1 skipped. Web, migrations and db:check are unchanged since my Round 1 gate.
- **Before the merge:** ethio-planner reruns e2e and Playwright against the stack once the 8a window closes. impl couldn't rerun them on this head. The fix is api-only, but e2e-learning drives submit.
