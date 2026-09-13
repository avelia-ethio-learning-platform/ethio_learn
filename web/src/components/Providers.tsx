'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { I18nProvider } from '@/lib/i18n';
import { ThemeProvider } from './ThemeProvider';

/** Registers the offline service worker (production only) and clears its personal cache on logout. */
function useServiceWorker() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    const onAuth = () => {
      // Logged out → forget cached API responses so the next user on this device sees nothing of ours.
      if (!localStorage.getItem('el_auth')) navigator.serviceWorker.controller?.postMessage('el-clear-api-cache');
    };
    window.addEventListener('el-auth-changed', onAuth);
    return () => window.removeEventListener('el-auth-changed', onAuth);
  }, []);
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } }));
  useServiceWorker();
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <I18nProvider>{children}</I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
