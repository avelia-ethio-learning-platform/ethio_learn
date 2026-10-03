'use client';

import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Field } from '@/components/form/Field';
import { useDebouncedValue } from '@/lib/use-debounced-value';

export interface PickerOption {
  id: string;
  label: string;
}

/** Type-to-search combobox that returns {id,label}: replaces raw UUID inputs. */
export function SearchPicker({
  label,
  placeholder,
  selected,
  onSelect,
  fetcher,
}: {
  label: string;
  placeholder?: string;
  selected: PickerOption | null;
  onSelect: (v: PickerOption | null) => void;
  fetcher: (q: string) => Promise<PickerOption[]>;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const term = useDebouncedValue(q.trim());
  const { data } = useQuery({
    // Keyed by this picker, not its label: two "Course" pickers search different lists.
    queryKey: ['picker', listId, term],
    queryFn: () => fetcher(term),
    enabled: term.length >= 2 && !selected,
  });

  if (selected) {
    return (
      <div>
        <p className="mb-1 text-sm font-medium">{label}</p>
        <div className="flex items-center gap-1">
          <span className="badge-info max-w-[220px] truncate !normal-case">{selected.label}</span>
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            className="btn-ghost btn-sm text-gray-500 hover:text-red-600"
            onClick={() => {
              onSelect(null);
              setQ('');
            }}
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  // Results belong to the debounced term; hide them while the input is ahead of it.
  const options = open && term === q.trim() && term.length >= 2 ? data : undefined;
  const pick = (o: PickerOption) => {
    onSelect(o);
    setOpen(false);
    setActive(-1);
  };
  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <div className="relative">
      <Field label={label}>
        {(ids) => (
          <input
            {...ids}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={!!options}
            aria-controls={listId}
            aria-activedescendant={options && active >= 0 ? optionId(active) : undefined}
            autoComplete="off"
            className="input w-56 max-w-full text-sm"
            placeholder={placeholder}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onBlur={() => setOpen(false)}
            onKeyDown={(e) => {
              if (!options) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, options.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (options[active]) pick(options[active]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
              }
            }}
          />
        )}
      </Field>
      <ul
        id={listId}
        role="listbox"
        aria-label={label}
        hidden={!options}
        className="absolute z-10 mt-1 max-h-48 w-56 max-w-full overflow-y-auto rounded-xl text-sm shadow-floating"
        style={{ background: 'var(--popover)', border: '1px solid var(--card-border)' }}
      >
        {options?.length === 0 && (
          <li role="option" aria-selected="false" aria-disabled="true" className="px-3 py-1.5 text-gray-500">
            No matches
          </li>
        )}
        {options?.map((o, i) => (
          <li
            key={o.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            // mousedown, not click: the input's blur would close the list first.
            onMouseDown={(e) => {
              e.preventDefault();
              pick(o);
            }}
            className={`cursor-pointer truncate px-3 py-1.5 hover:bg-brand-500/10 ${i === active ? 'bg-brand-500/10' : ''}`}
          >
            {o.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
