'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, HandCoins, LoaderCircle, Lock, ShoppingCart, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/hooks';
import { AuthShell } from '@/components/PageChrome';

interface PayRequest {
  token: string;
  status: string;
  course_id: string;
  course_title: string;
  price_etb: number | null;
  requester_name: string;
  message: string;
}

/** "Someone asked you to pay for their course" — public landing; paying needs any signed-in account. */
export default function PayRequestPage() {
  const { token } = useParams<{ token: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { user, ready } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['pay-request', token],
    queryFn: () => api<PayRequest>(`/pay-requests/${token}`, { auth: false }),
    retry: false,
  });
  const { data: wallet } = useQuery({ queryKey: ['wallet'], queryFn: () => api<{ balance_etb: number }>('/wallet'), enabled: ready && !!user });

  const pay = async (useWallet: boolean) => {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ checkout_url: string | null; confirmed: boolean }>(`/pay-requests/${token}/pay`, { method: 'POST', body: useWallet ? { use_wallet: true } : {} });
      if (res.confirmed) {
        router.replace(`/pay/${token}?paid=1`);
        return;
      }
      if (res.checkout_url) window.location.href = res.checkout_url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (isLoading || !ready) return <AuthShell icon={<LoaderCircle className="h-6 w-6 animate-spin" />} title="Loading request…"><span /></AuthShell>;
  if (loadError || !data) return <AuthShell icon={<HandCoins className="h-6 w-6" />} title="Request not found" subtitle="This payment link is invalid or has expired."><span /></AuthShell>;

  const paid = data.status === 'granted' || search.get('paid') === '1';
  if (paid) {
    return (
      <AuthShell icon={<CheckCircle2 className="h-6 w-6" />} title="Thank you! 🎉" subtitle={`${data.requester_name} now has access to "${data.course_title}".`}>
        <div className="text-center">
          <p className="text-sm text-gray-500">We&apos;ve let them know. Your receipt is in your dashboard.</p>
          <Link href="/dashboard" className="btn mt-5 inline-flex !px-8 !py-3">
            Go to dashboard
          </Link>
        </div>
      </AuthShell>
    );
  }

  const canWallet = (wallet?.balance_etb ?? 0) >= (data.price_etb ?? 0) && (data.price_etb ?? 0) > 0;
  return (
    <AuthShell icon={<HandCoins className="h-6 w-6" />} title={`${data.requester_name} is asking for your help`} subtitle="Pay for their course and they get access instantly.">
      <div className="space-y-4">
        <div className="glass-secondary rounded-xl p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Course</p>
          <Link href={`/courses/${data.course_id}`} className="mt-1 block font-bold text-foreground hover:underline">
            {data.course_title}
          </Link>
          <p className="mt-1 text-2xl font-extrabold text-brand-600">{data.price_etb} ETB</p>
          {data.message && <blockquote className="mt-3 border-l-2 border-brand-500 pl-3 text-sm italic text-gray-600">&ldquo;{data.message}&rdquo;</blockquote>}
        </div>
        {!user ? (
          <button className="btn w-full !py-3" onClick={() => router.push(`/login?next=/pay/${token}`)}>
            <Lock className="h-4 w-4" /> Log in or sign up to pay
          </button>
        ) : (
          <>
            <button className="btn w-full !py-3" disabled={busy} onClick={() => pay(false)}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />} Pay {data.price_etb} ETB with Chapa
            </button>
            {canWallet && (
              <button className="btn-secondary w-full" disabled={busy} onClick={() => pay(true)}>
                <Wallet className="h-4 w-4" /> Pay from my wallet ({wallet?.balance_etb} ETB)
              </button>
            )}
            <p className="text-center text-xs text-gray-400">Telebirr, CBE Birr and 18+ Ethiopian banks via Chapa. You&apos;ll be able to follow their progress from your dashboard.</p>
          </>
        )}
        {error && <p className="text-sm font-medium text-red-500">{error}</p>}
      </div>
    </AuthShell>
  );
}
