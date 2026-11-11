/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@susagent/shared'],
  reactStrictMode: false,
  // Several `next dev` instances in apps/web would clobber one shared .next; set NEXT_DIST_DIR per instance.
  distDir: process.env.NEXT_DIST_DIR || '.next',
};
export default nextConfig;
