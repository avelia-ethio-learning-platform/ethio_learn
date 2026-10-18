'use client';

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import { Field } from '@/components/form/Field';

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel: string;
  tone?: 'danger' | 'default';
  /** Asks for a typed reason; it comes back in the result. */
  reason?: { label: string; required?: boolean; minLength?: number; maxLength?: number };
}

/** `false` when cancelled, otherwise the (trimmed) reason, '' when none was asked for. */
export type ConfirmResult = false | { reason: string };

type Ask = (options: ConfirmOptions) => Promise<ConfirmResult>;

const ConfirmContext = createContext<Ask>(() => Promise.resolve(false));

/** `if (!(await ask({ title, confirmLabel }))) return;` Named `ask`, never `confirm`. */
export function useConfirm(): Ask {
  return useContext(ConfirmContext);
}

/** One modal `<dialog>` for the whole app: top layer, inert background and Escape come from the browser. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [reason, setReason] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const resolveRef = useRef<((r: ConfirmResult) => void) | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  const ask = useCallback<Ask>((opts) => {
    // Only one dialog is ever shown: a newer call cancels the one on screen.
    if (resolveRef.current) resolveRef.current(false);
    else returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReason('');
    setOptions(opts);
    return new Promise<ConfirmResult>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const finish = (result: ConfirmResult) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    dialogRef.current?.close();
    setOptions(null);
    returnFocusRef.current?.focus();
    returnFocusRef.current = null;
  };

  // Open after the content has rendered. `.focus()` rather than `autoFocus`: the dialog is mounted closed.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!options || !dialog) return;
    if (!dialog.open) dialog.showModal();
    const target = options.reason ? reasonRef.current : options.tone === 'danger' ? cancelRef.current : confirmRef.current;
    target?.focus();
  }, [options]);

  const minLength = options?.reason ? (options.reason.minLength ?? (options.reason.required ? 1 : 0)) : 0;
  const reasonOk = reason.trim().length >= minLength;

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={options?.body ? bodyId : undefined}
        onCancel={(e) => {
          e.preventDefault();
          finish(false);
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl p-0 text-foreground backdrop:bg-black/50"
        style={{ background: 'var(--popover)', border: '1px solid var(--card-border)' }}
      >
        {options && (
          <form
            className="space-y-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (reasonOk) finish({ reason: reason.trim() });
            }}
          >
            <h2 id={titleId} className="text-lg font-semibold">
              {options.title}
            </h2>
            {options.body && (
              <p id={bodyId} className="text-sm text-gray-600 dark:text-gray-400">
                {options.body}
              </p>
            )}
            {options.reason && (
              <Field label={options.reason.label} hint={minLength > 1 ? t('at_least_n_chars', { n: minLength }) : undefined}>
                {(ids) => (
                  <textarea
                    {...ids}
                    ref={reasonRef}
                    className="input min-h-[5rem]"
                    rows={3}
                    maxLength={options.reason?.maxLength}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                )}
              </Field>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button ref={cancelRef} type="button" className="btn-secondary" onClick={() => finish(false)}>
                {t('cancel')}
              </button>
              <button ref={confirmRef} type="submit" className={options.tone === 'danger' ? 'btn-danger' : 'btn'} disabled={!reasonOk}>
                {options.confirmLabel}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </ConfirmContext.Provider>
  );
}
