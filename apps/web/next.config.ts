import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Do not advertise the framework in responses.
  poweredByHeader: false,
};

export default nextConfig;
