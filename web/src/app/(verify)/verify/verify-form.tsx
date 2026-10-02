'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BadgeCheck } from 'lucide-react';
import { AuthShell } from '@/components/PageChrome';

/** Certificate ID → /verify/<id>, where the certificate is checked. */
export function VerifyForm() {
  const router = useRouter();
  const [id, setId] = useState('');

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const uid = id.trim();
    if (!uid) return;
    router.push(`/verify/${encodeURIComponent(uid)}`);
  };

  return (
    <AuthShell
      icon={<BadgeCheck className="h-6 w-6" />}
      title="Verify a certificate"
      subtitle="Enter the certificate ID printed on the certificate, or scan its QR code."
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="certificate-id" className="label">
            Certificate ID
          </label>
          <input
            id="certificate-id"
            name="certificate_id"
            required
            value={id}
            onChange={(e) => setId(e.target.value)}
            className="input"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <button type="submit" className="btn w-full">
          Verify
        </button>
      </form>
    </AuthShell>
  );
}
