import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Help and support', alternates: { canonical: '/help' } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
