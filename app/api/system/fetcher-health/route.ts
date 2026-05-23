import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { withCache } from '@/lib/cache';
import { requireSession } from '@/lib/auth-guards';

export const dynamic = 'force-dynamic';

type HealthEntry = { ok: number; fallback: number; broken: number };
type HealthMap = Record<string, HealthEntry>;
type WindowKey = '1h' | '6h' | '1d';

const WINDOW_MS: Record<WindowKey, number> = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
};

function pm2LogPath(): string {
    const envPath = process.env.PM2_LOG_PATH;
    if (envPath) return envPath;
    // Two mission-control processes write to two PM2 log files
    // (mission-control-out.log for prod, mission-control-dev-out.log for
    // dev). Picking the wrong one means this route reports the *other*
    // tier's fetcher activity — silently empty if that tier is idle. PM2
    // sets NODE_ENV per process in ecosystem.config.cjs, so we route off
    // that.
    const isDev = process.env.NODE_ENV === 'development';
    const file = isDev ? 'mission-control-dev-out.log' : 'mission-control-out.log';
    return path.join(os.homedir(), '.pm2', 'logs', file);
}

// Extracts the upstream host from a [CACHE …] or [EXTERNAL API] log message.
// Previously used the looser regex `(\S+\.\S+)` which matched anything with a
// dot — including trailing ellipses on truncated descriptive logs
// (`papers...`, `api...`) and arXiv paper IDs (`2506.13777`), all of which
// then appeared as bogus "hosts" in the FetcherHealthCard.
function parseHostFromLog(message: string): string | null {
    const cache = message.match(/\[CACHE (?:HIT|HIT L2|MISS|FALLBACK)\] (\S+)/);
    if (cache) {
        const token = cache[1];
        if (!token.startsWith('/')) return token;
    }
    // Prefer an explicit URL — most fetch logs include the full target.
    const url = message.match(/\[EXTERNAL API\][^\n]*?(https?:\/\/\S+)/);
    if (url) {
        try { return new URL(url[1]).hostname; } catch { /* fall through */ }
    }
    // Fall back to a hostname-like token: alpha-bearing TLD of ≥2 chars, no
    // trailing dots. Rules out `papers...` / `api...` / numeric paper IDs.
    const host = message.match(/\[EXTERNAL API\][^\n]*?\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/i);
    if (host) return host[1].toLowerCase();
    return null;
}

async function getHandler(req: Request): Promise<NextResponse> {
    void req; // signature dictated by withCache; req is unused — handler reads from the PM2 log file
    const logFile = pm2LogPath();
    const now = Date.now();
    const cutoffs: Record<WindowKey, number> = {
        '1h': now - WINDOW_MS['1h'],
        '6h': now - WINDOW_MS['6h'],
        '1d': now - WINDOW_MS['1d'],
    };
    const map: HealthMap = {};
    const totals: Record<WindowKey, HealthEntry> = {
        '1h': { ok: 0, fallback: 0, broken: 0 },
        '6h': { ok: 0, fallback: 0, broken: 0 },
        '1d': { ok: 0, fallback: 0, broken: 0 },
    };

    try {
        const content = await fs.readFile(logFile, 'utf8');
        const rawLines = content.split('\n');
        for (const line of rawLines) {
            if (!line) continue;
            let ts: string; let msg: string;
            try {
                const parsed = JSON.parse(line);
                if (!parsed.ts || !parsed.msg) continue;
                ts = parsed.ts; msg = parsed.msg;
            } catch { continue; }
            const tsMs = new Date(ts).getTime();
            if (tsMs < cutoffs['1d']) continue;

            const isFallback = msg.startsWith('[CACHE FALLBACK]');
            const isBroken = msg.startsWith('[SCRAPER BROKEN]');
            const isOk = msg.startsWith('[EXTERNAL API]') || msg.startsWith('[CACHE HIT]') || msg.startsWith('[CACHE MISS]');
            if (!isFallback && !isBroken && !isOk) continue;

            const host = parseHostFromLog(msg);
            if (!host) continue;
            const kind: keyof HealthEntry = isFallback ? 'fallback' : isBroken ? 'broken' : 'ok';

            if (tsMs >= cutoffs['1h']) {
                if (!map[host]) map[host] = { ok: 0, fallback: 0, broken: 0 };
                map[host][kind]++;
            }
            for (const w of ['1h', '6h', '1d'] as WindowKey[]) {
                if (tsMs >= cutoffs[w]) totals[w][kind]++;
            }
        }
        return NextResponse.json({ health: map, totals, computedAt: new Date().toISOString() });
    } catch (err: unknown) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'ENOENT') {
            return NextResponse.json({ health: {}, totals, computedAt: new Date().toISOString(), note: 'PM2 log file not found' });
        }
        const message = err instanceof Error ? err.message : 'failed';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

const cachedGET = withCache(getHandler, 3600);
export const GET = async (req: Request) => {
    // Auth lives outside withCache — otherwise the cached response would
    // be served to unauthenticated callers once the first authenticated
    // hit populated the entry. Matches the pattern used by /api/finance,
    // /api/company-news, etc.
    const guard = await requireSession();
    if ('error' in guard) return guard.error;
    return cachedGET(req);
};
