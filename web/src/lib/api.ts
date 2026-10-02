'use client';

import { isHibernation } from './hibernation';
import { wakeServices } from './wake';
import { trackRequest } from './waking';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'learner' | 'educator' | 'institution_admin' | 'quality_officer' | 'platform_admin';
  must_change_password?: boolean;
}

interface AuthState {
  access_token: string;
  user: AuthUser;
}

const STORAGE_KEY = 'el_auth';

export function getAuth(): AuthState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthState) : null;
  } catch {
    return null;
  }
}

export function setAuth(state: AuthState | null) {
  if (typeof window === 'undefined') return;
  if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  else localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event('el-auth-changed'));
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
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
  refreshInFlight ??= runRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function runRefresh(): Promise<RefreshOutcome> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include' });
  } catch {
    wakeServices();
    return 'waking';
  }
  if (res.ok) {
    const body = await res.json();
    setAuth({ access_token: body.access_token, user: body.user });
    return 'ok';
  }
  if (res.status === 401 || res.status === 403) {
    setAuth(null);
    return 'rejected';
  }
  const text = await res.text().catch(() => '');
  if (res.status === 429 && !isHibernation(res.status, res.headers, text)) {
    throw new ApiError(429, errorMessage(text, 429)); // the gateway's limiter: keep the session
  }
  // A hibernation 429, a 5xx: the call never reached auth, so the refresh token is still good.
  wakeServices();
  return 'waking';
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
  const send = async (): Promise<{ res: Response; token: string | undefined }> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = auth ? getAuth()?.access_token : undefined;
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch(`${API_URL}/api/v1${path}`, {
        method,
        headers,
        credentials: 'include',
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
    throw new ApiError(res.status, errorMessage(text, res.status));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
