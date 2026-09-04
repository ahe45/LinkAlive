const lanHost = process.env.LINKALIVE_ACCESS_HOST?.trim();
const configuredDevOrigins = (process.env.LINKALIVE_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedDevOrigins = [...new Set([lanHost, ...configuredDevOrigins].filter(Boolean))];
const internalApiBaseUrl = (process.env.INTERNAL_API_BASE_URL ?? 'http://127.0.0.1:4000').replace(
  /\/$/,
  '',
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  async rewrites() {
    return [
      {
        source: '/linkalive-api/:path*',
        destination: `${internalApiBaseUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
