import type { Metadata } from 'next';
import Link from 'next/link';
import { Compass } from 'lucide-react';

export const metadata: Metadata = { title: 'Page not found', robots: { index: false } };

export default function NotFound() {
  return (
    <div className="page-shell flex min-h-[60vh] items-center justify-center">
      <div className="card w-full max-w-md animate-fade-in-up !rounded-3xl p-8 text-center">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500/15 text-brand-600">
          <Compass className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="text-xl font-bold text-foreground">Page not found</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">This page doesn&apos;t exist, or it has moved.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link href="/courses" className="btn !px-6">
            Browse courses
          </Link>
          <Link href="/" className="btn-ghost">
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
