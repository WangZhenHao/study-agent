import type { NextConfig } from 'next';

function parseOrigins(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((origin) => {
      try {
        return new URL(origin.trim()).hostname;
      } catch {
        return origin
          .trim()
          .replace(/^https?:\/\//, '')
          .split(':')[0]
          .split('/')[0];
      }
    })
    .filter(Boolean);
}

const nextConfig: NextConfig = {
  output: 'standalone',
  basePath: process.env.PREVIEW_BASE_PATH || '',
  // Next.js 16 blocks cross-origin HMR WebSocket unless origin is allowed.
  // Required when preview runs on 127.0.0.1:PORT and parent page is on another origin.
  allowedDevOrigins: [
    'localhost',
    '0.0.0.0',
    ...parseOrigins(process.env.PREVIEW_WEBSITE_HOST),
  ],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },
};

export default nextConfig;
