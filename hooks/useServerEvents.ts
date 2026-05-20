import { useEffect, useRef } from 'react';

export type ServerEventModel = 'Task' | 'Goal' | 'SavedPaper' | 'Application' | 'CalendarEvent' | 'Setting' | 'FinanceTick' | 'Cache' | 'Profile' | 'Watchlist' | 'Posting' | 'Notification';

// Single shared EventSource per browser tab. Every useServerEvents call adds
// itself to an in-memory subscriber map and the EventSource is opened on the
// first subscription, closed when the last one unsubscribes. Before this
// change each hook call opened its own connection, so e.g. ApplicationsView
// alone (`Application` + `CalendarEvent`) plus the always-mounted
// CacheInvalidationListener + NotificationBell held 4 streams per tab in the
// dev process — see docs/perf-profile.md fix 3.
type Listener = (event: { model: ServerEventModel; action?: string; id?: string }) => void;

const listenersByModel = new Map<ServerEventModel, Set<Listener>>();
let activeSource: EventSource | null = null;
let totalSubs = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function openSource() {
    if (activeSource || typeof window === 'undefined') return;
    const es = new EventSource('/api/events');
    es.onmessage = (msg) => {
        try {
            const event = JSON.parse(msg.data);
            const set = listenersByModel.get(event.model);
            if (!set) return;
            for (const fn of set) fn(event);
        } catch { /* ignore malformed events */ }
    };
    es.onerror = () => {
        // The server SSE handler closes streams at ~60s intervals (Next.js
        // ReadableStream timeout). The browser surfaces that as an error
        // event; treat it as a normal reconnect rather than tearing the
        // shared instance down for the surviving subscribers.
        es.close();
        if (activeSource === es) activeSource = null;
        if (totalSubs > 0 && reconnectTimer == null) {
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                openSource();
            }, 1000);
        }
    };
    activeSource = es;
}

function closeSourceIfIdle() {
    if (totalSubs === 0 && activeSource) {
        activeSource.close();
        activeSource = null;
    }
    if (totalSubs === 0 && reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

export function useServerEvents(model: ServerEventModel, onInvalidate: () => void) {
    const onInvalidateRef = useRef(onInvalidate);
    onInvalidateRef.current = onInvalidate;

    useEffect(() => {
        const listener: Listener = () => onInvalidateRef.current();
        let set = listenersByModel.get(model);
        if (!set) {
            set = new Set();
            listenersByModel.set(model, set);
        }
        set.add(listener);
        totalSubs += 1;
        openSource();

        return () => {
            const s = listenersByModel.get(model);
            if (s) {
                s.delete(listener);
                if (s.size === 0) listenersByModel.delete(model);
            }
            totalSubs = Math.max(0, totalSubs - 1);
            closeSourceIfIdle();
        };
    }, [model]);
}
