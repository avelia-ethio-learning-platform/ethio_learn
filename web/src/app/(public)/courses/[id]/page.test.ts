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

// Next merges openGraph shallowly, so a course that sets openGraph without
// images would lose the site share image. Next also copies openGraph images to
// the twitter card when `twitter` sets none, so the course must not set its own.
describe('course page share image', () => {
  beforeEach(() => serverApi.mockReset());

  it('falls back to the site image when the course has no thumbnail', async () => {
    serverApi.mockResolvedValue({ ok: true, data: course(null) });
    const meta = await generateMetadata({ params: { id: 'c1' } });
    expect(meta.openGraph?.images).toEqual(['/opengraph-image']);
    expect(meta.twitter?.images).toBeUndefined();
  });

  it("uses the course's own thumbnail when it has one", async () => {
    serverApi.mockResolvedValue({ ok: true, data: course('https://cdn.example/t.png') });
    const meta = await generateMetadata({ params: { id: 'c1' } });
    expect(meta.openGraph?.images).toEqual(['https://cdn.example/t.png']);
    expect(meta.twitter?.images).toBeUndefined();
  });
});
