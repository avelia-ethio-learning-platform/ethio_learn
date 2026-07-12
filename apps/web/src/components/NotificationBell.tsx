'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';

interface Notif {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  created_at: string;
}

export function NotificationBell() {
  const { user, ready } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: unread } = useQuery({
    queryKey: ['unread-count'],
    queryFn: () => api<{ count: number }>('/notifications/unread-count'),
    enabled: ready && !!user,
    refetchInterval: 20_000,
  });
  const { data: list } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<Notif[]>('/notifications'),
    enabled: open,
  });

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  if (!ready || !user) return null;
  const count = unread?.count ?? 0;

  const openNotif = async (n: Notif) => {
    if (!n.read) {
      await api(`/notifications/${n.id}/read`, { method: 'POST' });
      queryClient.invalidateQueries({ queryKey: ['unread-count'] });
    }
    setOpen(false);
    if (n.link) router.push(n.link);
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="relative text-gray-600 hover:text-brand-700" aria-label="Notifications">
        <span className="text-lg">🔔</span>
        {count > 0 && (
          <span className="absolute -right-1 -top-1 rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white">{count > 9 ? '9+' : count}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {count > 0 && (
              <button
                className="text-xs text-brand-700 hover:underline"
                onClick={async () => {
                  await api('/notifications/read-all', { method: 'POST' });
                  queryClient.invalidateQueries({ queryKey: ['unread-count'] });
                  queryClient.invalidateQueries({ queryKey: ['notifications'] });
                }}
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {!list?.length && <p className="px-3 py-6 text-center text-sm text-gray-400">No notifications yet.</p>}
            {list?.map((n) => (
              <button
                key={n.id}
                onClick={() => openNotif(n)}
                className={`block w-full border-b px-3 py-2 text-left text-sm hover:bg-gray-50 ${n.read ? '' : 'bg-brand-50/50'}`}
              >
                <p className="font-medium text-gray-900">{n.title}</p>
                {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-gray-500">{n.body}</p>}
                <p className="mt-0.5 text-[10px] text-gray-400">{new Date(n.created_at).toLocaleString()}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
