import { toastStore } from './toast-store';

export async function fetcher<T = any>(url: string): Promise<T> {
    const res = await fetch(url);
    if (res.headers.get('X-Cache') === 'STALE-FALLBACK') {
        const route = new URL(url, 'http://localhost').pathname;
        toastStore.push({ message: `Stale data: ${route}`, type: 'warning' });
    }
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Fetch failed');
    }
    return res.json();
}
