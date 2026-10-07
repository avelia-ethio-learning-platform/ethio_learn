import { Inter, Noto_Sans_Ethiopic } from 'next/font/google';

// Self-hosted at build time (no request to Google from the browser), exposed as
// CSS variables for tailwind.config.ts. Weights in use only: Inter's 800 is the
// headings' extrabold. The OG images use their own TTFs in src/assets/fonts.
export const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-inter',
});

// Not preloaded: its file is ~200 KB, and the browser fetches it anyway as soon
// as a page shows Ethiopic text (unicode-range), as the old @import did.
export const notoEthiopic = Noto_Sans_Ethiopic({
  subsets: ['ethiopic'],
  weight: ['400', '600', '700'],
  display: 'swap',
  variable: '--font-ethiopic',
  preload: false,
});
