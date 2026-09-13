import { classifyRequest } from './rate-policy';
import { resolveRoute } from './routes';

describe('rate policy: growth & commerce endpoints', () => {
  it('everything that opens a checkout shares the payment-initiate bucket', () => {
    expect(classifyRequest('POST', '/api/v1/payments/initiate')).toBe('payment-initiate');
    expect(classifyRequest('POST', '/api/v1/wallet/topup')).toBe('payment-initiate');
    expect(classifyRequest('POST', '/api/v1/gifts')).toBe('payment-initiate');
    expect(classifyRequest('POST', '/api/v1/bulk-purchases')).toBe('payment-initiate');
    expect(classifyRequest('POST', '/api/v1/pay-requests/abc123/pay')).toBe('payment-initiate');
  });

  it('email-sending endpoints are throttled like community writes (spam vector)', () => {
    expect(classifyRequest('POST', '/api/v1/referrals/invite')).toBe('community-write');
    expect(classifyRequest('POST', '/api/v1/pay-requests')).toBe('community-write');
    expect(classifyRequest('POST', '/api/v1/bulk-purchases/x/assign')).toBe('community-write');
  });

  it('the course tutor is an AI endpoint', () => {
    expect(classifyRequest('POST', '/api/v1/courses/c1/chat')).toBe('ai');
    expect(classifyRequest('GET', '/api/v1/courses/c1/chat')).toBe('general');
  });
});

describe('routes: growth, change log and tutor', () => {
  it('pay-request landing is public on GET but paying needs a JWT', () => {
    const rule = resolveRoute('/api/v1/pay-requests/TOKEN123')!;
    expect(typeof rule.auth).toBe('function');
    expect((rule.auth as (m: string, p: string) => string)('GET', '/api/v1/pay-requests/TOKEN123')).toBe('public');
    expect(resolveRoute('/api/v1/pay-requests/TOKEN123/pay')!.auth).toBe('jwt');
    expect(resolveRoute('/api/v1/pay-requests')!.auth).toBe('jwt');
  });

  it('change log reads are public, writes need a JWT, tutor always needs a JWT', () => {
    const cl = resolveRoute('/api/v1/courses/c1/changelog')!;
    expect((cl.auth as (m: string, p: string) => string)('GET', '')).toBe('public');
    expect((cl.auth as (m: string, p: string) => string)('POST', '')).toBe('jwt');
    expect(resolveRoute('/api/v1/courses/c1/chat')!.auth).toBe('jwt');
    expect(resolveRoute('/api/v1/courses/c1/knowledge/reindex')!.auth).toBe('jwt');
  });

  it('internal learner list goes to enrollment, not course', () => {
    process.env.ENROLLMENT_SERVICE_URL = 'enroll:1';
    process.env.COURSE_SERVICE_URL = 'course:1';
    expect(resolveRoute('/api/v1/internal/courses/c1/learners')!.target()).toContain('enroll:1');
    expect(resolveRoute('/api/v1/internal/courses/c1')!.target()).toContain('course:1');
    delete process.env.ENROLLMENT_SERVICE_URL;
    delete process.env.COURSE_SERVICE_URL;
  });

  it('wallet, coupons, referrals, sponsorships and bulk purchases route to financial', () => {
    process.env.FINANCIAL_SERVICE_URL = 'fin:1';
    for (const p of ['/api/v1/wallet', '/api/v1/coupons/validate', '/api/v1/referrals/me', '/api/v1/sponsorships/mine', '/api/v1/bulk-purchases/quote', '/api/v1/admin/analytics/financial']) {
      expect(resolveRoute(p)!.target()).toContain('fin:1');
      expect(resolveRoute(p)!.auth).toBe('jwt');
    }
    delete process.env.FINANCIAL_SERVICE_URL;
  });
});
