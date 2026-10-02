'use client';

import { MailOpen } from 'lucide-react';
import { RequireRole } from '@/components/RequireRole';
import { PageHeader, PageShell } from '@/components/PageChrome';
import { InvitesList } from './invites-list';

export default function InvitesPage() {
  return (
    <RequireRole roles={['learner', 'educator']}>
      <PageShell>
        <PageHeader
          badge={
            <span className="section-badge">
              <MailOpen className="h-4 w-4 text-brand-500" /> Invitations
            </span>
          }
          title="Invitations to teach"
          subtitle="Institutions that want you as an instructor. Nothing changes until you accept."
        />
        <InvitesList />
      </PageShell>
    </RequireRole>
  );
}
