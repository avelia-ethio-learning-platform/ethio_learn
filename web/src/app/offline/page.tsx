import Link from 'next/link';
import { WifiOff } from 'lucide-react';
import { PageShell } from '@/components/PageChrome';

export const metadata = { title: 'You are offline' };

/** Shown by the service worker when a page is requested with no connectivity and no cached copy. */
export default function OfflinePage() {
  return (
    <PageShell>
      <div className="mx-auto max-w-md py-16 text-center">
        <span className="glass-secondary mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl">
          <WifiOff className="h-6 w-6 text-brand-500" />
        </span>
        <h1 className="text-2xl font-extrabold tracking-tight text-foreground">You&apos;re offline</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">
          Pages and courses you opened while online are still available. Any progress you make now is saved on this device and
          synced the moment you reconnect.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/dashboard" className="btn">
            My Learning
          </Link>
          <Link href="/courses" className="btn-secondary">
            Browse cached courses
          </Link>
        </div>
      </div>
    </PageShell>
  );
}
