import { ImageResponse } from 'next/og';
import { OgArt } from '@/lib/brand-art';

export const alt = 'EthiopiaLearn: learn skills from Ethiopian experts';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(<OgArt />, size);
}
