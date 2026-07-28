/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // Self-contained server bundle in .next/standalone — required by web/Dockerfile
  // (docker compose --profile full) and harmless on Vercel, which ignores it.
  output: 'standalone',
};

export default nextConfig;
