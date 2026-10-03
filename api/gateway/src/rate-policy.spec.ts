import { classifyRequest } from './rate-policy';

describe('rate-limit policy classification', () => {
  it('puts credential endpoints in the strict brute-force bucket', () => {
    expect(classifyRequest('POST', '/api/v1/auth/login')).toBe('auth-strict');
    expect(classifyRequest('POST', '/api/v1/auth/signup')).toBe('auth-strict');
    expect(classifyRequest('POST', '/api/v1/auth/reset-password')).toBe('auth-strict');
    expect(classifyRequest('POST', '/api/v1/auth/reset-password/confirm')).toBe('auth-strict');
    expect(classifyRequest('POST', '/api/v1/auth/verify-email')).toBe('auth-strict');
    expect(classifyRequest('POST', '/api/v1/auth/accept-invite')).toBe('auth-strict');
  });

  it('puts resend-verification in the strict bucket: it sends email, so it is capped per IP', () => {
    expect(classifyRequest('POST', '/api/v1/auth/resend-verification')).toBe('auth-strict');
    expect(classifyRequest('POST', '/api/v1/auth/Resend-Verification/')).toBe('auth-strict');
  });

  it('puts the two profile routes that check the password in the strict bucket', () => {
    expect(classifyRequest('PUT', '/api/v1/profiles/password')).toBe('auth-strict');
    expect(classifyRequest('DELETE', '/api/v1/profiles/me')).toBe('auth-strict');
    expect(classifyRequest('PUT', '/api/v1/PROFILES/password/')).toBe('auth-strict');
    // Reading or editing the profile is an ordinary request.
    expect(classifyRequest('GET', '/api/v1/profiles/me')).toBe('general');
    expect(classifyRequest('PUT', '/api/v1/profiles/me')).toBe('write');
  });

  it('keeps token refresh out of the strict bucket (fires every 15 min legitimately)', () => {
    expect(classifyRequest('POST', '/api/v1/auth/refresh')).toBe('auth');
    expect(classifyRequest('POST', '/api/v1/auth/logout')).toBe('auth');
  });

  it('throttles LLM-backed endpoints hardest', () => {
    expect(classifyRequest('POST', '/api/v1/courses/generate-structure')).toBe('ai');
  });

  it('gives comments and DMs the spam bucket', () => {
    expect(classifyRequest('POST', '/api/v1/courses/c1/comments')).toBe('community-write');
    expect(classifyRequest('POST', '/api/v1/messages/threads')).toBe('community-write');
    expect(classifyRequest('POST', '/api/v1/messages/threads/t1')).toBe('community-write');
    expect(classifyRequest('POST', '/api/v1/comments/c1/replies')).toBe('community-write');
  });

  it('puts institution instructor invitations in the spam bucket (they send email)', () => {
    expect(classifyRequest('POST', '/api/v1/institutions/i1/instructors')).toBe('community-write');
    // Status changes and the list are not invitations.
    expect(classifyRequest('POST', '/api/v1/institutions/i1/instructors/m1/status')).toBe('write');
    expect(classifyRequest('GET', '/api/v1/institutions/i1/instructors')).toBe('general');
  });

  it('puts the public support form in the spam bucket', () => {
    expect(classifyRequest('POST', '/api/v1/support/contact')).toBe('community-write');
  });

  it('puts the coupon check in the spam bucket, so codes cannot be enumerated', () => {
    expect(classifyRequest('GET', '/api/v1/coupons/validate')).toBe('community-write');
    expect(classifyRequest('GET', '/api/v1/COUPONS/validate/')).toBe('community-write');
    // Managing coupons is not the check.
    expect(classifyRequest('GET', '/api/v1/coupons')).toBe('general');
    expect(classifyRequest('POST', '/api/v1/coupons')).toBe('write');
  });

  it('limits payment initiation separately', () => {
    expect(classifyRequest('POST', '/api/v1/payments/initiate')).toBe('payment-initiate');
  });

  it('never puts the Chapa webhook in a strict bucket (legit retries must land)', () => {
    expect(classifyRequest('POST', '/api/v1/payments/webhook/chapa')).toBe('general');
  });

  it('classifies other mutations as generic writes and reads as general', () => {
    expect(classifyRequest('POST', '/api/v1/enrollments')).toBe('write');
    expect(classifyRequest('DELETE', '/api/v1/lessons/l1')).toBe('write');
    expect(classifyRequest('POST', '/api/v1/progress/lessons/l1/video')).toBe('write');
    expect(classifyRequest('GET', '/api/v1/courses/c1')).toBe('general');
    expect(classifyRequest('GET', '/api/v1/messages/threads')).toBe('general');
  });
});
