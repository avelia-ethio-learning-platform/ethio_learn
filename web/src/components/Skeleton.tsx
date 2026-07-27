/** Shimmering placeholder blocks for loading states. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

/** A row of skeleton lines, e.g. for a list item. */
export function SkeletonLines({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 py-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={`h-3 ${i === rows - 1 ? 'w-1/3' : 'w-full'}`} />
      ))}
    </div>
  );
}

/** Placeholder grid that mirrors the course-card layout while a catalog loads. */
export function CourseGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card">
          <Skeleton className="mb-3 h-32 w-full" />
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="mt-2 h-4 w-3/4" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-3 h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}
