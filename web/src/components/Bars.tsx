'use client';

/** Tiny dependency-free bar chart (CSS only). */
export function Bars({ data, format = (v: number) => String(v) }: { data: { label: string; value: number }[]; format?: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex h-36 items-end gap-1.5">
      {data.map((d) => (
        <div key={d.label} className="group flex flex-1 flex-col items-center justify-end gap-1">
          <span className="text-[10px] font-semibold text-gray-500 opacity-0 transition group-hover:opacity-100">{format(d.value)}</span>
          <div className="w-full rounded-t-md bg-brand-500/80 transition group-hover:bg-brand-600" style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }} title={`${d.label}: ${format(d.value)}`} />
          <span className="text-[9px] text-gray-400">{d.label.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
