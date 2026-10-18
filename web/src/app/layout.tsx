import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/Providers';
import { LocaleNotice } from '@/components/LocaleNotice';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { THEME_COLOR_DARK, THEME_COLOR_LIGHT, THEME_INIT_SCRIPT } from '@/lib/theme-script';
import { SITE_URL } from '@/lib/server-api';
import { inter, notoEthiopic } from './fonts';

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
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: THEME_COLOR_LIGHT },
    { media: '(prefers-color-scheme: dark)', color: THEME_COLOR_DARK },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${notoEthiopic.variable}`} suppressHydrationWarning>
      <head>
        {/* Apply saved theme before paint to avoid a flash of the wrong mode */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <Providers>
          <Header />
          {/* pt-28 clears the fixed header on every page */}
          <main id="main" tabIndex={-1} className="min-h-screen pt-28 focus:outline-none">
            <LocaleNotice />
            {children}
          </main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
