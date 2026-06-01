import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { requireSession } from '@/lib/auth-guards';
import { LOG_TIER, type LogSource, type LogTier } from '@/lib/logger';
import { readLogsWindow } from '@/lib/logs-store';

export const dynamic = 'force-dynamic';

// The web PM2 out.log differs by tier (prod = mission-control-out.log, dev =
// mission-control-dev-out.log). Pick by the serving process's tier so the dev
// viewer reads dev (OQ5 — the old hardcode always read the prod web file, so the
// dev tier's "load older" showed prod). PM2_LOG_PATH overrides for non-PM2 /
// test setups. See docs/scheduler-structured-logs.html.
function pm2LogPath(): string {
    const envPath = process.env.PM2_LOG_PATH;
    if (envPath) return envPath;
    const file = LOG_TIER === 'prod' ? 'mission-control-out.log' : 'mission-control-dev-out.log';
    return path.join(os.homedir(), '.pm2', 'logs', file);
}

type HistEntry = { ts: string; level: string; msg: string; source: LogSource; tier: LogTier };

export async function GET(req: NextRequest) {
    // Same data class as the live SSE log stream — never unauthenticated.
    const guard = await requireSession();
    if ('error' in guard) return guard.error;

    const { searchParams } = new URL(req.url);
    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');
    const levelParam = searchParams.get('level');

    const fromMs = fromParam ? new Date(fromParam).getTime() : 0;
    const toMs = toParam ? new Date(toParam).getTime() : Date.now();

    const entries: HistEntry[] = [];

    // --- Web rows: parse the (per-tier) PM2 out.log JSON-lines ---
    try {
        const content = await fs.readFile(pm2LogPath(), 'utf8');
        for (const line of content.split('\n')) {
            if (!line) continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed.ts && parsed.level && parsed.msg) {
                    entries.push({
                        ts: parsed.ts,
                        level: parsed.level,
                        msg: parsed.msg,
                        // Older lines predate the source/tier field — default to web/this tier.
                        source: (parsed.source as LogSource) ?? 'web',
                        tier: (parsed.tier as LogTier) ?? LOG_TIER,
                    });
                }
            } catch {
                // plain-text line (the human-readable twin, or pre-JSON logs) — skip
            }
        }
    } catch (err: any) {
        if (err.code !== 'ENOENT') {
            return NextResponse.json({ error: err.message }, { status: 500 });
        }
        // ENOENT → no web file yet; fall through with scheduler rows only.
    }

    // --- Scheduler rows: from data/logs.db (this tier), within the window ---
    const schedRows = await readLogsWindow(fromMs, toMs, LOG_TIER, 2000);
    for (const r of schedRows) {
        entries.push({
            ts: new Date(r.ts).toISOString(),
            level: r.level,
            msg: r.msg,
            source: r.source as LogSource,
            tier: r.tier as LogTier,
        });
    }

    // --- Merge: filter by window + level, sort chronologically, keep last 1000 ---
    const filtered = entries
        .filter(e => {
            const t = new Date(e.ts).getTime();
            if (t < fromMs || t > toMs) return false;
            if (levelParam && e.level !== levelParam) return false;
            return true;
        })
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .slice(-1000);

    return NextResponse.json({ logs: filtered, total: filtered.length });
}
