'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { useT } from '@/lib/i18n';

export function EnrollPanel({ courseId, pricingType }: { courseId: string; pricingType: string }) {
  const { user, ready } = useAuth();
  const { t } = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { data: status } = useQuery({
    queryKey: ['enrollment-status', courseId],
    queryFn: () => api<{ entitlement_status: string }>(`/enrollments/status?course_id=${courseId}`),
    enabled: ready && user?.role === 'learner',
  });

  if (!ready) return null;

  if (!user) {
    return (
      <button className="btn mt-4 w-full" onClick={() => router.push(`/login?next=/courses/${courseId}`)}>
        {t('login_to_enroll')}
      </button>
    );
  }
  if (user.role !== 'learner') {
    return <p className="mt-4 text-sm text-gray-500">Log in as a learner to enroll.</p>;
  }
  if (status?.entitlement_status === 'active') {
    return (
      <button className="btn mt-4 w-full" onClick={() => router.push(`/learn/${courseId}`)}>
        {t('continue_learning')}
      </button>
    );
  }

  const enroll = async () => {
    setBusy(true);
    setError('');
    try {
      if (pricingType === 'free') {
        await api(`/enrollments`, { method: 'POST', body: { course_id: courseId } });
        router.push(`/learn/${courseId}`);
      } else {
        const res = await api<{ checkout_url: string }>(`/payments/initiate`, { method: 'POST', body: { course_id: courseId } });
        window.location.href = res.checkout_url;
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mt-4">
      <button className="btn w-full" onClick={enroll} disabled={busy}>
        {busy ? 'Please wait…' : pricingType === 'free' ? t('enroll_free') : t('buy_with_chapa')}
      </button>
      {pricingType === 'freemium' && (
        <p className="mt-2 text-xs text-gray-500">The first section is free to preview — buy to unlock everything.</p>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
