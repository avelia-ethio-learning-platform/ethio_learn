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
              <MailOpen className="h-4 w-4 text-brand-500" /> Institutions
            </span>
          }
          title="Institutions"
          subtitle="Invitations to teach, and the institution you teach with. Nothing changes until you accept, and you can leave any time."
        />
        <InvitesList />
      </PageShell>
    </RequireRole>
  );
}
