import { useId, type ReactNode } from 'react';

export interface FieldIds {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
}

interface FieldProps {
  label: ReactNode;
  hint?: string;
  error?: string;
  children: (ids: FieldIds) => ReactNode;
}

/**
 * A labelled form control. The control is rendered by the caller through the
 * render prop, so the id wiring is visible at the call site.
 */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-gray-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
