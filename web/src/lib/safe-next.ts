/** Where each role lands after signing in when there is no (safe) `next`. */
export function roleHome(role: string | undefined): string {
  if (role === 'learner') return '/dashboard';
  if (role === 'quality_officer') return '/qa';
  if (role === 'platform_admin') return '/admin';
  return '/teach';
}

const BASE = 'http://same-origin.invalid';

/**
 * The post-login `next` parameter, if it is a same-origin relative path
 * (`/teach`, `/courses/x?tab=1`); otherwise `fallback`. Rejects `//evil.com`,
 * `/\evil.com`, absolute and `javascript:` URLs, and control characters (the
 * URL parser drops tabs and newlines, so `/\t/evil.com` would become
 * `//evil.com`), and paths whose dot segments resolve to `//…` (`/.//evil.com`).
 * An open redirect after login is a phishing tool (P0-02).
 */
export function safeNext(next: string | null | undefined, fallback: string): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return fallback;
  // Backslashes are read as slashes by browsers; control characters are stripped.
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // The parser resolves dot segments, so "/.//evil.com" comes out as "//evil.com".
  return path.startsWith('//') ? fallback : path;
}
