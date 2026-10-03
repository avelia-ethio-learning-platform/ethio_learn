/** Mirrors the course page: header block, buy box beside it from lg, then the syllabus. */
export default function Loading() {
  return (
    <div className="page-shell" aria-busy="true">
      <div className="skeleton mb-4 h-5 w-32" />
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-3 lg:col-span-2 lg:row-start-1">
          <div className="skeleton h-28 w-full !rounded-2xl sm:h-32" />
          <div className="skeleton h-5 w-28" />
          <div className="skeleton h-10 w-3/4" />
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-2/3" />
        </div>
        <div className="lg:col-start-3 lg:row-span-2 lg:row-start-1">
          <div className="card !rounded-3xl !p-6">
            <div className="skeleton h-9 w-32" />
            <div className="skeleton mt-5 h-11 w-full !rounded-xl" />
            <div className="skeleton mt-5 h-4 w-full" />
            <div className="skeleton mt-3 h-4 w-5/6" />
          </div>
        </div>
        <div className="min-w-0 space-y-3 lg:col-span-2 lg:row-start-2">
          <div className="skeleton h-6 w-40" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-24 w-full !rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
