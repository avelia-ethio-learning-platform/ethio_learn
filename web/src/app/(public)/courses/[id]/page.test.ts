import { beforeEach, describe, expect, it, vi } from 'vitest';

const serverApi = vi.fn();
vi.mock('@/lib/server-api', () => ({ serverApi: (...args: unknown[]) => serverApi(...args), SITE_URL: 'http://localhost:3000' }));
// The page module renders client components we don't need here.
vi.mock('@/components/CoursePreviewPlayer', () => ({ CoursePreviewPlayer: () => null }));
vi.mock('./enroll-panel', () => ({ EnrollPanel: () => null }));
vi.mock('next/navigation', () => ({ notFound: vi.fn() }));

import { generateMetadata } from './page';

const course = (thumbnail_url: string | null) => ({
  id: 'c1',
  title: 'Python for Data Analysis',
  description: 'Learn it.',
  thumbnail_url,
});

// The per-course card comes from opengraph-image.tsx (the file convention), which wins
// over any `images` entry, so generateMetadata must not set one (not even the thumbnail).
// Next merges openGraph/twitter shallowly per key, so both keep their text and the large card.
describe('course page share metadata', () => {
  beforeEach(() => serverApi.mockReset());

  it.each([null, 'https://cdn.example/t.png'])('sets no images entry (thumbnail %s)', async (thumb) => {
    serverApi.mockResolvedValue({ ok: true, data: course(thumb) });
    const meta = await generateMetadata({ params: { id: 'c1' } });
    expect(meta.openGraph?.images).toBeUndefined();
    expect(meta.twitter?.images).toBeUndefined();
    expect(meta.openGraph?.title).toBe('Python for Data Analysis');
    expect(meta.twitter).toMatchObject({ card: 'summary_large_image', title: 'Python for Data Analysis' });
  });
});
