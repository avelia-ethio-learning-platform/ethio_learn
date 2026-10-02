import { Response } from 'express';
import { serialize } from 'cookie';

export const REFRESH_COOKIE = 'el_refresh';

const sameSiteFromEnv = () => (process.env.COOKIE_SAMESITE ?? 'lax').toLowerCase() as 'lax' | 'none' | 'strict';

/**
 * Set the refresh cookie. Shared by every endpoint that hands out a session
 * (login, refresh, password change) so the attributes cannot drift.
 *
 * When the web app and the API sit on different registrable domains — the
 * Vercel + Render split, say — the refresh call is cross-site and a Lax
 * cookie is never sent, silently logging everyone out at the 15-minute
 * access-token expiry. Set COOKIE_SAMESITE=none there; browsers only honour
 * SameSite=None over HTTPS, so it forces Secure regardless of NODE_ENV.
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
