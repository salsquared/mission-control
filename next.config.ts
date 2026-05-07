import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const isDev = process.env.NODE_ENV !== 'production';

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  disable: isDev,
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: isDev ? '.next-dev' : '.next',
  // Server-only packages that should not be webpack-bundled. Without this,
  // webpack tries to resolve their `node:*` scheme imports (e.g. `node:assert`
  // pulled in transitively via undici) and fails the build. These are loaded
  // via Node's runtime require instead. `jose` was the most recent addition
  // (Phase A1 OIDC); `googleapis` was already pulling undici in.
  serverExternalPackages: ['jose', 'googleapis', 'googleapis-common'],
  webpack: (config, { dev, isServer }) => {
    if (dev && !isServer) {
      let ignored = [];
      if (Array.isArray(config.watchOptions?.ignored)) {
        ignored = config.watchOptions.ignored.filter((x: any) => typeof x === 'string');
      } else if (typeof config.watchOptions?.ignored === 'string') {
        ignored = [config.watchOptions.ignored];
      } else {
        ignored = ['**/node_modules/**']; // Fallback default
      }
      
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          ...ignored,
          '**/.next-dev/**',
          '**/prisma/*.db',
          '**/prisma/*.db-journal',
          '**/public/sw.js',
          '**/public/sw.js.map',
        ],
      };
    }
    return config;
  },
};

export default withSerwist(nextConfig);

