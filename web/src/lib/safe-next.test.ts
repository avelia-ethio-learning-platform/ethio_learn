import { describe, expect, it } from 'vitest';
import { roleHome, safeNext } from './safe-next';

describe('safeNext', () => {
  it.each(['/teach', '/courses/c1?tab=reviews', '/pay/abc#top', '/'])('follows the same-origin path %s', (next) => {
    expect(safeNext(next, '/dashboard')).toBe(next);
  });

  it.each([
    ['protocol-relative', '//evil.com'],
    ['backslash host', '/\\evil.com'],
    ['backslash later', '/foo\\..\\..\\evil.com'],
    ['absolute', 'https://evil.com'],
    ['javascript', 'javascript:alert(1)'],
    ['tab', '/\t/evil.com'],
    ['newline', '/\n/evil.com'],
    ['null byte', '/teach\u0000'],
    ['relative without slash', 'teach'],
    ['empty', ''],
    // The parser resolves dot segments, so each of these normalises to //evil.com.
    ['dot segment', '/.//evil.com'],
    ['dot-dot after a segment', '/a/..//evil.com'],
    ['leading dot-dot', '/..//evil.com'],
    ['encoded dot', '/%2e//evil.com'],
    ['encoded dot-dot', '/%2e%2e//evil.com'],
  ])('falls back on %s', (_case, next) => {
    expect(safeNext(next, '/dashboard')).toBe('/dashboard');
  });

  it('falls back when there is no next', () => {
    expect(safeNext(null, '/qa')).toBe('/qa');
    expect(safeNext(undefined, '/qa')).toBe('/qa');
  });

  it('keeps encoded slashes as a path on this site', () => {
    const out = safeNext('/%2F%2Fevil.com', '/dashboard');
    expect(out).toBe('/%2F%2Fevil.com');
    expect(new URL(out, 'https://ethiopialearn.et').origin).toBe('https://ethiopialearn.et');
  });
});

describe('roleHome', () => {
  it.each([
    ['learner', '/dashboard'],
    ['quality_officer', '/qa'],
    ['platform_admin', '/admin'],
    ['educator', '/teach'],
    ['institution_admin', '/teach'],
  ])('%s → %s', (role, home) => {
    expect(roleHome(role)).toBe(home);
  });
});
