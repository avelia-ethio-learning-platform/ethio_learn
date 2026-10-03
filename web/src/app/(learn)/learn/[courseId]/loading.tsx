/** Mirrors the lesson player: title and video on the left, lesson list on the right from lg. */
export default function Loading() {
  return (
    <div className="page-shell" aria-busy="true">
      <div className="grid grid-cols-1 gap-x-6 gap-y-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <div className="skeleton h-9 w-2/3" />
          <div className="skeleton aspect-video w-full !rounded-2xl" />
          <div className="skeleton h-5 w-1/2" />
        </div>
        <div className="space-y-3">
          <div className="skeleton h-28 w-full !rounded-2xl" />
          <div className="skeleton h-28 w-full !rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
