import { getLogs, subscribeToLogs, LogEntry, LOG_TIER } from '@/lib/logger';
import { readLogsSince, latestLogId, type LogRow } from '@/lib/logs-store';
import { requireSession } from '@/lib/auth-guards';

export const dynamic = 'force-dynamic';

// Scheduler log rows live in data/logs.db (the scheduler-only sink). Convert one
// to the LogEntry shape the in-app viewer renders; the id is namespaced so it
// never collides with a web ring-buffer id. See docs/scheduler-structured-logs.html.
function rowToEntry(r: LogRow): LogEntry {
    return {
        id: `sched-${r.id}`,
        timestamp: new Date(r.ts).toISOString(),
        level: r.level as LogEntry['level'],
        message: r.msg,
        source: r.source as LogEntry['source'],
        tier: r.tier as LogEntry['tier'],
    };
}

export async function GET(req: Request) {
    // The ring buffer captures every console.* call including Prisma query
    // logs (parameter values), posting URLs, etc. Never expose unauthenticated.
    const guard = await requireSession();
    if ('error' in guard) return guard.error;

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            const safeEnqueue = (chunk: string) => {
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    /* stream already closed (client disconnected mid-poll) */
                }
            };

            // Initial burst = the web process's in-memory ring (instant) PLUS a
            // tail of recent scheduler rows from data/logs.db (scoped to THIS
            // tier), merged + sorted by timestamp so the viewer opens with both
            // sources already interleaved.
            const webInitial = getLogs();
            const latestId = await latestLogId();
            const schedInitial = (await readLogsSince(Math.max(0, latestId - 50), LOG_TIER, 50)).map(rowToEntry);
            const initial = [...webInitial, ...schedInitial].sort(
                (a, b) => a.timestamp.localeCompare(b.timestamp),
            );
            safeEnqueue(`data: ${JSON.stringify({ type: 'initial', logs: initial })}\n\n`);

            // Web rows: instant via the in-process listener (unchanged path).
            const listener = (log: LogEntry) => {
                safeEnqueue(`data: ${JSON.stringify({ type: 'new', log })}\n\n`);
            };
            const unsubscribe = subscribeToLogs(listener);

            // Scheduler rows: near-live via a ~1s poll of data/logs.db past the
            // cursor (cross-process — SQLite has no push). Best-effort: a store
            // read failure just yields nothing this tick.
            let cursor = latestId;
            const pollInterval = setInterval(async () => {
                try {
                    const rows = await readLogsSince(cursor, LOG_TIER, 200);
                    for (const row of rows) {
                        if (row.id > cursor) cursor = row.id;
                        safeEnqueue(`data: ${JSON.stringify({ type: 'new', log: rowToEntry(row) })}\n\n`);
                    }
                } catch {
                    /* best-effort poll */
                }
            }, 1000);

            // Keep connection alive with simple pings
            const pingInterval = setInterval(() => {
                safeEnqueue(`:\n\n`);
            }, 10000);

            // Clean up when connection closes
            req.signal.addEventListener('abort', () => {
                clearInterval(pingInterval);
                clearInterval(pollInterval);
                unsubscribe();
                try {
                    controller.close();
                } catch {
                    /* already closed */
                }
            });
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache, no-transform',
        },
    });
}
