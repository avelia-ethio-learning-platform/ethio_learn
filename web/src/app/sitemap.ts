import type { MetadataRoute } from 'next';
import { serverApi, SITE_URL, staticFallback } from '@/lib/server-api';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [
    { url: SITE_URL, changeFrequency: 'daily', priority: 1 },
    { url: `${SITE_URL}/courses`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${SITE_URL}/educators`, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${SITE_URL}/help`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SITE_URL}/signup`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SITE_URL}/verify`, changeFrequency: 'monthly', priority: 0.4 },
  ];
  const [courses, educators] = await Promise.all([
    serverApi<{ items: { id: string; published_at: string | null }[] }>(`/search?limit=50&page=1`, 3600),
    serverApi<{ educator_id: string }[]>('/educators/top?limit=24', 3600),
  ]);
  const { data } = staticFallback(courses, { items: [] });
  for (const course of data.items) {
    entries.push({
      url: `${SITE_URL}/courses/${course.id}`,
      lastModified: course.published_at ?? undefined,
      changeFrequency: 'weekly',
      priority: 0.8,
    });
  }
  for (const educator of staticFallback(educators, []).data) {
    entries.push({ url: `${SITE_URL}/educators/${educator.educator_id}`, changeFrequency: 'weekly', priority: 0.6 });
  }
  return entries;
}
