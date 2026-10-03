# Code review: Phase 8a (admin console, shared dialog, leave)

## Round 1 (2026-10-03) · Verdict: APPROVED
Reviewed `ff1d89e..b1a6044` on `feat/role-dashboards-a`, head `7e036c2` (origin/main with 6b merged in), against the plan's 8a scope and its Progress deviations. I read the API changes, `ConfirmProvider`, `SearchPicker`, the invites/Leave page, the learner refund and account delete myself. A `feature-dev:code-reviewer` pass covered `admin/page.tsx`, `growth-tabs.tsx`, `coupon-manager.tsx`, `Pager`, `Bars` and `EmptyRows`.

Run in my own detached worktree `../ethi0-8a-review` at `7e036c2`:
- `pnpm -C api build --force`: passes;
- `pnpm -C api test`: 67 suites, 1255 passed, 1 skipped;
- `pnpm -C web typecheck`: passes;
- `pnpm -C web test`: 72 files, 643 passed;
- `pnpm -C web build`: passes (`/admin` 9.94 kB, `/account/invites` 4.44 kB). `web` has no `lint` script.
- I didn't rerun Playwright or the e2e scripts; the planner's gate records them at `eec6fb0`.

What holds:
- **Every money-moving or destructive action asks first and stops on Cancel/Escape:** bank transfer, run payouts, release, refund approve and deny, fraud resolve, suspend and ban, unlist and archive, broadcast, wallet adjust, coupon deactivate, the learner refund, account delete and leave. Each has try/catch into `FormStatus` and a busy guard. The wallet title and payload use the same signed value. The suspend and ban reason is forwarded.
- **`ConfirmProvider`:** `showModal` in an effect, focus by tone or reason, `cancel` → `false`, and a second call resolves the first `false` while keeping the original return-focus target. Confirm is disabled until the reason meets `minLength`. The learner refund's 5-character minimum matches the DTO.
- **API:**
  - `leave` is one conditional update scoped to `user_id` and `active|suspended`, so the 404 is the same for "not yours" and "not leavable", and it's audited. The route uses `@UuidParam`.
  - The user search escapes `\ % _`, caps `q` at 100, ignores an array `q`, and keeps the role filter on both OR branches.
  - `listPending` adds amount and title with one `In()` query.
  - No migration.
- **Pagination and tabs:**
  - the Users key includes term and page, the page resets on search, and `keepPreviousData` is used;
  - `?tab=` is read inside `Suspense` and an unknown value falls back;
  - the Coupons tab is `enabled: ready && !isAdmin`;
  - the own row hides Suspend and Ban.
- **The planner's rulings are sound:**
  - `aria-disabled` plus a busy guard keeps focus;
  - the wallet picker searching all roles fits the model: a wallet is keyed by `user_id` with no role restriction;
  - the refund reason's 500 cap is within the DTO's 1000;
  - `holdReasonLabel` is needed for the release dialog.
- **Not over-engineered:** every new piece traces back to a decision (`useConfirm`, `SearchPicker`, `Pager`, `EmptyRows`, `useDebouncedValue`), and there are no new dependencies.

### Blockers
None.

### Should-fix
None.

### Nits (optional)
- **N1. The admin coupon form keeps the course picker after a create** (`coupon-manager.tsx`, the create success path). The next coupon is scoped to the same course unless the admin clears the chip. Clear `adminCourse`, and `course_id` in the form, on success.
- **N2. The admin's own row shows Suspend and Ban until `me` loads** (`page.tsx`, `isMe`). The API refuses anyway. Hide the row actions until `me` is set.
- **N3. `SearchPicker` moves focus whenever `selected` changes, including when the parent resets it after a success** (the bank transfer and the wallet). Focus then jumps to the learner input, away from the button the admin just used. The `FormStatus` live region still announces the outcome, so only the focus jump is the nit. Move focus only from the picker's own pick and clear handlers.
