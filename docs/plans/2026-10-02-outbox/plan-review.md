# Plan review: Phase 9b, transactional outbox

## Round 1 (2026-10-02) · Verdict: CHANGES REQUESTED
Reviewed: `plan.md` (status "in review (round 1)", including the fraud dedupe moved in from 9a), against the code at `2cdccf9`.

### Answers to the planner's questions
1. **Fast path order check and the `SKIP LOCKED` relay (decision 3):** the shape is right, and the ordering holds wherever it matters: causally ordered events come from sequential transactions. Three gaps:
   - the fast path holds requests during an outage (S1);
   - the lock scope isn't stated (N2);
   - "commit order" claims more than the design gives (N1).
2. **The site list (decision 2 and Non-goals): complete.** I mapped every subscriber in a non-notification service to a table row or to Phase 4's re-publish. One more publish site exists, `revision.service.ts:440` (`publishReturned`, a coach `CourseRevisionReviewed`). Its only state-changing consumer is the course service itself, which ignores it, so leaving it on `publish()` is right. Name it in Non-goals so the implementer doesn't wonder.
3. **`detectCompletion` building its payload before the transaction:** this is B1. The plan's premise about today's behaviour is wrong, and the change blocks completions whenever a lookup fails.

### Blockers
- **B1. A failed lookup would block the course completion itself** at decision 4 (enrollment) and Risks ("`detectCompletion` builds the payload before the transaction")
  - **Today:** a lookup failure doesn't lose the event. The three lookups are in a try/catch that logs "enrichment failed" and still publishes `CourseCompleted`, with blank names (`enrollment.service.ts:604-631`). The event is lost only when the publish itself fails, and the outbox fixes that.
  - **With the plan:** a failed lookup writes nothing.
    - The learner's last lesson completes through `markComplete` on `ended` (6b), which is the last request they make. If auth is asleep or waking on the free tier, `users/:id` or `educators/:id` fails.
    - `completed_at` isn't set, there's no `CourseCompleted`, and no certificate is issued.
    - The next trigger is the learner completing a lesson again, or a revision recheck that removes lessons (`:495-530`). That can be never.
    - If the failure propagates, the learner's own request also returns an error.

  Suggested: keep the completion independent of the lookups.
  - In one transaction, commit the conditional `completed_at` write and the outbox row, carrying whatever the lookups returned (as today).
  - Consumers that need a missing name fetch it themselves and throw on failure, so 9a's retry outlasts a waking service. Outcomes' `issue()` needs `learner_name` for the PDF, and notification needs the email.
  - That also fixes today's blank-name certificate.
  - If you prefer lookups first, `detectCompletion` must return `false` rather than throw, and 9c needs a sweep that completes active enrollments with every live lesson done and `completed_at` still null.

  Response: fixed as you suggested. `detectCompletion` keeps its lookups in the try/catch and commits `completed_at` with the `CourseCompleted` row, carrying whatever the lookups returned. Outcomes' `issue()` and notification's `CourseCompleted` handler fetch missing names or emails themselves and throw on failure, so 9a's retry covers a waking service. That also ends blank-name certificates. The Risks premise is corrected, and step 4 adds the specs.
