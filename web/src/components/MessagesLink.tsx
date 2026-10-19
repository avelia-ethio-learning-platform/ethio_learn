'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { useT } from '@/lib/i18n';

/** Header link to /messages with the unread count, polled like the notification bell. */
export function MessagesLink() {
  const { t } = useT();
  const { user, ready } = useAuth();
  const { data } = useQuery({
    // The key messages/page.tsx invalidates when a thread is opened; per user, so a new login never shows the last one's count.
    queryKey: ['dm-unread', user?.id],
    queryFn: () => api<{ unread: number }>('/messages/unread-count'),
    enabled: ready && !!user,
    refetchInterval: 20_000,
  });

  if (!ready || !user) return null;
  const count = data?.unread ?? 0;

  return (
    <Link
      href="/messages"
      className="glass-secondary relative flex h-10 w-10 items-center justify-center rounded-xl text-brand-600 shadow-glass transition hover:scale-105 hover:text-brand-700 active:scale-[.98]"
      aria-label={count > 0 ? `${t('messages')}, ${count} ${t('unread')}` : t('messages')}
    >
      <MessageSquare className="h-4 w-4" />
      {count > 0 && (
        // Exempt from the 12px floor: a numeric count badge, not readable prose.
        <span className="badge-count absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold shadow">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </Link>
  );
}
