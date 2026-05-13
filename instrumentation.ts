export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { initLogger } = await import('./lib/logger');
        initLogger();

        // Cache pruning is owned by the mission-control-scheduler PM2 process
        // (scheduler/jobs/cache-prune.ts) — see MVP2 Phase E3.

        const { startPulsarRelay, stopPulsarRelay } = await import('./lib/pulsar-ws-relay');
        startPulsarRelay();

        const { clearRestartFlag } = await import('./lib/restart-guard');
        clearRestartFlag();

        // Graceful SIGTERM: give in-flight file writes up to 5 s to drain before exit.
        const { subscribeToEvents } = await import('./lib/events');
        process.on('SIGTERM', () => {
            console.info('[SHUTDOWN] SIGTERM received — draining writes...');
            // Close the Pulsar WS so the next process boot doesn't see a dangling
            // connection, and close all SSE event-bus listeners.
            stopPulsarRelay();
            const unsub = subscribeToEvents(() => {});
            unsub();
            setTimeout(() => {
                console.info('[SHUTDOWN] Clean exit.');
                process.exit(0);
            }, 5000);
        });
    }
}
