'use client';

import { useCallback, useState } from 'react';

export type FormStatusValue = { tone: 'ok' | 'error'; text: string } | null;

/** Returns `[status, setOk, setError, clear]` for use with `<FormStatus />`. */
export function useFormStatus() {
  const [status, setStatus] = useState<FormStatusValue>(null);
  const setOk = useCallback((text: string) => setStatus({ tone: 'ok', text }), []);
  const setError = useCallback((text: string) => setStatus({ tone: 'error', text }), []);
  const clear = useCallback(() => setStatus(null), []);
  return [status, setOk, setError, clear] as const;
}

/**
 * Two always-mounted live regions, so screen readers announce text that lands
 * in them later. Errors go to the assertive `alert` region, successes to the
 * polite `status` region.
 */
export function FormStatus({ status }: { status: FormStatusValue }) {
  const ok = status?.tone === 'ok' ? status.text : '';
  const error = status?.tone === 'error' ? status.text : '';
  return (
    <>
      <div role="status">{ok && <p className="badge-success">{ok}</p>}</div>
      <div role="alert">{error && <p className="badge-danger">{error}</p>}</div>
    </>
  );
}
