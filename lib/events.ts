// Server-Sent-Events fan-out (docs/multi-user-crew.html §2.8, OQ8a).
//
// WHY THIS IS A DISCRIMINATED UNION. Before the owner/crew work there was one
// flat `ServerEvent` with no user scope, and `broadcastEvent()` wrote to a
// single process-global Set — so `app/api/events/route.ts` handed every guarded
// client the whole firehose. Under multi-user that means crew receive the
// owner's row-change events and each other's: activity metadata plus row ids on
// the wire, and a spurious refetch per event per client.
//
// The scope therefore lives in the TYPE, not in a convention. `ModelName`
// splits into a user-scoped set (14 models, every one a per-user row) and a
// global set (`Cache`, `FinanceTick` — the only two, and neither is anybody's
// data), and the union makes the wrong pairing unrepresentable: an
// `Application` event cannot omit `userId`, and a `Cache` event cannot carry
// one. That co-variance is the point — it is what makes `tsc --noEmit`
// enumerate every unmigrated call site instead of letting a forgotten `userId`
// compile into a silent fan-out to every connected client.

/** Per-user rows. Events about these are delivered ONLY to their owner. */
export type UserModelName =
    | 'Task'
    | 'Goal'
    | 'SavedPaper'
    | 'Application'
    | 'CalendarEvent'
    | 'Setting'
    | 'Profile'
    | 'ProfileSnapshot'
    | 'Watchlist'
    | 'Posting'
    | 'Notification'
    | 'Contact'
    | 'GeneratedResume'
    | 'Canon';

/**
 * Instance-wide signals that belong to nobody. `Cache` is the process-memory
 * response cache (`lib/cache.ts`); `FinanceTick` is the Pulsar market-data
 * relay (`lib/pulsar-ws-relay.ts`) — public prices, identical for every viewer.
 * Adding a model here makes it visible to every connected client, so the bar is
 * "contains no user data at all", not "is convenient to fan out".
 */
export type GlobalModelName = 'Cache' | 'FinanceTick';

export type ModelName = UserModelName | GlobalModelName;

interface BaseServerEvent {
    action: 'upsert' | 'delete' | 'invalidate';
    /**
     * The changed row's id, when there is one. Advisory only — no consumer
     * reads it (see `hooks/useServerEvents.ts`, whose listeners are
     * `() => onInvalidate()`), so it must never be used to smuggle a user id.
     */
    id?: string;
    timestamp: number;
}

/** Delivered only to subscribers whose viewer id equals `userId`. */
export interface UserServerEvent extends BaseServerEvent {
    model: UserModelName;
    userId: string;
}

/**
 * Delivered to every subscriber. `userId?: never` is load-bearing: without it
 * a global event could carry a user id through a non-literal (a spread, a
 * variable), which would read as a scope that `broadcastEvent` deliberately
 * ignores.
 */
export interface GlobalServerEvent extends BaseServerEvent {
    model: GlobalModelName;
    userId?: never;
}

export type ServerEvent = UserServerEvent | GlobalServerEvent;

/**
 * The runtime half of the split. A `Record<GlobalModelName, true>` rather than
 * a `Set<string>` so `tsc` rejects both a missing key and a stray one — the
 * table cannot drift from the type it mirrors.
 */
const GLOBAL_MODELS: Record<GlobalModelName, true> = {
    Cache: true,
    FinanceTick: true,
};

export function isGlobalEvent(event: ServerEvent): event is GlobalServerEvent {
    return Object.prototype.hasOwnProperty.call(GLOBAL_MODELS, event.model);
}

type EventListener = (event: ServerEvent) => void;

interface Subscriber {
    /** The `User.id` of the viewer this SSE stream belongs to. */
    viewerId: string;
    listener: EventListener;
}

// Renamed from `__EVENT_LISTENERS` (a bare Set<EventListener>) when the
// registry gained a viewer id. The rename is deliberate: on an HMR reload the
// old key may still hold entries of the previous shape, and reusing it would
// mean iterating functions-as-subscribers. A fresh key orphans those (their
// streams reconnect) instead of crashing the loop.
const globalForEvents = global as unknown as {
    __EVENT_SUBSCRIBERS: Set<Subscriber>;
};

if (!globalForEvents.__EVENT_SUBSCRIBERS) {
    globalForEvents.__EVENT_SUBSCRIBERS = new Set();
}

export function broadcastEvent(event: ServerEvent) {
    // `null` = deliver to everyone. Anything else is the single viewer id
    // allowed to see this event.
    //
    // Fail-CLOSED on a malformed user event: if a JS caller (or a bad cast)
    // reaches here with a user-scoped model and no `userId`, `scopedTo` is
    // `undefined`, which equals no subscriber's `viewerId`, so the event is
    // dropped rather than fanned out. The compiler prevents this; the runtime
    // makes the failure mode "nobody sees it", never "everybody does".
    const scopedTo = isGlobalEvent(event) ? null : event.userId;

    for (const { viewerId, listener } of globalForEvents.__EVENT_SUBSCRIBERS) {
        if (scopedTo !== null && viewerId !== scopedTo) continue;
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

/**
 * @param viewerId the subscribing viewer's `User.id` — the filter key. Comes
 *   from the route guard, never from the client.
 */
export function subscribeToEvents(viewerId: string, listener: EventListener): () => void {
    const subscriber: Subscriber = { viewerId, listener };
    globalForEvents.__EVENT_SUBSCRIBERS.add(subscriber);
    return () => globalForEvents.__EVENT_SUBSCRIBERS.delete(subscriber);
}
