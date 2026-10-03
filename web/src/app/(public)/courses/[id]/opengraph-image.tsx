import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import { OgArt } from '@/lib/brand-art';
import { BAND_COLORS, GROUP_COLORS, categoryMeta } from '@/lib/categories';
import { formatETB } from '@/lib/format';
import { serverApi } from '@/lib/server-api';

// Node runtime: the fonts are read from disk (never fetched at request time).
export const runtime = 'nodejs';
export const alt = 'An EthiopiaLearn course';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

interface OgCourse {
  title: string;
  category: string;
  instructor_name?: string | null;
  pricing_type: 'free' | 'freemium' | 'paid';
  price_etb: number | null;
}

// Read from disk relative to the web app's root. `new URL(..., import.meta.url)` does not work
// here: Next's webpack turns it into an asset URL (/_next/static/media/...), not a file path.
// next.config.mjs (outputFileTracingIncludes) ships these files with the route (Docker standalone, Vercel).
const FONT_DIR = path.join(process.cwd(), 'src', 'assets', 'fonts');

async function loadFonts() {
  const [inter, interBold, ethiopicBold] = await Promise.all([
    readFile(path.join(FONT_DIR, 'Inter-Regular.ttf')),
    readFile(path.join(FONT_DIR, 'Inter-Bold.ttf')),
    readFile(path.join(FONT_DIR, 'NotoSansEthiopic-Bold.ttf')),
  ]);
  return [
    { name: 'Inter', data: inter, weight: 400 as const, style: 'normal' as const },
    { name: 'Inter', data: interBold, weight: 700 as const, style: 'normal' as const },
    // Satori falls back per glyph through the font-family list below.
    { name: 'Noto Sans Ethiopic', data: ethiopicBold, weight: 700 as const, style: 'normal' as const },
  ];
}

const FONT_FAMILY = 'Inter, Noto Sans Ethiopic';

function priceText(c: OgCourse): string {
  if (c.pricing_type === 'free' || !c.price_etb) return 'Free';
  return formatETB(c.price_etb, 'en');
}

function CourseCard({ course }: { course: OgCourse }) {
  const meta = categoryMeta(course.category);
  const title = course.title.length > 90 ? `${course.title.slice(0, 89)}…` : course.title;
  const educator = course.instructor_name?.trim();
  return (
    <div
      style={{
        width: 1200,
        height: 630,
        display: 'flex',
        flexDirection: 'column',
        background: GROUP_COLORS[meta.group],
        color: '#ffffff',
        fontFamily: FONT_FAMILY,
      }}
    >
      <div style={{ display: 'flex', height: 24 }}>
        {BAND_COLORS.map((c) => (
          <div key={c} style={{ flex: 1, background: c }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: '48px 72px 56px' }}>
        <div style={{ display: 'flex', alignItems: 'center', fontSize: 32, fontWeight: 700 }}>
          <div style={{ display: 'flex', padding: '8px 22px', border: '2px solid #ffffff', borderRadius: 999 }}>
            {meta.label}
          </div>
          <div style={{ display: 'flex', marginLeft: 20, fontSize: 32 }}>{meta.am}</div>
        </div>
        <div
          style={{
            display: 'flex',
            flex: 1,
            alignItems: 'center',
            fontSize: title.length > 50 ? 56 : 72,
            fontWeight: 700,
            lineHeight: 1.25,
          }}
        >
          {title}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {educator ? (
              <div style={{ display: 'flex', fontSize: 34, fontWeight: 400 }}>{`with ${educator}`}</div>
            ) : null}
            <div style={{ display: 'flex', fontSize: 28, fontWeight: 700, marginTop: 8 }}>EthiopiaLearn</div>
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 48,
              fontWeight: 700,
              padding: '10px 32px',
              background: '#ffffff',
              color: GROUP_COLORS[meta.group],
              borderRadius: 16,
            }}
          >
            {priceText(course)}
          </div>
        </div>
      </div>
    </div>
  );
}

// The URL hash comes from the route file, not the data, so never `immutable`.
const CACHE_FALLBACK = 'public, max-age=300';
const CACHE_COURSE = 'public, max-age=86400, stale-while-revalidate=604800';

export default async function CourseOpengraphImage({ params }: { params: { id: string } }) {
  const result = await serverApi<OgCourse>(`/courses/${params.id}`, 300);
  if (!result.ok) {
    // Unavailable or not found: the site card, not a failed image request.
    return new ImageResponse(<OgArt />, { ...size, headers: { 'cache-control': CACHE_FALLBACK } });
  }
  return new ImageResponse(<CourseCard course={result.data} />, { ...size, fonts: await loadFonts(), headers: { 'cache-control': CACHE_COURSE } });
}
