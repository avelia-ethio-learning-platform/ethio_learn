'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/hooks';

export function RequireRole({ roles, children }: { roles: string[]; children: React.ReactNode }) {
  const { user, ready } = useAuth();
  if (!ready) return <p className="text-gray-500">Loading…</p>;
  if (!user) {
    return (
      <div className="card mx-auto max-w-md text-center">
        <p className="text-lg font-medium">Please log in</p>
        <Link href="/login" className="btn mt-3 inline-flex">Log in</Link>
      </div>
    );
  }
  if (!roles.includes(user.role)) {
    return (
      <div className="card mx-auto max-w-md text-center text-sm text-gray-600">
        This area is for {roles.join(' / ')} accounts. You are signed in as <strong>{user.role}</strong>.
      </div>
    );
  }
  return <>{children}</>;
}
