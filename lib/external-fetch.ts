/**
 * Canonical fetch wrapper for external API calls.
 *
 * Every external-API call should go through `loggedFetch` (or, for SDKs
 * that wrap fetch internally, emit a manual `logExternalCall` immediately
 * before the call). The wrapper emits a log line of the form
 *
 *   [EXTERNAL API] <METHOD> <url>
 *
 * which `/api/system/fetcher-health` parses to derive the per-host
 * counts for the FetcherHealthCard. The old pattern of
 *
 *   console.info('[EXTERNAL API] Fetching from <ServiceName>...');
 *   const res = await fetch(url, opts);
 *
 * was silently invisible to that card because the log line carried no
 * hostname for the parser to extract.
 */

import { recordFetchOutcome } from './fetcher-health/store';

/**
 * Extract host for fetcher-health attribution; '' if unparseable (the store
 * skips empty hosts). Uses URL.host (NOT .hostname) so a non-default port is
 * kept — local services are real fetches and the port is what tells them apart
 * (e.g. `localhost:3103` = Pulsar). Standard ports are omitted by URL.host, so
 * public APIs stay clean (`api.greenhouse.io`, never `:443`).
 */
export function hostOf(urlStr: string): string {
    try {
        return new URL(urlStr).host;
    } catch {
        return '';
    }
}

/**
 * fetch() with a canonical pre-flight log line. Drop-in for `fetch`.
 *
 * Also records the real upstream OUTCOME to the fetcher-health store
 * (docs/fetcher-health-store.html): 2xx/3xx → `ok`, 4xx/5xx → `error`, a thrown
 * request → `error`. This is the single source of truth for upstream health —
 * the recording is best-effort and never alters the returned Response or thrown
 * error.
 */
export async function loggedFetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const urlStr = typeof url === 'string' ? url : url.toString();
    console.info(`[EXTERNAL API] ${method} ${urlStr}`);
    const host = hostOf(urlStr);
    try {
        const res = await fetch(url, init);
        recordFetchOutcome(host, res.status < 400 ? 'ok' : 'error');
        return res;
    } catch (e) {
        recordFetchOutcome(host, 'error');
        throw e;
    }
}

/**
 * Companion for non-fetch external calls (rss-parser, googleapis SDK,
 * any library that wraps fetch internally). Call this immediately before
 * the SDK invocation so the timestamp on the log line matches the
 * actual upstream hit.
 *
 * Records an `ok` attempt to the fetcher-health store — unlike loggedFetch, an
 * SDK marker can't observe the response, so it can't distinguish 2xx from 500.
 * Callers that want true failure attribution can record `error` themselves.
 */
export function logExternalCall(url: string, method: string = 'GET'): void {
    console.info(`[EXTERNAL API] ${method.toUpperCase()} ${url}`);
    recordFetchOutcome(hostOf(url), 'ok');
}
