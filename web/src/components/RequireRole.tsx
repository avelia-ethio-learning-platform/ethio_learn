'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Lock, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/hooks';
import { roleLabel } from '@/lib/labels';
import { roleHome, roleHomeLabel } from '@/lib/safe-next';
import { useT } from '@/lib/i18n';

export function RequireRole({ roles, children }: { roles: string[]; children: React.ReactNode }) {
  const { user, ready } = useAuth();
  const { t } = useT();
  const pathname = usePathname();

  if (!ready) {
    return (
      <div className="page-shell">
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="skeleton h-9 w-56" />
          <div className="skeleton h-32 w-full" />
          <div className="skeleton h-32 w-full" />
        </div>
      </div>
    );
  }
  if (!user) {
    return (
      <div className="page-shell flex min-h-[60vh] items-center justify-center">
        <div className="card w-full max-w-md animate-fade-in-up !rounded-3xl p-8 text-center">
          <span className="gradient-bg-blue mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-floating">
            <Lock className="h-5 w-5" />
          </span>
          <p className="text-lg font-bold text-foreground">{t('gate_login_title')}</p>
          <p className="mt-1 text-sm text-gray-500">{t('gate_login_body')}</p>
          <Link href={`/login?next=${encodeURIComponent(pathname + window.location.search)}`} className="btn mt-5 inline-flex !px-8">
            {t('login')}
          </Link>
        </div>
      </div>
    );
  }
  if (!roles.includes(user.role)) {
    return (
      <div className="page-shell flex min-h-[60vh] items-center justify-center">
        <div className="card w-full max-w-md animate-fade-in-up !rounded-3xl p-8 text-center">
          <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-500">
            <ShieldAlert className="h-5 w-5" />
          </span>
          <h1 className="text-lg font-bold text-foreground">{t('gate_denied_title')}</h1>
          <p className="mt-1 text-sm leading-relaxed text-gray-500">
            {t('gate_denied_body')} <strong className="text-foreground">{roleLabel(user.role)}</strong>.
          </p>
          <Link href={roleHome(user.role)} className="btn mt-5 inline-flex !px-8">
            {roleHomeLabel(user.role)}
          </Link>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
