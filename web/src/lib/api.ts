'use client';

import { clearLocalAuth, getAuth, markAuthReady, setAuth } from './auth-store';
import { isHibernation } from './hibernation';
import { wakeServices } from './wake';
import { trackRequest } from './waking';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type { AuthState, AuthUser, Session } from './auth-store';
export { getAuth, setAuth } from './auth-store';

/**
 * The cookie routes go to the web's own origin (route handlers forward them to
 * the gateway), so the refresh cookie is first-party there. Everything else goes
 * straight to the gateway with the bearer token and no cookies (Phase 11b).
 */
function sameOrigin(path: string): boolean {
  return path.startsWith('/auth/') || path.split('?')[0] === '/profiles/password';
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The parsed JSON error body, when the response had one. */
    public body?: unknown,
  ) {
    super(message);
  }
}

/**
 * The API, or a service behind it, is asleep (Render's hibernation 429) or
 * unreachable. The services have been asked to wake up; GET queries retry on
 * this (see `query-client.ts`), mutations show the message.
 */
export class WakingError extends Error {
  constructor() {
    super('The server is waking up. Try again in a minute.');
    this.name = 'WakingError';
  }
}

type RefreshOutcome = 'ok' | 'rejected' | 'waking';

let refreshInFlight: Promise<RefreshOutcome> | null = null;

/**
 * Refresh tokens are single-use, so every request that meets an expired access
 * token shares one refresh. Only a refresh the server rejects (401/403) ends the
 * session, once for all waiters.
 */
