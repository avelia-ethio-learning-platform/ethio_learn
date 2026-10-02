import { assertBaselineRevertAllowed, baselineState } from './baseline';

const TABLES = ['users', 'audit_log', 'institutions'];

// The query runner returns the subset of TABLES that exists in the schema.
const runnerWith = (existing: string[]) => ({ query: jest.fn().mockResolvedValue(existing.map((relname) => ({ relname }))) });

describe('baselineState', () => {
  it('is "empty" when none of the baseline tables exist, so the baseline builds the schema', async () => {
    const runner = runnerWith([]);
    await expect(baselineState(runner, 'auth', TABLES)).resolves.toBe('empty');
    expect(runner.query).toHaveBeenCalledWith(expect.stringContaining('pg_catalog.pg_class'), ['auth', TABLES]);
  });

  it('is "present" when every baseline table exists, so the baseline records itself without DDL', async () => {
    await expect(baselineState(runnerWith([...TABLES]), 'auth', TABLES)).resolves.toBe('present');
  });

  it('throws on a partially built schema and names the missing tables', async () => {
    await expect(baselineState(runnerWith(['users']), 'auth', TABLES)).rejects.toThrow(
      /Schema "auth" is partially built: 1 of 3 .*missing: audit_log, institutions/,
    );
  });
});

describe('assertBaselineRevertAllowed', () => {
  const original = process.env.ALLOW_BASELINE_REVERT;
  afterEach(() => {
    if (original === undefined) delete process.env.ALLOW_BASELINE_REVERT;
    else process.env.ALLOW_BASELINE_REVERT = original;
  });

  it('refuses without ALLOW_BASELINE_REVERT=1', () => {
    delete process.env.ALLOW_BASELINE_REVERT;
    expect(() => assertBaselineRevertAllowed('auth')).toThrow(/Refusing to revert the "auth" baseline/);
    process.env.ALLOW_BASELINE_REVERT = 'true';
    expect(() => assertBaselineRevertAllowed('auth')).toThrow(/Refusing/);
  });

  it('allows the revert with ALLOW_BASELINE_REVERT=1', () => {
    process.env.ALLOW_BASELINE_REVERT = '1';
    expect(() => assertBaselineRevertAllowed('auth')).not.toThrow();
  });
});
