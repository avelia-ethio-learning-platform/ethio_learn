'use client';

import Link from 'next/link';
import { MessageCircle } from 'lucide-react';
import { useAuth } from '@/lib/hooks';

/** "Message" CTA — only rendered for signed-in users who aren't this educator. */
export function MessageEducatorButton({ educatorId }: { educatorId: string }) {
  const { user, ready } = useAuth();
  if (!ready || !user || user.id === educatorId) return null;
  return (
    <Link href={`/messages?to=${educatorId}`} className="btn shrink-0">
      <MessageCircle className="mr-1.5 inline h-4 w-4" aria-hidden="true" /> Message
    </Link>
  );
}
