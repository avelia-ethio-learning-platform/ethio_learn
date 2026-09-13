'use client';

import { Ticket } from 'lucide-react';
import { RequireRole } from '@/components/RequireRole';
import { CouponManager } from './coupon-manager';
import { BackButton } from '@/components/BackButton';
import { PageHeader, PageShell } from '@/components/PageChrome';

export default function TeachCouponsPage() {
  return (
    <RequireRole roles={['educator', 'institution_admin']}>
      <PageShell>
        <BackButton fallback="/teach" label="Educator dashboard" />
        <PageHeader
          badge={
            <span className="section-badge">
              <Ticket className="h-4 w-4 text-brand-500" /> Coupons
            </span>
          }
          title="Promo &amp; scholarship codes"
          subtitle="Discount your own courses for a campaign, a cohort, or a partner institution."
        />
        <CouponManager />
      </PageShell>
    </RequireRole>
  );
}
