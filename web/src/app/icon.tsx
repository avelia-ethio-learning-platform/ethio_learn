import { ImageResponse } from 'next/og';
import { IconArt } from '@/lib/brand-art';

export const contentType = 'image/png';

// Ids become the URLs: /icon/32, /icon/192, /icon/512, /icon/maskable-512.
// The maskable one keeps the cap inside the inner 80% safe zone.
const ICONS = [
  { id: '32', size: 32, artScale: 0.66, rounded: true },
  { id: '192', size: 192, artScale: 0.62, rounded: true },
  { id: '512', size: 512, artScale: 0.62, rounded: true },
  { id: 'maskable-512', size: 512, artScale: 0.5, rounded: false },
] as const;

export function generateImageMetadata() {
  return ICONS.map((i) => ({
    id: i.id,
    size: { width: i.size, height: i.size },
    contentType: 'image/png',
    alt: 'EthiopiaLearn',
  }));
}

export default function Icon({ id }: { id: string }) {
  const icon = ICONS.find((i) => i.id === id) ?? ICONS[1];
  return new ImageResponse(<IconArt size={icon.size} artScale={icon.artScale} rounded={icon.rounded} />, {
    width: icon.size,
    height: icon.size,
  });
}
