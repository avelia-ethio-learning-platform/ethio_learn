/**
 * The form of a request path that the route table and the rate-limit policy
 * match against.
 *
 * The upstream services run Express with its default routing, which ignores
 * case and accepts a trailing slash, so '/api/v1/Auth/Login/' reaches the same
 * handler as '/api/v1/auth/login'. Matching the raw path let such a variant
 * fall through to a looser rule: the plain 'auth' or 'write' bucket instead of
 * 'auth-strict' or 'ai', or a different upstream service. This lowercases the
 * path, collapses repeated slashes and drops trailing slashes, so every variant
 * gets the rule of its canonical path.
 *
 * Only the copy used for matching is normalised. The request is forwarded
 * unchanged, because path parameters such as certificate ids can be
 * case-sensitive.
 *
 * Pass the path without its query string.
 */
export function matchPath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/');
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  return (trimmed || '/').toLowerCase();
}
