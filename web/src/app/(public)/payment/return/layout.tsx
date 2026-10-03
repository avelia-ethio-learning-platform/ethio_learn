import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Payment status', robots: { index: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
