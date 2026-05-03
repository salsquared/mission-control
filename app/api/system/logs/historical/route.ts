import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

function pm2LogPath(): string {
    const envPath = process.env.PM2_LOG_PATH;
    if (envPath) return envPath;
    return path.join(os.homedir(), '.pm2', 'logs', 'mission-control-out.log');
}

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');
    const levelParam = searchParams.get('level');

    const logFile = pm2LogPath();

    try {
        const content = await fs.readFile(logFile, 'utf8');
        const rawLines = content.split('\n').filter(Boolean);

        // Parse JSON-lines; skip lines that aren't structured JSON
        const entries: { ts: string; level: string; msg: string }[] = [];
        for (const line of rawLines) {
            try {
                const parsed = JSON.parse(line);
                if (parsed.ts && parsed.level && parsed.msg) {
                    entries.push(parsed);
                }
            } catch {
                // plain text line from before JSON-line logging was enabled — skip
            }
        }

        // Apply filters
        const fromMs = fromParam ? new Date(fromParam).getTime() : 0;
        const toMs = toParam ? new Date(toParam).getTime() : Infinity;

        const filtered = entries
            .filter(e => {
                const t = new Date(e.ts).getTime();
                if (t < fromMs || t > toMs) return false;
                if (levelParam && e.level !== levelParam) return false;
                return true;
            })
            .slice(-1000); // last 1000 after filtering

        return NextResponse.json({ logs: filtered, total: filtered.length });
    } catch (err: any) {
        if (err.code === 'ENOENT') {
            return NextResponse.json({ logs: [], total: 0, note: 'PM2 log file not found' });
        }
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
