'use client';

import { useId, useState } from 'react';

/**
 * The course summary. Below `lg` it is clamped to three lines (to keep the price in
 * the first phone screen) with a Read more / Show less toggle; from `lg` it is always full.
 */
export function ExpandableSummary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="mt-4">
      <p id={id} className={`leading-relaxed text-gray-600 lg:line-clamp-none ${open ? '' : 'line-clamp-3'}`}>
        {text}
      </p>
      {text.length > 120 && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-sm font-semibold text-brand-600 hover:underline lg:hidden"
        >
          {open ? 'Show less' : 'Read more'}
        </button>
      )}
    </div>
  );
}
