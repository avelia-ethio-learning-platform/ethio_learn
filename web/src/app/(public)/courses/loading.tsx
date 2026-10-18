import { Skeleton } from '@/components/Skeleton';

/** Mirrors the catalog: centred heading, the filter panel, then a grid of course cards (cover 160 px, then text). */
export default function Loading() {
  return (
    <div className="page-shell" aria-busy="true">
      <div className="flex flex-col items-center gap-3">
        <Skeleton className="h-8 w-32 !rounded-full" />
        <Skeleton className="mt-3 h-10 w-3/4 max-w-md md:h-14" />
        <Skeleton className="h-4 w-2/3 max-w-xl" />
      </div>
      <Skeleton className="mt-10 h-44 w-full !rounded-3xl sm:h-52" />
      <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="card overflow-hidden !p-0">
            <Skeleton className="h-40 w-full !rounded-none" />
            <div className="space-y-2.5 p-5">
              <Skeleton className="h-3 w-1/4" />
              <Skeleton className="h-5 w-4/5" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
