import { Inbox, PartyPopper } from 'lucide-react';

/** Friendly empty state for lists and charts. */
export function EmptyRows({ label, happy = false }: { label: string; happy?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2.5 py-10 text-center text-sm text-gray-500">
      <span className="glass-secondary flex h-11 w-11 items-center justify-center rounded-2xl">
        {happy ? <PartyPopper className="h-5 w-5 text-brand-400" /> : <Inbox className="h-5 w-5 text-brand-400" />}
      </span>
      {label}
    </div>
  );
}
