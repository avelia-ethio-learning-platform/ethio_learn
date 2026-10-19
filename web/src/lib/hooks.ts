'use client';

import { useSyncExternalStore } from 'react';
import { AuthSnapshot, authSnapshot, serverAuthSnapshot, subscribeAuth } from './auth-store';

/**
 * Reactive auth state, across the app and across tabs. `user` comes from the
 * session hint at once; `ready` turns true once the boot refresh settles
 * (Providers runs it), or at once for an anonymous visitor.
 */
export function useAuth(): AuthSnapshot {
  return useSyncExternalStore(subscribeAuth, authSnapshot, serverAuthSnapshot);
}
