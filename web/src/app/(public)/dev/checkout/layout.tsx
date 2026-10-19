import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const metadata: Metadata = { title: 'Test checkout', robots: { index: false } };

// Read VERCEL_ENV per request, not once at build time.
export const dynamic = 'force-dynamic';

/**
 * The mock Chapa checkout (CHAPA_MODE=mock) is for local dev, docker-compose and
 * the CI e2e build. Vercel production serves a 404 instead (P2-31): its API runs
 * CHAPA_MODE=live, where this page can only mislead. Keyed on VERCEL_ENV like
 * the other production-only rules (lib/csp.mjs, lib/site-url.mjs).
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  if (process.env.VERCEL_ENV === 'production') notFound();
  return children;
}
