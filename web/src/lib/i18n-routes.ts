/**
 * The routes whose interface is translated into Amharic (Phase 10: a new
 * learner's path). In Amharic mode every other route shows LocaleNotice.
 */
const TRANSLATED = ['/login', '/signup', '/reset-password', '/verify-email', '/courses', '/payment/return', '/dashboard'];

/** True for the home page and for each translated route and the pages under it. */
export function isTranslatedRoute(pathname: string): boolean {
  return pathname === '/' || TRANSLATED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
