import { securityHeaders } from './src/lib/csp.mjs';
import { assertSiteUrl } from './src/lib/site-url.mjs';

// A production build without the real site URL would publish localhost canonicals.
assertSiteUrl(process.env);

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Standalone is a SELF-HOSTING output: it emits .next/standalone/server.js,
  // which web/Dockerfile copies into the runtime image. Vercel builds its own
  // serverless output from a normal .next/ and does not want this — leaving it
  // on there yields a deployment that builds green but 404s every route.
  // Opt-in, set only by web/Dockerfile, so Vercel always gets a normal build.
  ...(process.env.BUILD_STANDALONE === '1' ? { output: 'standalone' } : {}),

  // The course share image reads its fonts from disk at request time; file tracing can't see
  // that, so say which files the route needs (Docker standalone, Vercel).
  experimental: {
    outputFileTracingIncludes: { '/courses/[id]/opengraph-image': ['./src/assets/fonts/*.ttf'] },
  },

  // CSP and the other security headers on every response, from this build's env
  // (src/lib/csp.mjs). Report-Only on Vercel production until CSP_ENFORCE=true.
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders(process.env) }];
  },

  // Browsers still ask for /favicon.ico; serve the generated 32px icon.
  async rewrites() {
    return [{ source: '/favicon.ico', destination: '/icon/32' }];
  },

  // The catalog moved to /courses. The home page is static now, so it can't
  // read the query; forward legacy landing-page filter URLs here instead (the
  // query string is passed through).
  async redirects() {
    return ['q', 'category', 'pricing_type'].map((key) => ({
      source: '/',
      has: [{ type: 'query', key }],
      destination: '/courses',
      permanent: false,
    }));
  },
};

export default nextConfig;
