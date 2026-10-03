# Phase 9b step 4: shared brief for every service agent

You are converting one service's publish sites to the transactional outbox, in the git worktree
`/home/kal/Documents/code/ethi0-9b` (branch `fix/outbox`). Five other agents are converting the
other services in the same worktree at the same time.

## Read first
- `docs/plans/2026-10-02-outbox/plan.md`: Goal, Non-goals, Current state's table, decisions 1–6, Data model, step 4.
- `docs/plans/2026-10-02-outbox/plan-review.md`: round 1 (B1, B2, S1, N1–N3) and "Drift check vs 9a" (D1, D2).
- `docs/plans/2026-10-02-outbox/handoff.md`: "Decisions already made" and "Gotchas".
- `api/packages/common/src/events/outbox.ts`: the API you use (already built and committed; don't change it).

The plan is approved. Don't redesign it. If something in it is wrong or impossible for your sites, stop on
that site, do the rest, and report the problem with a proposed change.

## The API
```ts
import { OutboxService } from '@ethiopialearn/common';
constructor(..., private readonly outbox: OutboxService) {}   // provided globally by EventBusModule.forRoot({ outbox: true })

const result = await this.outbox.transaction(async (m, emit) => {
  // every write of the state change goes through m (m.getRepository(X), m.query, …)
  emit<RefundApprovedPayload>('RefundApproved', payload, { correlationId });   // synchronous: queues the event
  return something;                                                            // transaction() returns it
});
```
- `emit` is synchronous: it queues the event, and the rows are inserted at the end of `fn`, in emit order, in the
  same transaction. If `fn` throws, nothing commits and nothing is published.
- After commit, `OutboxService` publishes the rows itself (fast path, then a relay). The caller never publishes.
- `outbox.transaction` **throws if called inside `runOnce` or another `outbox.transaction`** (drift D2). It opens its
  own transaction on a fresh connection, so never call it from inside a `dataSource.transaction` /
  `manager.transaction` callback either: restructure so the outbox transaction is the only one.
  A site that already uses `dataSource.transaction(async (m) => …)` switches to `this.outbox.transaction(async (m, emit) => …)`.
  A site that has no transaction gets one.
- Payload shapes don't change. Only the events in the plan's table move. Notification-only events (Non-goals)
  keep their plain `this.bus.publish(...)`.

## Specs
- Each service's existing specs must stay green. Adjust a spec only where it asserted the old publish call; say so in the report.
- For each converted site, add a spec: the state change and the outbox row commit together, and an error before
  commit leaves neither. A fake `OutboxService` is enough for unit specs, for example:
  ```ts
  /** outbox.transaction with the spec's fake manager: emitted events "commit" only when fn resolves. */
  function fakeOutbox(manager: unknown) {
    const committed: Array<{ type: string; payload: unknown }> = [];
    const outbox = {
      transaction: jest.fn(async (fn: (m: unknown, emit: (type: string, payload: unknown) => void) => Promise<unknown>) => {
        const queued: Array<{ type: string; payload: unknown }> = [];
        const result = await fn(manager, (type, payload) => queued.push({ type, payload }));
        committed.push(...queued);
        return result;
      }),
    };
    return { outbox, committed };
  }
  ```
  If the service's existing fake manager can't roll back writes, make the "error before commit" spec assert what it
  can (no committed event, the error propagates) and say so in the report. Don't build a big new test harness.
- Put a reusable fake in the service's own `src/testing/` folder only if several spec files need it (quality already
  has `src/testing/`, which the build excludes).

## Rules
- Only edit files under your service's directory (`api/services/<service>/`), plus anything the per-service
  instructions name. Never edit `api/packages/common`. If you think common needs a change, report it.
- No git commands that change state (no commit, add, stash, checkout, reset, merge). The lead commits.
- Don't run `pnpm -C api build`, `pnpm -C api test` or turbo tasks (other agents share the worktree). Run only:
  - `export PATH=/home/kal/.local/opt/node22/bin:$PATH` first, in the same command;
  - `cd /home/kal/Documents/code/ethi0-9b/api && pnpm exec jest --ci services/<service>`;
  - `cd /home/kal/Documents/code/ethi0-9b/api/services/<service> && pnpm exec tsc -p tsconfig.json --noEmit`.
- Don't run migrations or touch any database or the docker stack. The lead verifies migrations.
- Match the surrounding code: naming, comment density and style (no Prettier in this repo; 2-space indent, single
  quotes, long lines are normal). Keep it simple: no new abstractions beyond what the plan asks for.
- Check every converted caller isn't already inside a transaction or a `runOnce` body (handoff "Nesting" gotcha).
- Never print or copy values from any `.env` file.

## Report (your final message)
1. Each site converted: `file:line`, the event, and the transaction it now commits in.
2. Sites in the plan's table you did not convert, and why.
3. Specs added or changed (file and test names), and the jest and tsc results (paste the summary lines).
4. Deviations from the plan, problems, and anything the lead must check or do (migrations to verify, common changes).
