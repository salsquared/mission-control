import { broadcastEvent } from './events';

// Long-lived WebSocket client that subscribes to Pulsar's /ws/prices feed and
// fans `tick` messages into mission-control's SSE event bus as 'FinanceTick'
// events. FinanceView listens via useServerEvents and invalidates its TanStack
// query, so the UI updates within seconds of a Pulsar PriceTick insertion
// instead of waiting for the 5-min polling fallback.
//
// Reconnects with exponential backoff (1s → 30s cap) on drop. PULSAR_URL is
// reused — http(s):// is rewritten to ws(s):// and /ws/prices is appended.

const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30_000;
const ASSET_IDS = ['bitcoin', 'ethereum', 'solana'];

let currentSocket: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

function getWsUrl(): string | null {
    const httpUrl = process.env.PULSAR_URL;
    if (!httpUrl) return null;
    const wsBase = httpUrl.replace(/^https?:/, (m) => (m === 'https:' ? 'wss:' : 'ws:'));
    return `${wsBase}/ws/prices`;
}

function connect() {
    if (stopped) return;
    const url = getWsUrl();
    if (!url) {
        console.warn('[PULSAR WS] PULSAR_URL not set; relay disabled');
        return;
    }

    console.info(`[PULSAR WS] connecting to ${url}`);
    const socket = new WebSocket(url);
    currentSocket = socket;

    socket.addEventListener('open', () => {
        console.info('[PULSAR WS] connected');
        reconnectAttempts = 0;
        socket.send(JSON.stringify({ type: 'subscribe', assetIds: ASSET_IDS }));
    });

    socket.addEventListener('message', (event: MessageEvent) => {
        try {
            const data = typeof event.data === 'string' ? JSON.parse(event.data) : null;
            if (data?.type === 'tick' && typeof data.assetId === 'string') {
                broadcastEvent({
                    model: 'FinanceTick',
                    action: 'upsert',
                    id: data.assetId,
                    timestamp: Date.now(),
                });
            }
        } catch (e) {
            console.warn('[PULSAR WS] malformed message', e);
        }
    });

    socket.addEventListener('error', (e: Event) => {
        console.warn('[PULSAR WS] error event:', (e as any).message ?? '(no detail)');
        // 'error' is followed by 'close'; let close handle reconnect.
    });

    socket.addEventListener('close', () => {
        if (currentSocket === socket) currentSocket = null;
        if (stopped) return;
        const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts));
        reconnectAttempts++;
        console.info(`[PULSAR WS] reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
        reconnectTimer = setTimeout(connect, delay);
    });
}

export function startPulsarRelay() {
    stopped = false;
    connect();
}

export function stopPulsarRelay() {
    stopped = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (currentSocket) {
        try { currentSocket.close(); } catch { /* ignore */ }
        currentSocket = null;
    }
}