function refreshOnce(): Promise<RefreshOutcome> {
  refreshInFlight ??= lockedRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Tabs share one cookie, so refreshes are serialized across them with a Web
 * Lock, one attempt per acquisition (a waking retry takes it again). Inside the
 * lock, a token another tab delivered while this one waited is used as is.
 * Without Web Locks a race can sign one tab out; a reload fixes it.
 */
async function lockedRefresh(): Promise<RefreshOutcome> {
  const held = getAuth()?.access_token;
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return runRefresh();
  return await locks.request('el-auth-refresh', async (): Promise<RefreshOutcome> => {
    const current = getAuth()?.access_token;
    return current && current !== held ? 'ok' : runRefresh();
  });
}

async function runRefresh(): Promise<RefreshOutcome> {
  let res: Response;
  try {
    res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' });
  } catch {
    wakeServices();
    return 'waking';
  }
  if (res.ok) {
    const body = await res.json().catch(() => null);
    if (!body) {
      // Not auth's answer (a proxy or error page in front of it): try again later.
      wakeServices();
      return 'waking';
    }
    setAuth({ access_token: body.access_token, user: body.user });
    return 'ok';
  }
  if (res.status === 401 || res.status === 403) {
    clearLocalAuth(); // this tab only: with the lock, it means the session really ended
    return 'rejected';
  }
  const text = await res.text().catch(() => '');
  if (res.status === 429 && !isHibernation(res.status, res.headers, text)) {
    throw new ApiError(429, errorMessage(text, 429)); // the gateway's limiter: keep the session
  }
  // A hibernation 429, a 5xx, the route handler's 503: the call never reached auth, so the refresh token is still good.
  wakeServices();
  return 'waking';
}

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Phase 5's wake backoff (query-client.ts WAKING_RETRY_MS). */
export const BOOT_RETRY_MS = 10_000;

let booted = false;

/**
 * Page load (Providers): with the session hint, one refresh through the lock.
 * Asleep or rate-limited while online, it retries on the wake backoff and the
 * page stays "not ready" (the waking notice shows after 4 s). Offline, the
 * user stays signed in on cached pages and the refresh runs on `online`.
 */
export function bootAuth(): void {
  if (booted || typeof window === 'undefined') return;
  booted = true;
  if (!getAuth()) return; // no hint: anonymous, no call
  void bootRefresh();
}

async function bootRefresh(): Promise<void> {
  const settle = trackRequest();
  try {
    for (;;) {
      if (isOffline()) return signedInOffline();
      const outcome = await refreshOnce().catch((): RefreshOutcome => 'waking');
      if (outcome !== 'waking') return;
      if (isOffline()) return signedInOffline();
      await new Promise((resolve) => setTimeout(resolve, BOOT_RETRY_MS));
      const now = getAuth();
      if (!now || now.access_token) return; // another tab signed in or out meanwhile
    }
  } finally {
    settle();
  }
}

function signedInOffline() {
  markAuthReady();
  window.addEventListener('online', () => void refreshSession(), { once: true });
}

/** Tests: a fresh page load. */
export function resetBootForTests() {
  booted = false;
  refreshInFlight = null;
}

/**
 * Swap the refresh cookie for a new access token, re-reading the user (for
 * example after accepting an institution invitation changed the role).
 */
export async function refreshSession(): Promise<boolean> {
  try {
    return (await refreshOnce()) === 'ok';
  } catch {
    return false;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorMessage(text: string, status: number): string {
  try {
    const body = JSON.parse(text);
    if (Array.isArray(body.message)) return body.message.join(', ');
    if (typeof body.message === 'string') return body.message;
  } catch {
    /* non-JSON error */
  }
  return `Request failed (${status})`;
}

/**
 * Signs out: revokes the refresh token (best-effort; offline still signs out
 * here) and clears every tab. It holds the refresh lock, so a refresh in flight
 * in another tab finishes first instead of landing afterwards and broadcasting
 * a session that signs both tabs back in.
 */
export async function signOut(): Promise<void> {
  const run = async () => {
    try {
      await api('/auth/logout', { method: 'POST', auth: false });
    } catch {
      /* offline or already expired: still clear local state */
    }
    setAuth(null);
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) await locks.request('el-auth-refresh', run);
  else await run();
}

export async function api<T = any>(
  path: string,
  /** `slow`: a call that is slow by nature (AI generation, uploads); it never shows the "waking up" notice. */
  options: { method?: string; body?: unknown; auth?: boolean; slow?: boolean } = {},
): Promise<T> {
  const settle = options.slow ? undefined : trackRequest();
  try {
    return await request<T>(path, options);
  } finally {
    settle?.();
  }
}

async function request<T>(path: string, options: { method?: string; body?: unknown; auth?: boolean }): Promise<T> {
  const { method = 'GET', body, auth = true } = options;
  // Signed in by the hint but no token yet (a reload): wait for the boot refresh. Offline, the
  // call goes without one and the service worker answers from its cache.
  if (auth && getAuth() && !getAuth()?.access_token && !isOffline()) {
    if ((await refreshOnce().catch((): RefreshOutcome => 'waking')) === 'waking') throw new WakingError();
  }
  const base = sameOrigin(path) ? '' : API_URL;
  const send = async (): Promise<{ res: Response; token: string | undefined }> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = auth ? getAuth()?.access_token : undefined;
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch(`${base}/api/v1${path}`, {
        method,
        headers,
        credentials: base ? 'omit' : 'same-origin',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { res, token };
    } catch (err) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw err; // offline, not asleep
      wakeServices();
      throw new WakingError();
    }
  };

  let { res, token } = await send();
  if (res.status === 401 && auth && getAuth()) {
    // Access token expired (15 min TTL). Another request may have refreshed already.
    if (getAuth()?.access_token !== token) res = (await send()).res;
    else {
      const outcome = await refreshOnce();
      if (outcome === 'ok') res = (await send()).res;
      else if (outcome === 'waking') throw new WakingError();
      // 'rejected': the session is over (already logged out); report this 401.
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (isHibernation(res.status, res.headers, text)) {
      wakeServices();
      throw new WakingError();
    }
    // A peer service the gateway reached is asleep: same recovery as a hibernating gateway.
    if (res.status === 503 && (parseJson(text) as { code?: unknown } | undefined)?.code === 'service_waking') {
      wakeServices();
      throw new WakingError();
    }
    throw new ApiError(res.status, errorMessage(text, res.status), parseJson(text));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
