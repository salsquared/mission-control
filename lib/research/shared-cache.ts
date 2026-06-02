/**
 * Cross-tier shared cache for the research routes (docs/arxiv-rate-limit-fix.html
 * Layer 1, OQ2/OQ3/OQ10).
 *
 * dev (:4101) and prod (:3101) each fetch arXiv / HuggingFace independently, so
 * every research key is pulled twice and the two tiers can burst-collide on the
 * shared IP. This adapter routes the 4 research routes through ONE shared SQLite
 * file (`data/research-cache.db`, both tiers open it) with cross-tier
 * single-flight, so a simultaneous miss fetches upstream exactly once.
 *
 * `withSharedCache()` is a sibling of lib/cache.ts:withCache — the GENERIC
 * withCache wrapper (every other cached route) is deliberately left untouched
 * (OQ10, zero blast radius). This wrapper keeps its own in-process L1 +
 * stale-fallback and delegates only the miss-path compute to the base's
 * compute-mediating getOrCompute (single-flight lives in the shared base).
 */
import { NextResponse } from "next/server";
import { createSharedCache, type GetOrComputeOpts } from "@/lib/shared-sqlite-cache";

const RESEARCH_CACHE_DEFAULT_PATH = "data/research-cache.db";

const base = createSharedCache({
    // Read lazily so a test can set RESEARCH_CACHE_PATH then _reset().
    resolvePath: () => process.env.RESEARCH_CACHE_PATH ?? RESEARCH_CACHE_DEFAULT_PATH,
    table: "research_cache",
    label: "research-cache",
});

/**
 * The compute-mediating store the wrapper drives. Exposed for the prune job,
 * tests, and any non-route caller that wants cross-tier single-flight.
 */
export const researchSharedStore = {
    getOrCompute<T>(
        key: string,
        ttlSeconds: number,
        compute: () => Promise<T>,
        opts?: { force?: boolean },
    ): Promise<T> {
        return base.getOrCompute(key, compute, { ttlSeconds, force: opts?.force });
    },
    invalidate: (key: string) => base.invalidate(key),
    prune: (doneCutoffMs: number, pendingCutoffMs: number) => base.prune(doneCutoffMs, pendingCutoffMs),
    stats: () => base.stats(),
    _reset: () => base._reset(),
    _seedPending: (key: string, reservedAtMs: number) => base._seedPending(key, reservedAtMs),
};

export type ResearchSharedStore = typeof researchSharedStore;

// ---------------------------------------------------------------------------
// withSharedCache — sibling of withCache (lib/cache.ts NOT touched, OQ10)
// ---------------------------------------------------------------------------

interface L1Entry {
    data: unknown;
    expiry: number;
}

// HMR-safe in-process state (mirrors lib/cache.ts).
const g = globalThis as unknown as {
    __researchSharedL1?: Map<string, L1Entry>;
    __researchSharedInFlight?: Map<string, Promise<unknown>>;
};
const L1: Map<string, L1Entry> = g.__researchSharedL1 ?? new Map();
const inFlight: Map<string, Promise<unknown>> = g.__researchSharedInFlight ?? new Map();
g.__researchSharedL1 = L1;
g.__researchSharedInFlight = inFlight;

const NO_STORE = "private, no-store, max-age=0";
const STALE_RETRY_MS = 60_000; // re-attempt a failed upstream after 60s (mirrors withCache)

function keyFor(req: Request): { key: string; isRefresh: boolean } {
    const url = new URL(req.url);
    const params = new URLSearchParams(url.search);
    const isRefresh = params.has("v"); // the ?v=… cache-buster forces a refresh
    if (isRefresh) params.delete("v");
    const qs = params.toString();
    return { key: url.pathname + (qs ? "?" + qs : ""), isRefresh };
}

function json(data: unknown, cache: string): NextResponse {
    return NextResponse.json(data, { headers: { "X-Cache": cache, "Cache-Control": NO_STORE } });
}

export interface WithSharedCacheOptions {
    ttlSeconds: number;
    store?: ResearchSharedStore;
    /** Upstream host this route ultimately calls (telemetry parity with withCache). */
    upstreamHost?: string;
    /**
     * Cold-cache graceful degradation. When the compute throws and there is no
     * stale entry to serve, this maps the error to a benign payload to return
     * (200, NOT cached — so the next request retries once upstream recovers).
     * Return `undefined` to keep the error propagating (→ 500). Used by the
     * research routes to serve `[]` on arXiv unavailability instead of a 500 +
     * error-log cascade. Returning undefined for unknown errors preserves the
     * surfacing of genuine bugs.
     */
    fallbackOnError?: (err: unknown) => unknown;
}

/**
 * Wrap a route handler so its miss-path compute runs through the cross-tier
 * shared store (single-flight). L1 + stale-fallback are per-tier (in-process),
 * exactly like withCache; only the upstream fetch is deduped across tiers.
 */
export function withSharedCache(
    handler: (req: Request) => Promise<NextResponse>,
    opts: WithSharedCacheOptions,
) {
    const store = opts.store ?? researchSharedStore;
    const { ttlSeconds, fallbackOnError } = opts;

    return async function (req: Request): Promise<NextResponse> {
        const { key, isRefresh } = keyFor(req);

        let stale: L1Entry | undefined;
        if (!isRefresh) {
            const e = L1.get(key);
            if (e) {
                if (Date.now() < e.expiry) return json(e.data, "HIT");
                stale = e; // expired — keep for stale-fallback if the refetch fails
            }
            // In-process dedup: share an in-flight compute with concurrent callers.
            const pending = inFlight.get(key);
            if (pending) {
                try {
                    return json(await pending, "HIT");
                } catch {
                    // The leader failed (e.g. arXiv cooldown). Fall through to our
                    // own attempt, which hits the same fast-fail + stale/empty
                    // fallback path below rather than 500-ing the follower.
                }
            }
        }

        // Miss-path compute: run the handler, only cache OK JSON. Throwing keeps
        // the store from caching errors AND lets the stale-fallback fire.
        const compute = async (): Promise<unknown> => {
            const res = await handler(req);
            const ct = res.headers.get("content-type") || "";
            if (!res.ok || !ct.includes("application/json")) {
                throw new Error(`research route returned non-cacheable response (status ${res.status})`);
            }
            return res.clone().json();
        };

        const work = store.getOrCompute<unknown>(key, ttlSeconds, compute, { force: isRefresh });
        if (!isRefresh) inFlight.set(key, work);

        let data: unknown;
        try {
            data = await work;
        } catch (err) {
            if (stale) {
                // Serve last-good with a short retry TTL so the UI doesn't freeze
                // on an upstream blip (e.g. arXiv 429). Mirrors withCache.
                L1.set(key, { data: stale.data, expiry: Date.now() + STALE_RETRY_MS });
                return json(stale.data, "STALE-FALLBACK");
            }
            // Cold cache + a known-degradable error (e.g. arXiv unavailable):
            // serve a benign payload WITHOUT caching it, so the next request
            // retries once upstream recovers. Quiet — not a 500, not an error.
            const fb = fallbackOnError?.(err);
            if (fb !== undefined) {
                console.info(`[research-shared] ${key} upstream unavailable; serving empty fallback`);
                return json(fb, "EMPTY-FALLBACK");
            }
            throw err;
        } finally {
            if (!isRefresh) inFlight.delete(key);
        }

        L1.set(key, { data, expiry: Date.now() + ttlSeconds * 1000 });
        return json(data, "MISS");
    };
}

// Re-export for the prune job / tests without leaking the base type everywhere.
export type { GetOrComputeOpts };
