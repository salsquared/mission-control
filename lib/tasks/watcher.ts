import { watch } from 'fs';
import { syncTasksFromFile } from './parser';
import { broadcastEvent } from '@/lib/events';
import { consumeSuppressFlag } from './regenerator';

function debounce(fn: () => void, ms: number) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(fn, ms);
    };
}

export function startFileWatcher(filePath: string) {
    const handler = debounce(async () => {
        if (consumeSuppressFlag()) return;
        console.info('[FILE WATCHER] docs/todo.md changed externally, syncing to DB');
        try {
            await syncTasksFromFile(filePath);
            broadcastEvent({ model: 'Task', action: 'invalidate', timestamp: Date.now() });
        } catch (e) {
            console.error('[FILE WATCHER] Sync failed:', e);
        }
    }, 500);

    watch(filePath, { persistent: false }, handler);
    console.info('[FILE WATCHER] Watching docs/todo.md for external edits');
}
