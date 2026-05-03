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

