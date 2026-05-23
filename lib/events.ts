export type ModelName = 'Task' | 'Goal' | 'SavedPaper' | 'Application' | 'CalendarEvent' | 'Setting' | 'FinanceTick' | 'Cache' | 'Profile' | 'ProfileSnapshot' | 'Watchlist' | 'Posting' | 'Notification' | 'Contact';

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
        listener(event);
    }
}

export function subscribeToEvents(listener: EventListener): () => void {
    globalForEvents.__EVENT_LISTENERS.add(listener);
    return () => globalForEvents.__EVENT_LISTENERS.delete(listener);
}
