'use client';

/**
 * Who is signed in, in memory only (Phase 11b, P1-07). The access token never
 * touches storage: a script injected into the page can't walk away with a
 * session that outlives the tab. `localStorage.el_session` keeps a non-secret
 * hint, `{ user }`, so a reload knows to refresh (and anonymous visitors make
 * no auth call at all), and the header shows the user before that round trip.
 *
 * Tabs share sessions through a BroadcastChannel: `session` after a login or
 * refresh, `logout` after a logout. No network here; the refresh lives in api.ts.
 */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'learner' | 'educator' | 'institution_admin' | 'quality_officer' | 'platform_admin';
  must_change_password?: boolean;
}

/** A session from the server. */
export interface Session {
  access_token: string;
  user: AuthUser;
}

/** What this tab knows: no `access_token` while the hint's user waits for the boot refresh (or offline). */
export interface AuthState {
  access_token?: string;
  user: AuthUser;
}

export interface AuthSnapshot {
  user: AuthUser | null;
  /** False until the boot refresh settles; a protected page shows its skeleton, never the login link. */
  ready: boolean;
}

const HINT_KEY = 'el_session';
const LEGACY_KEY = 'el_auth'; // before 11b: the access token itself
const CHANNEL = 'el-auth';

type Message = { type: 'session'; access_token: string; user: AuthUser } | { type: 'logout' };

let started = false;
let state: AuthState | null = null;
let snapshot: AuthSnapshot = { user: null, ready: false };
const SERVER_SNAPSHOT: AuthSnapshot = { user: null, ready: false };
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function update(next: AuthState | null, ready: boolean) {
  state = next;
  snapshot = { user: next?.user ?? null, ready };
  listeners.forEach((listener) => listener());
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('el-auth-changed'));
}

function readHint(): AuthUser | null {
  try {
    const raw = localStorage.getItem(HINT_KEY);
    const user = raw ? (JSON.parse(raw) as { user?: AuthUser }).user : undefined;
    return user && typeof user.id === 'string' && typeof user.role === 'string' ? user : null;
  } catch {
    return null;
  }
}

function writeHint(user: AuthUser | null) {
  try {
    if (user) localStorage.setItem(HINT_KEY, JSON.stringify({ user }));
    else localStorage.removeItem(HINT_KEY);
  } catch {
    /* storage blocked: the session still works in this tab */
  }
}

/** First use in the browser: drop the old token, read the hint, listen to other tabs. */
function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* storage blocked */
  }
  const user = readHint();
  state = user ? { user } : null;
  // No hint: anonymous at once. With one: signed in as that user, ready once the boot refresh settles.
  snapshot = { user, ready: !user };
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<Message>) => {
      const msg = event.data;
      if (msg?.type === 'session') update({ access_token: msg.access_token, user: msg.user }, true);
      else if (msg?.type === 'logout') update(null, true);
    };
  }
}

export function getAuth(): AuthState | null {
  start();
  return state;
}

/** After a login, a refresh or a password change (a session), or a logout (null): this tab, the hint and every other tab. */
export function setAuth(next: Session | null) {
  if (typeof window === 'undefined') return;
  start();
  writeHint(next?.user ?? null);
  update(next ? { access_token: next.access_token, user: next.user } : null, true);
  channel?.postMessage(next ? ({ type: 'session', ...next } satisfies Message) : ({ type: 'logout' } satisfies Message));
}

/** A rejected refresh: the session is over, in this tab only (no broadcast). */
export function clearLocalAuth() {
  start();
  writeHint(null);
  update(null, true);
}

/** Offline boot: signed in as the hint's user, without a token, until the connection returns. */
export function markAuthReady() {
  start();
  if (!snapshot.ready) update(state, true);
}

export function subscribeAuth(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function authSnapshot(): AuthSnapshot {
  start();
  return snapshot;
}

export function serverAuthSnapshot(): AuthSnapshot {
  return SERVER_SNAPSHOT;
}

/** Tests: forget everything, as on a fresh page load. */
export function resetAuthForTests() {
  channel?.close();
  channel = null;
  started = false;
  state = null;
  snapshot = { user: null, ready: false };
}
