'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, MotionConfig } from 'framer-motion';
import { useEffect, useState } from 'react';
import { I18nProvider } from '@/lib/i18n';
import { makeQueryClient } from '@/lib/query-client';
import { ConfirmProvider } from './confirm/ConfirmProvider';
import { ThemeProvider } from './ThemeProvider';
import { SkipLink } from './SkipLink';
import { WakingUpNotice } from './WakingUpNotice';

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

/** Animation features, fetched after the first load. */
const loadMotionFeatures = () => import('./motion-features').then((mod) => mod.default);

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(makeQueryClient);
  useServiceWorker();
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <I18nProvider>
          {/* `m.*` components only: `strict` makes a stray `motion.*` throw in development. */}
          <LazyMotion features={loadMotionFeatures} strict>
            <MotionConfig reducedMotion="user">
              <SkipLink />
              <ConfirmProvider>{children}</ConfirmProvider>
              <WakingUpNotice />
            </MotionConfig>
          </LazyMotion>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
