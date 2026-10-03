'use client';

import { useCallback, useState } from 'react';

/** `ok` is a success, `info` a polite outcome that is not a success (a quiz not passed yet), `error` a failure. */
export type FormStatusValue = { tone: 'ok' | 'info' | 'error'; text: string } | null;

/** Returns `[status, setOk, setError, clear, setInfo]` for use with `<FormStatus />`. */
export function useFormStatus() {
  const [status, setStatus] = useState<FormStatusValue>(null);
  const setOk = useCallback((text: string) => setStatus({ tone: 'ok', text }), []);
  const setError = useCallback((text: string) => setStatus({ tone: 'error', text }), []);
  const clear = useCallback(() => setStatus(null), []);
  const setInfo = useCallback((text: string) => setStatus({ tone: 'info', text }), []);
  return [status, setOk, setError, clear, setInfo] as const;
}

/** A full-width, wrapping banner in the tone's badge colours (the bare badge is a 12 px pill). */
const BANNER = 'flex w-full items-start !whitespace-normal !rounded-xl !px-3 !py-2 !text-sm !font-medium';

/**
 * Two always-mounted live regions, so screen readers announce text that lands
 * in them later. Errors go to the assertive `alert` region; successes and info
 * go to the polite `status` region, each in its own colours so a success never
 * looks like anything else.
 */
export function FormStatus({ status }: { status: FormStatusValue }) {
  const polite = status && status.tone !== 'error' ? status.text : '';
  const politeTone = status?.tone === 'info' ? 'badge-warn' : 'badge-success';
  const error = status?.tone === 'error' ? status.text : '';
  return (
    <>
      <div role="status">{polite && <p className={`${politeTone} ${BANNER}`}>{polite}</p>}</div>
      <div role="alert">{error && <p className={`badge-danger ${BANNER}`}>{error}</p>}</div>
    </>
  );
}
