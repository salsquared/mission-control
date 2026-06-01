import { NextResponse } from 'next/server';
import { withCache } from '@/lib/cache';
import { requireSession } from '@/lib/auth-guards';
import { readFetcherHealth, currentTier, type Source, type WindowKey } from '@/lib/fetcher-health/store';

export const dynamic = 'force-dynamic';

// Fetcher health now reads a dedicated per-tier SQLite store written at the
// fetch chokepoints (loggedFetch / serveStale / ScraperBrokenError), NOT the
// PM2 log file — the old regex-the-log approach only saw the web process's
// fetches (never the scheduler's crawls) and was fragile to log-format drift.
// Full design + rationale: docs/archive/fetcher-health-store.html.

const VALID_SOURCES = new Set<Source>(['web', 'scheduler']);
const VALID_WINDOWS = new Set<WindowKey>(['1h', '6h', '1d']);

async function getHandler(req: Request): Promise<NextResponse> {
    const url = new URL(req.url);
    // Optional `?source=web|scheduler` scopes to one process class (the card's
    // All/Web/Scheduler filter); `?window=1h|6h|1d` drives the per-host table.
    const sourceParam = url.searchParams.get('source');
    const windowParam = url.searchParams.get('window');
    const source = sourceParam && VALID_SOURCES.has(sourceParam as Source) ? (sourceParam as Source) : undefined;
    const window: WindowKey = windowParam && VALID_WINDOWS.has(windowParam as WindowKey) ? (windowParam as WindowKey) : '1d';

    // Per-tier (OQ5): the card shows only the tier it's served from.
    const { health, totals } = await readFetcherHealth(Date.now(), currentTier(), source, window);
    return NextResponse.json({ health, totals, computedAt: new Date().toISOString() });
}

// Near-live (OQ10): the store read is <1ms, so the old 1h cache (needed only to
// avoid re-parsing a multi-MB log) drops to 30s.
const cachedGET = withCache(getHandler, 30);
export const GET = async (req: Request) => {
    // Auth lives outside withCache — otherwise the cached response would be
    // served to unauthenticated callers once the first authenticated hit
    // populated the entry. Matches /api/finance, /api/company-news, etc.
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    return cachedGET(req);
};
