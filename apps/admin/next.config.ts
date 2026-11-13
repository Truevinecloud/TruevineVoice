import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  basePath: '/admin',
  allowedDevOrigins: ['127.0.0.1'],
};

export default nextConfig;
