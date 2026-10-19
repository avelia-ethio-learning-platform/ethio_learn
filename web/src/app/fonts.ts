import localFont from 'next/font/local';

// Self-hosted from the repo (no request to Google at build time or from the
// browser), exposed as CSS variables for tailwind.config.ts. The files are the
// variable woff2s Google Fonts serves for these subsets (OFL texts beside them),
// so every weight in use comes from one file: Inter's 800 is the headings'
// extrabold. The OG images use their own TTFs in src/assets/fonts.
export const inter = localFont({
  src: '../assets/fonts/Inter-latin.woff2',
  weight: '100 900',
  display: 'swap',
  variable: '--font-inter',
});

// Not preloaded: its file is ~200 KB, and the browser fetches it only when a
// page shows Ethiopic text (unicode-range), as the old @import did.
export const notoEthiopic = localFont({
  src: '../assets/fonts/NotoSansEthiopic-ethiopic.woff2',
  weight: '100 900',
  display: 'swap',
  variable: '--font-ethiopic',
  preload: false,
  declarations: [{ prop: 'unicode-range', value: 'U+030E, U+1200-1399, U+2D80-2DDE, U+AB01-AB2E, U+1E7E0-1E7FE' }],
});
