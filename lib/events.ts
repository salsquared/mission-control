export type ModelName = 'Task' | 'Goal' | 'SavedPaper' | 'Application' | 'CalendarEvent' | 'Setting' | 'FinanceTick' | 'Cache' | 'Profile' | 'ProfileSnapshot' | 'Watchlist' | 'Posting' | 'Notification' | 'Contact' | 'GeneratedResume';

export interface ServerEvent {
    model: ModelName;
    action: 'upsert' | 'delete' | 'invalidate';
    id?: string;
    timestamp: number;
}

type EventListener = (event: ServerEvent) => void;

const globalForEvents = global as unknown as {
    __EVENT_LISTENERS: Set<EventListener>;
};

if (!globalForEvents.__EVENT_LISTENERS) {
    globalForEvents.__EVENT_LISTENERS = new Set();
}

export function broadcastEvent(event: ServerEvent) {
    for (const listener of globalForEvents.__EVENT_LISTENERS) {
        try {
            listener(event);
        } catch (e) {
            // A throwing listener (e.g. an SSE client whose underlying
            // socket closed between subscribe and the next write) would
            // otherwise abort the for-loop and skip every listener that
            // comes after it in the Set. Trap + log so one dead client
            // can't blackhole broadcasts for the rest.
            console.warn('[events] listener threw during broadcast:', e);
        }
    }
}

export function subscribeToEvents(listener: EventListener): () => void {
    globalForEvents.__EVENT_LISTENERS.add(listener);
    return () => globalForEvents.__EVENT_LISTENERS.delete(listener);
}
