'use client';

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

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (!res.ok) return false;
    const body = await res.json();
    setAuth({ access_token: body.access_token, user: body.user });
    return true;
  } catch {
    return false;
  }
}

export async function api<T = any>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, auth = true } = options;
  const doFetch = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = auth ? getAuth()?.access_token : undefined;
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${API_URL}/api/v1${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let res = await doFetch();
  if (res.status === 401 && auth && getAuth()) {
    // Access token expired (15 min TTL) — try the refresh cookie once.
    if (await tryRefresh()) res = await doFetch();
    else setAuth(null);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const errBody = await res.json();
      message = Array.isArray(errBody.message) ? errBody.message.join(', ') : (errBody.message ?? message);
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
