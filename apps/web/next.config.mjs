const lanHost = process.env.LINKALIVE_ACCESS_HOST?.trim();

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  ...(lanHost ? { allowedDevOrigins: [lanHost] } : {}),
  async rewrites() {
    return [
      {
        source: '/linkalive-api/:path*',
        destination: 'http://127.0.0.1:4000/:path*',
      },
    ];
  },
};

export default nextConfig;
