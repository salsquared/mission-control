import { subscribeToEvents } from '@/lib/events';
import { requireSession } from '@/lib/auth-guards';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    // Tunnel + LAN both require a session — the stream carries cross-row
    // event ids (Application, Posting, Notification, etc.) and shouldn't be
    // publicly subscribable from any origin.
    const guard = await requireSession();
    if ('error' in guard) return guard.error;

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(': connected\n\n'));

            const unsub = subscribeToEvents((event) => {
                controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
                );
            });

            const heartbeat = setInterval(() => {
                controller.enqueue(encoder.encode(': heartbeat\n\n'));
            }, 30_000);

            req.signal.addEventListener('abort', () => {
                clearInterval(heartbeat);
                unsub();
                controller.close();
            });
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}
