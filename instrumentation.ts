import path from 'path';

export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { initLogger } = await import('./lib/logger');
        initLogger();

        const { pruneExpiredCache } = await import('./lib/cache');
        setInterval(() => { pruneExpiredCache().catch(console.error); }, 5 * 60 * 1000);

        const { startFileWatcher } = await import('./lib/tasks/watcher');
        startFileWatcher(path.join(process.cwd(), 'docs', 'todo.md'));
    }
}
