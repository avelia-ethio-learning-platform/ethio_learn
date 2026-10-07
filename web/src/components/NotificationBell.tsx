'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m } from 'framer-motion';
import { Bell, CheckCheck, Inbox } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { formatDate } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useDismiss } from '@/lib/use-dismiss';

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
  const { locale, t } = useT();
  const { user, ready } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

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

  useDismiss({ open, onClose: () => setOpen(false), containerRef: ref, triggerRef });

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
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        className="glass-secondary relative flex h-10 w-10 items-center justify-center rounded-xl text-brand-600 shadow-glass transition hover:scale-105 hover:text-brand-700 active:scale-[.98]"
        aria-label={count > 0 ? `${t('notifications')}, ${count} ${t('unread')}` : t('notifications')}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <Bell className="h-4 w-4" />
        {count > 0 && (
          // Exempt from the 12px floor: a numeric count badge, not readable prose.
          <m.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white shadow"
          >
            {count > 9 ? '9+' : count}
          </m.span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <m.div
            id={panelId}
            initial={{ opacity: 0, scale: 0.95, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -8 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-x-4 top-20 z-50 overflow-hidden sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-80 rounded-2xl shadow-floating"
            style={{ background: 'var(--popover)', border: '1px solid var(--card-border)', backdropFilter: 'blur(16px)' }}
          >
            <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
              <span className="text-sm font-semibold text-foreground">{t('notifications')}</span>
              {count > 0 && (
                <button
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
                  onClick={async () => {
                    await api('/notifications/read-all', { method: 'POST' });
                    queryClient.invalidateQueries({ queryKey: ['unread-count'] });
                    queryClient.invalidateQueries({ queryKey: ['notifications'] });
                  }}
                >
                  <CheckCheck className="h-3.5 w-3.5" /> {t('mark_all_read')}
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {!list?.length && (
                <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-gray-500">
                  <Inbox className="h-6 w-6" />
                  {t('no_notifications')}
                </div>
              )}
              {list?.map((n) => (
                <button
                  key={n.id}
                  onClick={() => openNotif(n)}
                  className={`block w-full px-4 py-3 text-left text-sm transition-colors hover:bg-brand-500/5 focus-visible:outline-offset-[-2px] ${n.read ? '' : 'bg-brand-500/10'}`}
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <p className="flex items-start gap-2 font-medium text-foreground">
                    {!n.read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />}
                    <span className="min-w-0 flex-1">{n.title}</span>
                  </p>
                  {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-gray-500">{n.body}</p>}
                  <p className="mt-1 text-xs text-gray-500">{formatDate(n.created_at, locale, 'datetime')}</p>
                </button>
              ))}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
