import type { ReactNode } from 'react';
import { Inbox, PartyPopper, type LucideIcon } from 'lucide-react';

/** Friendly empty state for lists and charts; `action` (a link or button) says what to do next. */
export function EmptyRows({
  label,
  happy = false,
  icon,
  action,
}: {
  label: string;
  happy?: boolean;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  const Icon = icon ?? (happy ? PartyPopper : Inbox);
  return (
    <div className="flex flex-col items-center gap-2.5 py-10 text-center text-sm text-gray-500">
      <span className="glass-secondary flex h-11 w-11 items-center justify-center rounded-2xl">
        <Icon className="h-5 w-5 text-brand-400" aria-hidden="true" />
      </span>
      {label}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
