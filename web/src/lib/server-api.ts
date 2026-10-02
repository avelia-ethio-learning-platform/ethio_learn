import { PHASE_PRODUCTION_BUILD } from 'next/constants';

/** Server-side fetch helper for SSR/ISR pages (public endpoints only). */
const SERVER_API_URL = process.env.GATEWAY_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** A free-tier cold start takes ~45 s; past this the page says so instead of hanging. */
export const SERVER_TIMEOUT_MS = 8000;

/**
 * What a page needs to tell apart: the data, a real "doesn't exist", or an API
 * that is asleep, down or too slow. Pages render `unavailable` themselves
 * (`<WakingUp />`) rather than throwing, because Next sanitizes Server
 * Component errors in production and `error.tsx` can't tell a cold start from
 * a bug.
 */
export type ServerResult<T> = { ok: true; data: T } | { ok: false; status: 404 } | { ok: false; status: 'unavailable' };

const UNAVAILABLE = { ok: false, status: 'unavailable' } as const;
const NOT_FOUND = { ok: false, status: 404 } as const;

export async function serverApi<T = any>(path: string, revalidateSeconds = 60): Promise<ServerResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_API_URL}/api/v1${path}`, {
      next: { revalidate: revalidateSeconds },
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    });
  } catch {
    return UNAVAILABLE; // network error or timeout
  }
  if (res.ok) {
    try {
      return { ok: true, data: (await res.json()) as T };
    } catch {
      return UNAVAILABLE; // the timeout can fire mid-body
    }
  }
  // Every 429 too: a sleeping Render service's, and the gateway limiter's, which
  // SSR trips on the server's shared IP bucket. Neither means "doesn't exist".
  if (res.status >= 500 || res.status === 429) return UNAVAILABLE;
  // 404, or a malformed id (400): the page treats it as not found, as before.
  return NOT_FOUND;
}

/**
 * For prerendered (ISR) pages. When the API answered, its data. When it
 * didn't: during `next build`, `empty` (so the build passes with no backend,
 * e.g. a Vercel build while Render sleeps); at runtime, a throw, which fails
 * the background revalidation so Next keeps serving the last good page.
 */
export function staticFallback<T>(result: ServerResult<T>, empty: T): { data: T; unavailable: boolean } {
  if (result.ok) return { data: result.data, unavailable: false };
  if (result.status === 404) return { data: empty, unavailable: false };
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return { data: empty, unavailable: true };
  throw new Error('API unavailable; keeping the last good page');
}

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
