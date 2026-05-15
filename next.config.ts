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
  serverExternalPackages: ['jose', 'googleapis', 'googleapis-common', 'pdf-parse', 'mammoth', 'puppeteer-core'],
  webpack: (config, { dev, isServer, nextRuntime }) => {
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

    // Edge runtime + client bundles can't resolve Node's `node:*` scheme imports.
    // When server-only code leaks into either bundle (e.g. via instrumentation.ts
    // dynamic imports that webpack still statically analyzes), the build fails
    // with "UnhandledSchemeError: Reading from 'node:assert'". Falling these
    // back to `false` makes webpack emit an empty module instead — the
    // gated-on-NEXT_RUNTIME code never actually runs in those bundles anyway.
    if (!isServer || nextRuntime === 'edge') {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        'node:assert': false,
        'node:async_hooks': false,
        'node:buffer': false,
        'node:child_process': false,
        'node:crypto': false,
        'node:dns': false,
        'node:events': false,
        'node:fs': false,
        'node:fs/promises': false,
        'node:http': false,
        'node:https': false,
        'node:net': false,
        'node:os': false,
        'node:path': false,
        'node:perf_hooks': false,
        'node:process': false,
        'node:querystring': false,
        'node:stream': false,
        'node:stream/web': false,
        'node:string_decoder': false,
        'node:tls': false,
        'node:url': false,
        'node:util': false,
        'node:worker_threads': false,
        'node:zlib': false,
      };
    }

    return config;
  },
};

export default withSerwist(nextConfig);

