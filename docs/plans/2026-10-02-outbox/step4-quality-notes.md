# Phase 9b step 4: quality findings (read before converting quality)

From the quality agent's read of the code on 2026-10-03. No quality file was changed. Line numbers are at `d99ca56`.

## Sites (none converted yet)
- `publishDecision` (`CourseReviewed`, `CourseRevisionReviewed`), plus the revert-and-503 at `quality.service.ts:538-547`
- `CourseRated` at `:684`
- `TrustTierChanged` in `recomputeTier`, at `:751`
- `FraudFlagRaised` in `raiseFraudSignal`, at `:780`
- `FraudFlagResolved` in `resolveFlag`, at `:806`
- both fraud migrations and their migration spec
- the D1 spec and the fraud specs

## D2 is safe
- Every caller of `recomputeTier`, the fraud raise and the plagiarism screen already runs after `runOnce` returns, never inside its body:
  - the `CourseCompleted`, `PaymentConfirmed` and `RefundApproved` handlers (`:174-206`);
  - `enqueueSubmission` and `enqueueRevision` (`:276-279`, `:378-381`), which call outside `inCourseOrder`.
- `addReview`, `resolveFlag` and the controller's `raiseFraudSignal` aren't in any transaction.

## Fraud dedupe migration (`1791060000000-FraudSignalDedupe`)
- There's no note column, and `resolved_by` is a uuid, so `detail` is the only text column for "duplicate":
  - `detail = trim(detail || ' (duplicate)')`;
  - `resolved_at = now()`;
  - `resolved_by` stays NULL.
- Do it in one statement, with `INSERT` as the top-level command:
  1. a CTE ranks the open signals with `row_number() OVER (PARTITION BY subject_type, subject_id, signal_type ORDER BY created_at, id)`;
  2. an `UPDATE … RETURNING` resolves the rows with rank above 1;
  3. `INSERT INTO "quality"."outbox" (id, event_type, payload) SELECT gen_random_uuid(), 'FraudFlagResolved', jsonb_build_object(…the resolve path's payload: flag_id, payee_id, …) … RETURNING id`.

  TypeORM's `query()` returns `[rows, count]` for a top-level UPDATE, so keep `INSERT` on top.
- Log the count with Nest's `Logger`; the TypeORM logger only prints `schema`.
- Check the payload against `resolveFlag`'s emit before writing it.

## Index migration (`1791060000001-FraudSignalOpenUnique`)
- **Entity:** `@Index('IDX_fraud_signals_open_subject_signal', ['subject_type', 'subject_id', 'signal_type'], { unique: true, where: \`status = 'open'\` })`.
- **Migration:** `transaction = false`, `DROP INDEX CONCURRENTLY IF EXISTS` and then `CREATE UNIQUE INDEX CONCURRENTLY … WHERE status = 'open'`, as in financial's `PaymentIntegrityIndexes1790966512487`.
- **Race, open, impl to decide and log as a deviation:**
  - Render boots the new instance while the old one still serves, so the old instance can raise a duplicate between the dedupe commit and the index build.
  - The index build then fails on every re-run, because the dedupe migration is already recorded.
  - **Proposed fix:** the index migration repeats the dedupe statement before its DROP/CREATE. That matches the plan's "so a re-run repeats both".

## Raise
- Inside `outbox.transaction`, a raw `INSERT … ON CONFLICT DO NOTHING RETURNING *` through `m.query`, in the style of `bumpStats`.
- Emit only when a row came back.
- On a conflict, return the existing open row, so the admin endpoint still returns a signal.
- `checkRefundAbuse`'s `findOne` pre-check then becomes redundant.

## Decision
- `updateIfActionable` and `findItem` take an optional repository, so the conditional update and its conflict re-read both go through `m`. A second connection would hold two of the three pool connections at once.
- Delete the `previous` revert and the `ServiceUnavailableException` import.

## Specs
- In `src/testing/fake-data-source.ts`, build a real `OutboxService` over the fake data source, with a bus whose `isConnected()` returns false. Real `runOnce` sets the same nesting scope, so the specs would catch an emit inside a `runOnce` body.
- The fake needs:
  - a `quality.outbox` INSERT handler;
  - an in-memory `fraud_signals` table that enforces the open-signal conflict;
  - `getRepository(OutboxEvent)` metadata;
  - snapshot-and-restore on throw for the fraud, outbox and review-item rows;
  - a `failNextOutboxInsert` hook.
- Both spec files construct `QualityService` positionally, so both need the new `outbox` argument.
- Their `bus.publish` assertions for these events move to the outbox rows: `qa-review.spec.ts` `published(...)` and `quality.service.spec.ts:68`.
