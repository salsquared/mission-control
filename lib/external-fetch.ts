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

/**
 * fetch() with a canonical pre-flight log line. Drop-in for `fetch`.
 */
export async function loggedFetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const urlStr = typeof url === 'string' ? url : url.toString();
    console.info(`[EXTERNAL API] ${method} ${urlStr}`);
    return fetch(url, init);
}

/**
 * Companion for non-fetch external calls (rss-parser, googleapis SDK,
 * any library that wraps fetch internally). Call this immediately before
 * the SDK invocation so the timestamp on the log line matches the
 * actual upstream hit.
 */
export function logExternalCall(url: string, method: string = 'GET'): void {
    console.info(`[EXTERNAL API] ${method.toUpperCase()} ${url}`);
}
