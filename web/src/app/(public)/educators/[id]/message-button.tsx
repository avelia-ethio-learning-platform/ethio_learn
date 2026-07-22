'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/hooks';

/** "Message" CTA — only rendered for signed-in users who aren't this educator. */
export function MessageEducatorButton({ educatorId }: { educatorId: string }) {
  const { user, ready } = useAuth();
  if (!ready || !user || user.id === educatorId) return null;
  return (
    <Link href={`/messages?to=${educatorId}`} className="btn shrink-0">
      💬 Message
    </Link>
  );
}
