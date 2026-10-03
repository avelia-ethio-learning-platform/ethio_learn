'use client';

/** Previous / Next plus "Showing 21–40 of 132". Pages are 1-based. */
export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  if (total <= 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-gray-500">
      <p role="status">
        Showing {from}–{to} of {total}
      </p>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <button type="button" className="btn-secondary btn-sm" disabled={to >= total} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
