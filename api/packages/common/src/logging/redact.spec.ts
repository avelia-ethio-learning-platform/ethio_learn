import { maskEmail, redactEmails, redactPath } from './redact';

describe('redactPath', () => {
  const hex64 = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';

  it.each([
    ['an invite token', `/api/v1/auth/invite/${hex64}`, '/api/v1/auth/invite/[token]'],
    ['a pay-request token, which is not hex', '/api/v1/pay-requests/Xk3pQ9mZ2vB7nL4wR8tY6uA1/pay', '/api/v1/pay-requests/[token]/pay'],
    ['a public pay-request page', '/api/v1/pay-requests/Xk3pQ9mZ2vB7nL4wR8tY6uA1', '/api/v1/pay-requests/[token]'],
    ['a token parent in another case', '/api/v1/Auth/INVITE/abc', '/api/v1/Auth/INVITE/[token]'],
    ['an encoded address', '/api/v1/internal/users/by-email/name%40example.com', '/api/v1/internal/users/by-email/[email]'],
    ['a raw address', '/api/v1/internal/users/by-email/name@example.com', '/api/v1/internal/users/by-email/[email]'],
    ['a bare 40-hex segment', `/api/v1/things/${'f'.repeat(40)}`, '/api/v1/things/[token]'],
    ['a malformed escape, without throwing', '/api/v1/courses/%E0%A4%A', '/api/v1/courses/[token]'],
  ])('redacts %s', (_label, path, expected) => {
    expect(redactPath(path)).toBe(expected);
  });

  it.each([
    ['a UUID', '/api/v1/courses/0b6f3c1e-5d2a-4f8e-9c71-2a4d6e8f0b13/lessons'],
    ['a course slug', '/api/v1/courses/by-slug/intro-to-amharic-101'],
    ['a short hex value', '/api/v1/things/deadbeef'],
    ['the root and a trailing slash', '/api/v1/courses/'],
  ])('keeps %s', (_label, path) => {
    expect(redactPath(path)).toBe(path);
  });

  it('drops the query string and the fragment', () => {
    expect(redactPath('/api/v1/auth/reset?token=abc&email=a@b.co')).toBe('/api/v1/auth/reset');
    expect(redactPath('/api/v1/courses#x')).toBe('/api/v1/courses');
  });
});

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('abebe@example.com')).toBe('a***@example.com');
  });

  it.each([[''], [null], [undefined], ['no-at-sign'], ['@example.com']])('masks %p completely', (value) => {
    expect(maskEmail(value)).toBe('***');
  });
});

describe('redactEmails', () => {
  it('replaces every address in free text, raw or percent-encoded', () => {
    expect(redactEmails('550 5.1.1 <a.b+c@mail.example.org>: Recipient address rejected; cc x%40y.io')).toBe(
      '550 5.1.1 <[email]>: Recipient address rejected; cc [email]',
    );
    expect(redactEmails('no address here')).toBe('no address here');
  });
});
