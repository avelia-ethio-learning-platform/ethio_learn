import { timingSafeEqual } from 'crypto';
import { resolveRoute } from './routes';
import { matchesSecret, validJobsToken } from './secrets';

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});

describe('gateway jobs auth (JOBS_TOKEN)', () => {
  const OLD = process.env.JOBS_TOKEN;
  afterEach(() => {
    if (OLD === undefined) delete process.env.JOBS_TOKEN;
    else process.env.JOBS_TOKEN = OLD;
  });

  it('routes only the job paths of financial and enrollment to the jobs mode', () => {
    for (const path of ['/api/v1/jobs/financial', '/api/v1/jobs/financial/sweep', '/api/v1/jobs/enrollment/inactivity']) {
      expect(resolveRoute(path)?.auth).toBe('jobs');
    }
    expect(resolveRoute('/api/v1/jobs/auth/sweep')).toBeUndefined();
    expect(resolveRoute('/api/v1/jobs/financial/sweep/extra')).toBeUndefined();
  });

  it('accepts the right bearer token only', () => {
    process.env.JOBS_TOKEN = 'jobs-secret-0123456789';
    expect(validJobsToken('Bearer jobs-secret-0123456789')).toBe(true);
    expect(validJobsToken(undefined)).toBe(false);
    expect(validJobsToken('jobs-secret-0123456789')).toBe(false);
    expect(validJobsToken('Bearer jobs-secret-0123456780')).toBe(false);
    expect(validJobsToken('Bearer short')).toBe(false);
  });

  it('a non-ASCII token of the right character count is refused, not thrown (byte lengths)', () => {
    process.env.JOBS_TOKEN = 'jobs-secret-0123456789';
    expect(() => validJobsToken('Bearer jobs-secret-012345678é')).not.toThrow();
    expect(validJobsToken('Bearer jobs-secret-012345678é')).toBe(false);
    expect(matchesSecret('ééé', 'abc')).toBe(false);
  });

  it('refuses everything when JOBS_TOKEN is unset', () => {
    delete process.env.JOBS_TOKEN;
    expect(validJobsToken('Bearer ')).toBe(false);
    expect(validJobsToken('Bearer anything')).toBe(false);
  });

  it('compares with timingSafeEqual', () => {
    expect(matchesSecret('abc', 'abc')).toBe(true);
    expect(timingSafeEqual).toHaveBeenCalled();
  });
});
