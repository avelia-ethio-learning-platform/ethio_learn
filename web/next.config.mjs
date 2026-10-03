/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Standalone is a SELF-HOSTING output: it emits .next/standalone/server.js,
  // which web/Dockerfile copies into the runtime image. Vercel builds its own
  // serverless output from a normal .next/ and does not want this — leaving it
  // on there yields a deployment that builds green but 404s every route.
  // Opt-in, set only by web/Dockerfile, so Vercel always gets a normal build.
  ...(process.env.BUILD_STANDALONE === '1' ? { output: 'standalone' } : {}),

  // The catalog moved to /courses. The home page is static now, so it can't
  // read the query; forward legacy landing-page filter URLs here instead (the
  // query string is passed through).
  // Browsers still ask for /favicon.ico; serve the generated 32px icon.
  async rewrites() {
    return [{ source: '/favicon.ico', destination: '/icon/32' }];
  },

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
