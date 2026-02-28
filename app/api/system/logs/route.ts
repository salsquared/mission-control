import { NextResponse } from 'next/server';
import { getLogs, subscribeToLogs, LogEntry } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        start(controller) {
            // Send initial logs
            const initialLogs = getLogs();
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'initial', logs: initialLogs })}\n\n`));

            // Set up listener for new logs
            const listener = (log: LogEntry) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'new', log })}\n\n`));
            };

            const unsubscribe = subscribeToLogs(listener);

            // Keep connection alive with simple pings
            const pingInterval = setInterval(() => {
                controller.enqueue(encoder.encode(`:\n\n`));
            }, 10000);

            // Clean up when connection closes
            req.signal.addEventListener('abort', () => {
                clearInterval(pingInterval);
                unsubscribe();
                controller.close();
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
