import { Response } from 'express';
import { serialize } from 'cookie';

export const REFRESH_COOKIE = 'el_refresh';

const sameSiteFromEnv = () => (process.env.COOKIE_SAMESITE ?? 'lax').toLowerCase() as 'lax' | 'none' | 'strict';

/**
 * Set the refresh cookie. Shared by every endpoint that hands out a session
 * (login, refresh, password change) so the attributes cannot drift.
 *
 * The browser reaches /api/v1/auth/* through the web's own route handlers
 * (Phase 11b), so the cookie binds to the web host and is first-party: Lax
 * (the default, and COOKIE_SAMESITE=lax on Render) is enough. `none` is only
 * for a web that calls the API cross-site; it forces Secure, since browsers
 * honour SameSite=None only over HTTPS.
 */
export function setRefreshCookie(res: Response, token: string, maxAgeSeconds: number) {
  const sameSite = sameSiteFromEnv();
  res.setHeader(
    'Set-Cookie',
    serialize(REFRESH_COOKIE, token, {
      httpOnly: true, // spec §0.3: refresh token lives in an httpOnly cookie
      sameSite,
      secure: sameSite === 'none' || process.env.NODE_ENV === 'production',
      path: '/api/v1/auth',
      maxAge: maxAgeSeconds,
    }),
  );
}

/** Expire the refresh cookie with the same attributes it was set with. */
export function clearRefreshCookie(res: Response) {
  const sameSite = sameSiteFromEnv();
  res.setHeader(
    'Set-Cookie',
    serialize(REFRESH_COOKIE, '', {
      httpOnly: true,
      sameSite,
      secure: sameSite === 'none' || process.env.NODE_ENV === 'production',
      path: '/api/v1/auth',
      maxAge: 0,
    }),
  );
}
