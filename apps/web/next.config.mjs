const apiBaseUrl = (
  process.env.SCION_API_BASE_URL ||
  process.env.NEXT_PUBLIC_SCION_API_BASE_URL ||
  "http://127.0.0.1:8000/api"
).replace(/\/$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiBaseUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
