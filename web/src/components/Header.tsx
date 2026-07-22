'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api, setAuth } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { useT } from '@/lib/i18n';
import { NotificationBell } from './NotificationBell';

/** Messages nav link with a live unread badge. */
function MessagesLink() {
  const { data } = useQuery({
    queryKey: ['dm-unread'],
    queryFn: () => api<{ unread: number }>('/messages/unread-count'),
    refetchInterval: 20_000,
  });
  const unread = data?.unread ?? 0;
  return (
    <Link href="/messages" className="relative text-gray-600 hover:text-brand-700" title="Direct messages">
      💬
      {unread > 0 && (
        <span className="absolute -right-2 -top-1.5 rounded-full bg-red-600 px-1 text-[10px] font-bold leading-4 text-white">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  );
}

export function Header() {
  const { user, ready } = useAuth();
  const { t, toggle } = useT();
  const router = useRouter();

  const roleLinks: Record<string, { href: string; label: string }[]> = {
    learner: [{ href: '/dashboard', label: t('my_learning') }],
    educator: [{ href: '/teach', label: t('teach') }],
    institution_admin: [
      { href: '/institution', label: t('institution') },
      { href: '/institution/review', label: t('review_queue') },
    ],
    quality_officer: [{ href: '/qa', label: t('review_queue') }],
    platform_admin: [
      { href: '/admin', label: t('admin') },
      { href: '/qa', label: 'QA' },
    ],
  };

  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="text-xl font-bold text-brand-700">
          Ethiopia<span className="text-gray-900">Learn</span>
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/" className="text-gray-600 hover:text-brand-700">
            {t('courses')}
          </Link>
          {ready && user && roleLinks[user.role]?.map((l) => (
            <Link key={l.href} href={l.href} className="text-gray-600 hover:text-brand-700">
              {l.label}
            </Link>
          ))}
          <button onClick={toggle} className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:border-brand-600">
            {t('lang_name')}
          </button>
          {ready && user && <MessagesLink />}
          {ready && user && <NotificationBell />}
          {ready && !user && (
            <>
              <Link href="/login" className="text-gray-600 hover:text-brand-700">
                {t('login')}
              </Link>
              <Link href="/signup" className="rounded-md bg-brand-700 px-3 py-1.5 text-white hover:bg-brand-800">
                {t('signup')}
              </Link>
            </>
          )}
          {ready && user && (
            <>
              <Link href="/account" className="text-gray-600 hover:text-brand-700" title="Account settings">
                👤 {user.name.split(' ')[0]}
              </Link>
              <button
                className="text-gray-500 hover:text-red-600"
                onClick={() => {
                  setAuth(null);
                  router.push('/');
                }}
              >
                {t('logout')}
              </button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
