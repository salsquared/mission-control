export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { initLogger } = await import('./lib/logger');
        initLogger();

        // Cache pruning is owned by the mission-control-scheduler PM2 process
        // (scheduler/jobs/cache-prune.ts) — see MVP2 Phase E3.

        const { join } = await import('path');
        const { startFileWatcher } = await import('./lib/tasks/watcher');
        startFileWatcher(join(process.cwd(), 'docs', 'todo.md'));

        const { clearRestartFlag } = await import('./lib/restart-guard');
        clearRestartFlag();

        // Graceful SIGTERM: give in-flight file writes up to 5 s to drain before exit.
        const { subscribeToEvents } = await import('./lib/events');
        process.on('SIGTERM', () => {
            console.info('[SHUTDOWN] SIGTERM received — draining writes...');
            // Close all SSE event-bus listeners
            const unsub = subscribeToEvents(() => {});
            unsub();
            setTimeout(() => {
                console.info('[SHUTDOWN] Clean exit.');
                process.exit(0);
            }, 5000);
        });
    }
}
