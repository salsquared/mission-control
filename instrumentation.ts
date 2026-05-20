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

        const { subscribeToEvents } = await import('./lib/events');

        // Diagnose-and-drain shutdown handlers. Historical pm2.log shows
        // dozens of SIGINT-driven exits going back to 2026-05-15 with no
        // in-tree caller — likely something external (sleep/wake, an agent
        // running `pm2 restart`, or pm2-logrotate). Log the signal + a
        // trimmed stack so the next event tells us where it came from.
        const handleShutdown = (signal: string) => {
            const stack = new Error(`shutdown-${signal}`).stack
                ?.split('\n').slice(0, 8).join('\n');
            console.warn(`[SHUTDOWN] ${signal} received pid=${process.pid} uptime=${process.uptime().toFixed(1)}s\n${stack ?? '(no stack)'}`);
            stopPulsarRelay();
            const unsub = subscribeToEvents(() => {});
            unsub();
            setTimeout(() => {
                console.info(`[SHUTDOWN] Clean exit (signal=${signal}).`);
                process.exit(0);
            }, signal === 'SIGTERM' ? 5000 : 500);
        };
        process.on('SIGTERM', () => handleShutdown('SIGTERM'));
        process.on('SIGINT', () => handleShutdown('SIGINT'));
        process.on('SIGHUP', () => handleShutdown('SIGHUP'));

        process.on('uncaughtException', (err) => {
            console.error(`[UNCAUGHT_EXCEPTION] pid=${process.pid} uptime=${process.uptime().toFixed(1)}s ${err?.stack ?? err}`);
        });
        process.on('unhandledRejection', (reason) => {
            const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
            console.error(`[UNHANDLED_REJECTION] pid=${process.pid} uptime=${process.uptime().toFixed(1)}s ${msg}`);
        });
    }
}
