import { subscribeToEvents } from '@/lib/events';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
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
