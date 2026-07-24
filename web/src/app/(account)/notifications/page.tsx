'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
import { SkeletonLines } from '@/components/Skeleton';

function NotificationsList() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data, isLoading } = useQuery({ queryKey: ['notifications-page'], queryFn: () => api<any[]>('/notifications') });

  return (
    <div className="mx-auto max-w-2xl">
      <BackButton />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Notifications</h1>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/notifications/preferences" className="text-brand-700 hover:underline">
            ⚙ Alert settings
          </Link>
          <button
            className="text-brand-700 hover:underline"
            onClick={async () => {
              await api('/notifications/read-all', { method: 'POST' });
              queryClient.invalidateQueries({ queryKey: ['notifications-page'] });
              queryClient.invalidateQueries({ queryKey: ['unread-count'] });
            }}
          >
            Mark all read
          </button>
        </div>
      </div>
      <div className="card mt-4 divide-y">
        {isLoading && <><SkeletonLines rows={2} /><SkeletonLines rows={2} /><SkeletonLines rows={2} /></>}
        {!isLoading && !data?.length && <p className="py-6 text-center text-sm text-gray-400">No notifications yet.</p>}
        {data?.map((n) => (
          <button
            key={n.id}
            onClick={async () => {
              if (!n.read) {
                await api(`/notifications/${n.id}/read`, { method: 'POST' });
                queryClient.invalidateQueries({ queryKey: ['unread-count'] });
              }
              if (n.link) router.push(n.link);
            }}
            className={`block w-full py-3 text-left ${n.read ? '' : 'font-medium'}`}
          >
            <p className="text-sm text-gray-900">{n.title}</p>
            {n.body && <p className="mt-0.5 text-xs text-gray-500">{n.body}</p>}
            <p className="mt-0.5 text-[10px] text-gray-400">{new Date(n.created_at).toLocaleString()}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function NotificationsPage() {
  return (
    <RequireRole roles={['learner', 'educator', 'institution_admin', 'quality_officer', 'platform_admin']}>
      <NotificationsList />
    </RequireRole>
  );
}
