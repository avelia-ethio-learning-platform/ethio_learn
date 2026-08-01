/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Standalone is a SELF-HOSTING output: it emits .next/standalone/server.js,
  // which web/Dockerfile copies into the runtime image. Vercel builds its own
  // serverless output from a normal .next/ and does not want this — leaving it
  // on there yields a deployment that builds green but 404s every route.
  // Opt-in, set only by web/Dockerfile, so Vercel always gets a normal build.
  ...(process.env.BUILD_STANDALONE === '1' ? { output: 'standalone' } : {}),
};

export default nextConfig;
