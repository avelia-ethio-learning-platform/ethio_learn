import { resolveRoute } from './routes';

/** Resolves a path and returns [matched, authMode] for compact assertions. */
function modeOf(method: string, path: string): string | undefined {
  const rule = resolveRoute(path);
  if (!rule) return undefined;
  return typeof rule.auth === 'function' ? rule.auth(method, path) : rule.auth;
}

describe('gateway route table', () => {
  it('rejects unknown paths (scope discipline)', () => {
    expect(resolveRoute('/api/v1/definitely-not-a-route')).toBeUndefined();
    expect(resolveRoute('/api/v1/admin')).toBeUndefined();
  });

  it('guards internal endpoints with the shared token, never JWT', () => {
    expect(modeOf('GET', '/api/v1/internal/users/abc')).toBe('internal');
    expect(modeOf('GET', '/api/v1/internal/courses/abc/lesson-ids')).toBe('internal');
    expect(modeOf('GET', '/api/v1/internal/entitlements')).toBe('internal');
    expect(modeOf('GET', '/api/v1/internal/enrollments/e1/outcomes-status')).toBe('internal');
    expect(modeOf('GET', '/api/v1/internal/educators/e1/trust-tier')).toBe('internal');
  });

  it('keeps the payment webhook public (HMAC-guarded downstream)', () => {
    expect(modeOf('POST', '/api/v1/payments/webhook/chapa')).toBe('public');
  });

  it('requires JWT for payments, refunds and payouts', () => {
    expect(modeOf('POST', '/api/v1/payments/initiate')).toBe('jwt');
    expect(modeOf('POST', '/api/v1/refunds')).toBe('jwt');
    expect(modeOf('GET', '/api/v1/payouts/balance')).toBe('jwt');
  });

  it('makes course detail public but authoring JWT-only', () => {
    expect(modeOf('GET', '/api/v1/courses/some-id')).toBe('public');
    expect(modeOf('POST', '/api/v1/courses')).toBe('jwt');
    expect(modeOf('GET', '/api/v1/courses')).toBe('jwt'); // list own courses
    expect(modeOf('POST', '/api/v1/courses/some-id/submit')).toBe('jwt');
  });

  it('lets anyone read comments/reviews but only JWT holders write', () => {
    expect(modeOf('GET', '/api/v1/courses/c1/comments')).toBe('public');
    expect(modeOf('POST', '/api/v1/courses/c1/comments')).toBe('jwt');
    expect(modeOf('GET', '/api/v1/courses/c1/reviews')).toBe('public');
    expect(modeOf('POST', '/api/v1/courses/c1/reviews')).toBe('jwt');
  });

  it('protects enrollment/progress (incl. video progress) with JWT', () => {
    expect(modeOf('POST', '/api/v1/enrollments')).toBe('jwt');
    expect(modeOf('POST', '/api/v1/progress/lessons/l1/complete')).toBe('jwt');
    expect(modeOf('POST', '/api/v1/progress/lessons/l1/video')).toBe('jwt');
    expect(modeOf('GET', '/api/v1/enrollments/e1/video-progress')).toBe('jwt');
  });

  it('exposes certificate verification publicly', () => {
    expect(modeOf('GET', '/api/v1/verify/some-uid')).toBe('public');
    expect(modeOf('GET', '/api/v1/certificates/some-uid')).toBe('public');
  });

  it('keeps DMs JWT-only in both directions', () => {
    expect(modeOf('GET', '/api/v1/messages/threads')).toBe('jwt');
    expect(modeOf('POST', '/api/v1/messages/threads')).toBe('jwt');
  });
});
