import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { withCache } from '@/lib/cache';
import { requireSession } from '@/lib/auth-guards';

export const dynamic = 'force-dynamic';

type HealthEntry = { ok: number; fallback: number; broken: number };
type HealthMap = Record<string, HealthEntry>;

function pm2LogPath(): string {
    const envPath = process.env.PM2_LOG_PATH;
    if (envPath) return envPath;
    return path.join(os.homedir(), '.pm2', 'logs', 'mission-control-out.log');
}

// Mirror of the client-side parser previously in InternalView.tsx. Same shape:
// extracts the upstream host from a [CACHE …] or [EXTERNAL API] log message.
function parseHostFromLog(message: string): string | null {
    const cache = message.match(/\[CACHE (?:HIT|HIT L2|MISS|FALLBACK)\] (\S+)/);
    if (cache) {
        const token = cache[1];
        if (!token.startsWith('/')) return token;
    }
    const ext = message.match(/\[EXTERNAL API\].*?(\S+\.\S+)/);
    if (ext) {
        try { return new URL(ext[1].startsWith('http') ? ext[1] : 'https://' + ext[1]).hostname; } catch { return ext[1]; }
    }
    return null;
}

async function getHandler(req: Request): Promise<NextResponse> {
    void req; // signature dictated by withCache; req is unused — handler reads from the PM2 log file
    const guard = await requireSession();
    if ('error' in guard && guard.error) return guard.error;

    const logFile = pm2LogPath();
    const cutoff = Date.now() - 60 * 60 * 1000;
    const map: HealthMap = {};

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
            if (new Date(ts).getTime() < cutoff) continue;

            const isFallback = msg.startsWith('[CACHE FALLBACK]');
            const isBroken = msg.startsWith('[SCRAPER BROKEN]');
            const isOk = msg.startsWith('[EXTERNAL API]') || msg.startsWith('[CACHE HIT]') || msg.startsWith('[CACHE MISS]');
            if (!isFallback && !isBroken && !isOk) continue;

            const host = parseHostFromLog(msg);
            if (!host) continue;
            if (!map[host]) map[host] = { ok: 0, fallback: 0, broken: 0 };
            if (isFallback) map[host].fallback++;
            else if (isBroken) map[host].broken++;
            else map[host].ok++;
        }
        return NextResponse.json({ health: map, computedAt: new Date().toISOString() });
    } catch (err: unknown) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'ENOENT') {
            return NextResponse.json({ health: {}, computedAt: new Date().toISOString(), note: 'PM2 log file not found' });
        }
        const message = err instanceof Error ? err.message : 'failed';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

const cachedGET = withCache(getHandler, 3600);
export const GET = async (req: Request) => cachedGET(req);
