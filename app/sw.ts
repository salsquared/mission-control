import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

declare global {
    interface WorkerGlobalScope extends SerwistGlobalConfig {
        __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
    }
}

// Next.js tsconfig doesn't include WebWorker dom types by default but webworker is added now
declare const self: ServiceWorkerGlobalScope;

const isDev = process.env.NODE_ENV !== 'production';

const serwist = new Serwist({
    precacheEntries: self.__SW_MANIFEST,
    skipWaiting: !isDev,
    clientsClaim: !isDev,
    navigationPreload: !isDev,
    runtimeCaching: isDev ? [] : defaultCache,
});

serwist.addEventListeners();