- **B2. Resolving duplicate fraud signals in SQL orphans financial's holds and leaves payouts held for good** at Data model ("quality, fraud signals", step 1, and the note "Resolving a duplicate publishes nothing, so the payee stays held by the kept signal")
  - **Why duplicates exist:** every `FraudFlagRaised` created its own hold row keyed by `flag_id` (`payout.service.ts:49-52`). They're realistic: each resubmission of a plagiarized course raises another open `plagiarism_suspected` signal on the same course (`quality.service.ts:232,310`).
  - **What breaks:** the migration resolves the duplicates without telling financial, so their hold rows stay. Later the admin resolves the kept signal:
    - `FraudFlagResolved` deletes only that `flag_id`'s hold;
    - `holds.count({ payee_id })` still sees the orphans, so `releaseFraudHolds` never runs (`:59-64`);
    - the payee's payouts stay held, and no visible flag is left to resolve.

  Suggested: for each duplicate it resolves, the migration also inserts a `FraudFlagResolved` outbox row with that signal's `flag_id` and `payee_id`. The outbox table is created by the earlier migration in the same deploy. The relay delivers them, financial drops those holds, and the kept signal's hold stays. Extend the migration spec to assert the outbox rows.

  Response: fixed. Migration step 1a inserts a `FraudFlagResolved` outbox row per resolved duplicate (that signal's `flag_id` and `payee_id`), so financial drops the orphaned holds. The migration spec asserts the rows. The admin "flag resolved" notices per duplicate are accepted as a one-off.

### Should-fix
- **S1. During a broker outage the fast path holds every emitting request for 5 s or more** at decision 3 (fast path)
  - **What happens:** after commit the helper awaits `publishConfirmed`, and with the broker down that waits for 9a's `EVENT_PUBLISH_WAIT_MS` (5 s) before failing. Every signup, enrollment, review decision and refund decision then answers 5 s or more late. That is the symptom 9a removed for `publish()`, back on the paths the outbox is meant to make outage-proof.
  - **Why it's unnecessary:** the row is already committed, so the response doesn't depend on the publish.

  Suggested:
  - skip the fast path when `!bus.isConnected()`;
  - don't make the response wait on it: start it after commit with its errors caught and logged, and leave failures to the relay;
  - extend step 6's drill to check the five actions respond in under 1 s with the broker stopped.

  Response: fixed. The fast path runs detached after commit, with errors caught and logged, and is skipped when `!bus.isConnected()`. Step 6's drill now requires the five actions to answer in under 1 s with the broker stopped. The acceptance criteria say the same.

### Nits (optional, max 3)
- **N1.** `created_at DEFAULT now()` is the transaction's *start* time, and the fast path's `EXISTS` can't see an older row that hasn't committed yet. For overlapping transactions, neither path gives commit order. Use `clock_timestamp()` at emit time, and word the guarantee as "events from sequential transactions keep their order". That's all the consumers rely on.
- **N2.** Say whether the relay holds its `FOR UPDATE SKIP LOCKED` lock while it publishes:
  - if it does, the transaction stays open across broker round-trips and holds one of 3 pool connections;
  - if it doesn't, `SKIP LOCKED` prevents nothing.

  On one Render instance, the in-process flag and 9a's dedupe are the real guards; either choice is fine once it's written down.
- **N3.** Have `outbox.transaction` refuse to run inside an already active transaction (`m.queryRunner?.isTransactionActive`). Nested, TypeORM uses a savepoint, and the fast path would publish on the savepoint's release, before the real commit. That's the "publish before commit" case decision 1 rejected.

### Planner responses to the nits and point 2
- **N1:** taken. `created_at = clock_timestamp()` at emit, and the guarantee now reads "events from sequential transactions keep their order".
- **N2:** taken, the no-lock variant. The relay selects without a lock or an open transaction, publishes, then marks with `WHERE published_at IS NULL`. `SKIP LOCKED` is dropped, and the in-process flag plus 9a's dedupe are named as the guards.
- **N3:** taken. `outbox.transaction` refuses to nest, with a spec.
- **Point 2:** `revision.service.ts:440` is named in Non-goals.


## Round 2 (2026-10-03) · Verdict: APPROVED (checks the round-1 fixes only)
Reviewed: `plan.md` (status "in review (round 2)").

Resolved:
- **B1:** `detectCompletion` keeps its lookups in the try/catch, and `completed_at` and the `CourseCompleted` row commit together. Outcomes' `issue()` and notification fetch missing names or emails and throw, so 9a retries. The Risks premise is corrected, and step 4 has the specs.
- **B2:** migration step 1a inserts a `FraudFlagResolved` outbox row per resolved duplicate, and the migration spec asserts them. The one-off admin notices are accepted.
- **S1:** the fast path runs detached and is skipped when the bus is disconnected; the drill requires under 1 s.
- **N1–N3:** all taken.
  - `clock_timestamp()` at emit, and the order guarantee is worded for sequential transactions.
  - The relay holds no lock. On one instance, the in-process flag and 9a's dedupe are the guards.
  - `outbox.transaction` refuses to nest.
- **`revision.service.ts:440`:** named in Non-goals.

No new blockers.

## Drift check vs 9a (2026-10-03)
Not a review round: the plan stays APPROVED. This is a read-only check of what 9b relies on against 9a as built (`fix/event-delivery` @ `fa06f83`, including its "Progress and deviations"). I read the bus, `runOnce`, `event-context`, quality, notification, certificate, auth signup and `scripts/e2e-broker-outage.mjs` at that commit.

### Mismatches (fold in before or during the step named)
- **D1. 9a's outage drill asserts the behaviour 9b deletes (step 6).** `scripts/e2e-broker-outage.mjs:157-160` expects a QO decision during the outage to return **503** within 6 s and the item to reopen. `:192` then decides the same item again after reconnect. 9b removes the revert-and-503, so as soon as 9b's quality commit lands those checks fail: the decision returns 200 and the item stays decided. The same applies to `qa-review.spec.ts:874` ("reopens the item when the decision event cannot be published"), which 9b deletes along with the path.
  **Fold in:** in step 6, flip the drill's decision check. During the outage the decision returns 2xx in under 1 s, and the item is no longer in the queue. After reconnect, the course reaches `published` within two relay ticks. Drop the "decide again" step at `:192`. Step 4's quality commit replaces the `:874` spec with the planned "commits when the broker is down" spec.
- **D2. `runOnce` owns a transaction, and `outbox.transaction` refuses to nest (decision 1).** `runOnce(dataSource, consumer, eventId, fn)` runs `fn` inside `dataSource.transaction` (`common/src/events/run-once.ts`). In 9a every `runOnce` body is free of publishes: quality's enqueue and stats handlers and course's `enrolled-count` only write rows. The fraud raise (`checkRefundAbuse`), `recomputeTier` (`TrustTierChanged`) and the plagiarism screen all run **after** `runOnce` commits (`quality.service.ts:170-210`; B1 in 9a's deviations).
  This is a constraint for step 4, not a change: convert those sites where they are, outside the `runOnce` body. If an emit were moved into a `runOnce` body (for example `TrustTierChanged` through the stats manager), the nesting guard would throw on every delivery, and 9a would park the event after 5 attempts.

### Confirmed as the plan assumes
- `EventBusService.isConnected()` exists (the fast-path skip).
- `publishConfirmed(type, payload, opts: { timeoutMs?, correlationId? })` exists, so adding `eventId` is an option on it. The id is minted in `envelope()` with `randomUUID()` at `event-bus.service.ts:371`; the plan says `:168`, which is line drift only.
- Consumers dedupe on `envelope.metadata.event_id`, so 9b's stable ids are recognized everywhere 9a dedupes:
  - `runOnce` markers (quality's `PaymentConfirmed`, `RefundApproved` and `CourseCompleted` stats; course's `EnrollmentCreated` count);
  - notification's sent-email lookup (`IDX_notification_log_sent_event`, keyed on event id, recipient and type) and the inbox unique index (`source_event_id`), both read from `currentEvent()`;
  - outcomes' certificate save, which tolerates the unique violation on `enrollment_id`.
- 9a built no fraud-signal dedupe; plan-review 9a S1 moved it here, so 9b's index and migration don't collide with anything.
- The retry window (`EVENT_MAX_ATTEMPTS=5`, `EVENT_RETRY_DELAY_MS=60000`, about 4 min) outlasts a Render wake, which decision 4's "consumers fill in missing names, throw and retry" relies on. A failed handler retries the **whole message** in that service, re-running the handlers before it. For `CourseCompleted` in outcomes there is one handler (`certificate.service.ts:36`); notification's is `deliver`, which dedupes. Nothing double-applies.
- The quality revert-and-503 is now at `quality.service.ts:538-547` (`decide` → `publishDecision`); the plan says `:464-474`.
- Auth `signup` is still two separate saves plus a publish (`auth.service.ts:67-94`), as the plan says. 9a only added `pingRedis()` for `/ready`.
- The relay's start and stop fit 9a's bootstrap: `bootstrapService` registers `/ready` and `/health` on the adapter, and the bus uses `OnApplicationBootstrap`/`OnApplicationShutdown`. There's no conflict with an `OutboxService` doing the same.

### Planner response to the drift check (ethio-planner [aeff2b], 2026-10-03)
- **D1: fixed.** Step 6 gets a sixth check that flips the QO-decision assertions and drops the "decide again" step. Step 4's quality spec replaces `qa-review.spec.ts`'s reopen spec.
- **D2: fixed** as a constraint in step 4: no emit inside a `runOnce` body; the fraud raise, `recomputeTier` and the plagiarism screen are converted where they are.
