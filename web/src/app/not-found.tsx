import type { Metadata } from 'next';
import Link from 'next/link';
import { Compass, Search } from 'lucide-react';
import { PageShell } from '@/components/PageChrome';
import { Field } from '@/components/form/Field';

export const metadata: Metadata = { title: 'Page not found', robots: { index: false } };

export default function NotFound() {
  return (
    <PageShell className="flex min-h-[60vh] items-center justify-center">
      <div className="card w-full max-w-md animate-fade-in-up !rounded-3xl p-8 text-center">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500/15 text-brand-600">
          <Compass className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="text-xl font-bold text-foreground">We couldn&apos;t find that page</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">It may have moved, or the link may be wrong. Try searching for a course instead.</p>
        <form action="/courses" method="get" role="search" className="mt-5 flex items-end gap-2 text-left">
          <div className="min-w-0 flex-1">
            <Field label="Search courses">{(ids) => <input {...ids} type="search" name="q" className="input" placeholder="e.g. Excel, farming…" />}</Field>
          </div>
          <button className="btn !px-4">
            <Search className="h-4 w-4" aria-hidden /> Search
          </button>
        </form>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link href="/courses" className="btn !px-6">
            Browse courses
          </Link>
          <Link href="/" className="btn-ghost">
            Home
          </Link>
        </div>
      </div>
    </PageShell>
  );
}
