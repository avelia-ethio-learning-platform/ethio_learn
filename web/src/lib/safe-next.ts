const HOMES: Record<string, { href: string; label: string }> = {
  learner: { href: '/dashboard', label: 'My learning' },
  educator: { href: '/teach', label: 'Educator dashboard' },
  institution_admin: { href: '/institution', label: 'Institution dashboard' },
  quality_officer: { href: '/qa', label: 'Review queue' },
  platform_admin: { href: '/admin', label: 'Admin' },
};

/** Where each role lands after signing in when there is no (safe) `next`: a page that role can use. */
export function roleHome(role: string | undefined): string {
  return (role && HOMES[role]?.href) || '/';
}

/** The name of `roleHome(role)`, for back links on pages several roles share. */
export function roleHomeLabel(role: string | undefined): string {
  return (role && HOMES[role]?.label) || 'Home';
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
