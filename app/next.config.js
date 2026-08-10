/** @type {import('next').NextConfig} */
const isStaticExport = process.env.PARALLAX_STATIC_EXPORT === '1'

const nextConfig = {
  images: { unoptimized: true },
  output: isStaticExport ? 'export' : undefined,
  assetPrefix: isStaticExport ? './' : undefined,
  // `next dev` and `next build` cannot safely share one output directory. The
  // verification build uses .next-build so it never replaces chunks underneath a
  // running desktop renderer.
  distDir: process.env.PARALLAX_NEXT_DIST_DIR || '.next',
}

module.exports = nextConfig
