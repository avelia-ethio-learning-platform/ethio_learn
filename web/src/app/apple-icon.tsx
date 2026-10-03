import { ImageResponse } from 'next/og';
import { IconArt } from '@/lib/brand-art';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

// iOS rounds the corners itself, so the square is full-bleed.
export default function AppleIcon() {
  return new ImageResponse(<IconArt size={180} rounded={false} artScale={0.6} />, size);
}
