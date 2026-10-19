import { Skeleton } from '@/components/Skeleton';

/** Mirrors the learner dashboard: page header, then the enrolled-courses cards. */
export default function Loading() {
  return (
    <div className="page-shell" aria-busy="true">
      <div className="mb-8 space-y-3">
        <Skeleton className="h-8 w-36 !rounded-full" />
        <Skeleton className="h-10 w-2/3 max-w-sm" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <Skeleton className="mb-4 h-6 w-48" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
    </div>
  );
}
