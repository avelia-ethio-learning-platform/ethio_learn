import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/Providers';
import { Header } from '@/components/Header';
import { SITE_URL } from '@/lib/server-api';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'EthiopiaLearn — Learn skills from Ethiopian experts',
    template: '%s | EthiopiaLearn',
  },
  description:
    'EthiopiaLearn is an educator-first online learning marketplace for Ethiopia. Learn tech, business, freelancing and healthcare skills, pay with Chapa (Telebirr, CBE Birr and 18+ Ethiopian banks) and earn verifiable certificates.',
  keywords: ['online courses Ethiopia', 'learn tech skills Ethiopia', 'EthiopiaLearn', 'Chapa payment courses', 'Ethiopian educators', 'ኮርሶች'],
  openGraph: {
    type: 'website',
    siteName: 'EthiopiaLearn',
    title: 'EthiopiaLearn — Learn skills from Ethiopian experts',
    description: 'Educator-first online learning marketplace for Ethiopia with verifiable certificates.',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Header />
          <main className="mx-auto min-h-[80vh] max-w-6xl px-4 py-8">{children}</main>
          <footer className="border-t border-gray-200 bg-white py-8 text-center text-sm text-gray-500">
            <p>EthiopiaLearn · Educator-first online learning for Ethiopia 🇪🇹</p>
            <p className="mt-1">Payments by Chapa · Certificates publicly verifiable at /verify</p>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
