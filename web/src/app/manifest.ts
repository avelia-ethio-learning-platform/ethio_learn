import type { MetadataRoute } from 'next';

// The icon URLs come from app/icon.tsx's generateImageMetadata ids
// (/icon/<id>), so the manifest and the generated icons can't drift apart.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'EthiopiaLearn',
    short_name: 'EthiopiaLearn',
    description: 'Learn real skills from Ethiopian experts — works offline for pages you have opened.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#2563eb',
    lang: 'en',
    icons: [
      { src: '/icon/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon/maskable-512', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
