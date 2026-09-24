import { classifyRequest } from './rate-policy';
import { matchPath } from './request-path';
import { authModeFor, resolveRoute } from './routes';

/**
 * Upstream Express routing ignores case and one trailing slash, so each of
 * these reaches the same handler as its canonical path and must get the same
 * route, auth mode and rate bucket.
 */
const variants = (canonical: string): string[] => {
  const upper = canonical.replace(/\/([a-z-]+)$/, (_, seg: string) => `/${seg.toUpperCase()}`);
  return [
    `${canonical}/`,
    `${canonical}//`,
    upper,
    `${upper}/`,
    canonical.replace('/api/v1/', '/api/v1//'),
    canonical.toUpperCase(),
  ];
};

describe('matchPath', () => {
  it('lowercases, collapses repeated slashes and drops trailing slashes', () => {
    expect(matchPath('/API/v1/Courses/Generate-Structure/')).toBe('/api/v1/courses/generate-structure');
    expect(matchPath('/api/v1//auth///login//')).toBe('/api/v1/auth/login');
    expect(matchPath('/api/v1/auth/login')).toBe('/api/v1/auth/login');
  });

  it('keeps the root path', () => {
    expect(matchPath('/')).toBe('/');
    expect(matchPath('//')).toBe('/');
    expect(matchPath('')).toBe('/');
  });
});

describe('rate-limit buckets for path variants', () => {
  it.each([
    ['/api/v1/auth/login', 'auth-strict'],
    ['/api/v1/auth/signup', 'auth-strict'],
    ['/api/v1/auth/reset-password/confirm', 'auth-strict'],
    ['/api/v1/courses/generate-structure', 'ai'],
    ['/api/v1/assessments/generate', 'ai'],
    ['/api/v1/courses/c1/chat', 'ai'],
    ['/api/v1/payments/initiate', 'payment-initiate'],
    ['/api/v1/courses/c1/comments', 'community-write'],
    ['/api/v1/support/contact', 'community-write'],
  ])('POST %s keeps the %s bucket with a trailing slash, repeated slashes or other case', (canonical, bucket) => {
    expect(classifyRequest('POST', canonical)).toBe(bucket);
    for (const path of variants(canonical)) expect([path, classifyRequest('POST', path)]).toEqual([path, bucket]);
  });

  it('keeps the LLM-backed study-plan GET in the ai bucket for variants', () => {
    for (const path of ['/api/v1/attempts/a1/study-plan/', '/api/v1/attempts/a1/Study-Plan', '/API/V1/ATTEMPTS/A1/STUDY-PLAN']) {
      expect(classifyRequest('GET', path)).toBe('ai');
    }
  });

  it('still leaves the Chapa webhook on the general bucket', () => {
    expect(classifyRequest('POST', '/api/v1/payments/webhook/chapa/')).toBe('general');
  });
});

describe('route table for path variants', () => {
  const route = (method: string, path: string) => {
    const rule = resolveRoute(path);
    return rule ? [rule.target(), authModeFor(rule, method, path)] : undefined;
  };

  it('sends a trailing-slash path to the same service with the same auth as the canonical path', () => {
    // Without normalising, '/reviews/' fell through to the generic /courses rule (course service, JWT).
    expect(route('GET', '/api/v1/courses/c1/reviews/')).toEqual(route('GET', '/api/v1/courses/c1/reviews'));
    expect(route('POST', '/api/v1/courses/c1/comments/')).toEqual(route('POST', '/api/v1/courses/c1/comments'));
    expect(route('GET', '/api/v1/courses/c1/')).toEqual(route('GET', '/api/v1/courses/c1'));
    expect(route('GET', '/api/v1/courses/c1/')?.[1]).toBe('public');
  });

  it('resolves upper-case variants like the canonical path', () => {
    expect(route('POST', '/api/v1/Auth/Login')).toEqual(route('POST', '/api/v1/auth/login'));
    expect(route('GET', '/api/v1/Courses/c1/Reviews')).toEqual(route('GET', '/api/v1/courses/c1/reviews'));
    expect(route('GET', '/api/v1/Internal/Users/u1')?.[1]).toBe('internal');
  });

  it('still rejects unknown paths', () => {
    expect(resolveRoute('/api/v1/definitely-not-a-route/')).toBeUndefined();
    expect(resolveRoute('/API/V1/ADMIN')).toBeUndefined();
  });
});
