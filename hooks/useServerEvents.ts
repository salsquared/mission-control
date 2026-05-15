import { useEffect, useRef } from 'react';

export type ServerEventModel = 'Task' | 'Goal' | 'SavedPaper' | 'Application' | 'CalendarEvent' | 'Setting' | 'FinanceTick' | 'Cache' | 'Profile';

export function useServerEvents(model: ServerEventModel, onInvalidate: () => void) {
    const onInvalidateRef = useRef(onInvalidate);
    onInvalidateRef.current = onInvalidate;

    useEffect(() => {
        const es = new EventSource('/api/events');
        es.onmessage = (msg) => {
            try {
                const event = JSON.parse(msg.data);
                if (event.model === model) {
                    onInvalidateRef.current();
                }
            } catch { /* ignore malformed events */ }
        };
        es.onerror = () => es.close();
        return () => es.close();
    }, [model]);
}
