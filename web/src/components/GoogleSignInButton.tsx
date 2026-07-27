'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setAuth } from '@/lib/api';

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const GSI_SRC = 'https://accounts.google.com/gsi/client';

/** Minimal shape of the Google Identity Services global we use. */
interface GoogleId {
  accounts: {
    id: {
      initialize: (o: { client_id: string; callback: (r: { credential: string }) => void }) => void;
      renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
    };
  };
}
declare global {
  interface Window { google?: GoogleId }
}

function loadGsi(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('failed to load Google')));
      return;
    }
    const s = document.createElement('script');
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load Google'));
    document.head.appendChild(s);
  });
}

/**
 * "Sign in with Google" button. Renders nothing when
 * NEXT_PUBLIC_GOOGLE_CLIENT_ID is not configured, so the app works fine before
 * OAuth is set up. On success it stores the session and routes like a login.
 */
export function GoogleSignInButton({ next }: { next?: string | null }) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!CLIENT_ID || !ref.current) return;
    let cancelled = false;

    const onCredential = async (resp: { credential: string }) => {
      setError('');
      try {
        const res = await api<{ access_token: string; user: any }>('/auth/google', {
          method: 'POST',
          auth: false,
          body: { id_token: resp.credential },
        });
        setAuth({ access_token: res.access_token, user: res.user });
        if (res.user.must_change_password) router.push('/account/password?first=1');
        else if (next) router.push(next);
        else if (res.user.role === 'learner') router.push('/dashboard');
        else if (res.user.role === 'quality_officer') router.push('/qa');
        else if (res.user.role === 'platform_admin') router.push('/admin');
        else router.push('/teach');
      } catch (err) {
        setError((err as Error).message || 'Google sign-in failed');
      }
    };

    loadGsi()
      .then(() => {
        if (cancelled || !ref.current || !window.google) return;
        window.google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onCredential });
        window.google.accounts.id.renderButton(ref.current, {
          theme: 'outline',
          size: 'large',
          width: 320,
          text: 'continue_with',
          shape: 'pill',
          logo_alignment: 'center',
        });
      })
      .catch(() => setError('Could not load Google sign-in'));

    return () => { cancelled = true; };
  }, [next, router]);

  if (!CLIENT_ID) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-xs text-gray-400">
        <span className="h-px flex-1 bg-gray-200" /> or <span className="h-px flex-1 bg-gray-200" />
      </div>
      <div ref={ref} className="flex justify-center" />
      {error && <p className="text-center text-sm text-red-600">{error}</p>}
    </div>
  );
}
