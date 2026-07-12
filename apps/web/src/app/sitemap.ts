import type { MetadataRoute } from 'next';
import { serverApi, SITE_URL } from '@/lib/server-api';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [
    { url: SITE_URL, changeFrequency: 'daily', priority: 1 },
    { url: `${SITE_URL}/signup`, changeFrequency: 'monthly', priority: 0.5 },
  ];
  const result = await serverApi<{ items: { id: string; published_at: string | null }[] }>(`/search?limit=50&page=1`, 3600);
  for (const course of result?.items ?? []) {
    entries.push({
      url: `${SITE_URL}/courses/${course.id}`,
      lastModified: course.published_at ?? undefined,
      changeFrequency: 'weekly',
      priority: 0.8,
    });
  }
  return entries;
}
