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

  it('puts the public support form in the spam bucket', () => {
    expect(classifyRequest('POST', '/api/v1/support/contact')).toBe('community-write');
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
