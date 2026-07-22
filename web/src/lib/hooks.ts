'use client';

import { useEffect, useState } from 'react';
import { AuthUser, getAuth } from './api';

/** Reactive auth state (updates on login/logout across the app). */
export function useAuth(): { user: AuthUser | null; ready: boolean } {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => setUser(getAuth()?.user ?? null);
    sync();
    setReady(true);
    window.addEventListener('el-auth-changed', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('el-auth-changed', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return { user, ready };
}
