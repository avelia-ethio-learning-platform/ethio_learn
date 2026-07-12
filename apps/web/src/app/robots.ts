import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/server-api';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/dashboard', '/teach', '/admin', '/qa', '/learn/', '/dev/', '/payment/'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
