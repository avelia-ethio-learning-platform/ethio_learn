/**
 * A production build needs the site's real public URL: canonicals, the sitemap
 * and share-image URLs are built from it (lib/server-api.ts SITE_URL), and
 * without it they point at localhost. Called from next.config.mjs, so a Vercel
 * production build fails when NEXT_PUBLIC_SITE_URL is unset, not https://, or
 * still the REPLACE placeholder.
 *
 * @param {Record<string, string | undefined>} env
 */
export function assertSiteUrl(env) {
  if (env.VERCEL_ENV !== 'production') return;
  const url = env.NEXT_PUBLIC_SITE_URL ?? '';
  if (!url.startsWith('https://') || /replace/i.test(url)) {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must be the site's real https:// address for a production build (it is ${url ? `"${url}"` : 'unset'}). ` +
        'Set it in Vercel → Project → Settings → Environment Variables (Production), then redeploy.',
    );
  }
}
