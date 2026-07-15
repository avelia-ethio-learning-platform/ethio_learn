'use client';

import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, Inbox } from 'lucide-react';
import { api } from '@/lib/api';
import { RequireRole } from '@/components/RequireRole';
import { BackButton } from '@/components/BackButton';
import { PageShell } from '@/components/PageChrome';

function NotificationsList() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data } = useQuery({ queryKey: ['notifications-page'], queryFn: () => api<any[]>('/notifications') });

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl">
        <BackButton />
        <div className="flex items-center justify-between animate-fade-in-up">
          <h1 className="flex items-center gap-3 text-2xl font-extrabold tracking-tight text-foreground md:text-3xl">
            <span className="gradient-bg-blue flex h-11 w-11 items-center justify-center rounded-2xl text-white shadow-floating">
              <Bell className="h-5 w-5" />
            </span>
            Notifications
          </h1>
          <button
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline"
            onClick={async () => {
              await api('/notifications/read-all', { method: 'POST' });
              queryClient.invalidateQueries({ queryKey: ['notifications-page'] });
              queryClient.invalidateQueries({ queryKey: ['unread-count'] });
            }}
          >
            <CheckCheck className="h-4 w-4" /> Mark all read
          </button>
        </div>
        <div className="card mt-6 animate-fade-in-up !p-0 overflow-hidden">
          {!data?.length && (
            <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-gray-400">
              <Inbox className="h-7 w-7" />
              No notifications yet.
            </div>
          )}
          {data?.map((n, i) => (
            <button
              key={n.id}
              onClick={async () => {
                if (!n.read) {
                  await api(`/notifications/${n.id}/read`, { method: 'POST' });
                  queryClient.invalidateQueries({ queryKey: ['unread-count'] });
                  queryClient.invalidateQueries({ queryKey: ['notifications-page'] });
                }
                if (n.link) router.push(n.link);
              }}
              className={`block w-full px-5 py-4 text-left transition-colors hover:bg-brand-500/5 ${n.read ? '' : 'bg-brand-500/10'}`}
              style={i > 0 ? { borderTop: '1px solid var(--border)' } : undefined}
            >
              <p className={`flex items-start gap-2 text-sm text-foreground ${n.read ? '' : 'font-semibold'}`}>
                {!n.read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />}
                <span className="min-w-0 flex-1">{n.title}</span>
              </p>
              {n.body && <p className="mt-1 text-xs leading-relaxed text-gray-500">{n.body}</p>}
              <p className="mt-1 text-[10px] text-gray-400">{new Date(n.created_at).toLocaleString()}</p>
            </button>
          ))}
        </div>
      </div>
    </PageShell>
  );
}

export default function NotificationsPage() {
  return (
    <RequireRole roles={['learner', 'educator', 'institution_admin', 'quality_officer', 'platform_admin']}>
      <NotificationsList />
    </RequireRole>
  );
}
