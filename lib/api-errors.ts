// Client-safe classifiers for the STRUCTURED error bodies a few API routes
// return — the fields `jsonFetch` would otherwise throw away.
//
// Two error shapes carry a machine-readable handle worth branching on instead
// of sniffing prose (docs/multi-user-crew.html, tasks P2.5 / P2.6 rendered by
// P3.6):
//
//   429 { code: "AI_QUOTA_EXCEEDED", stage: "ai-quota", used, limit, error }
//       The per-crew-member daily AI credit cap. Built in exactly ONE place —
//       `lib/ai/quota.ts:aiQuotaExceededResponse` — so all seven gated routes
//       (resumes · resumes/specialize · profile/bullets/assist ·
//       profile/tagline/draft · profile/import · discovery/suggest ·
//       watchlists/[id]/run) emit a byte-identical body and the UI has exactly
//       one shape to render.
//
//   400 { reason: "watchlist-limit", limit, current, error }
//       The per-crew-member watchlist cap (`app/api/watchlists/route.ts`).
//
// NOTHING SERVER-SIDE MAY BE IMPORTED HERE — this module is pulled into client
// components. That is why the constants are re-declared rather than imported
// from `lib/ai/quota.ts`: the server half imports `next/server` and Prisma, so
// it can never be the source for a browser bundle.
//
// THE COPY IS ALWAYS THE SERVER'S OWN `error` SENTENCE, VERBATIM. It is already
// user-ready ("Daily AI limit reached — you've used 3 of 20 today. Resets at
// 00:00 UTC.") and re-deriving it from `used`/`limit` client-side would put the
// same user-facing sentence in two places and let them drift — the exact thing
// the single-builder server helper exists to prevent. `used` / `limit` are
// exposed for callers that want to do more than print the sentence, not so the
// sentence can be rebuilt. The `message` fallbacks below fire only if a body
// somehow arrives with the code but no prose.

/**
 * Error thrown by `lib/api-client.ts:jsonFetch` on a non-2xx response.
 *
 * STRICTLY ADDITIVE. `message` is still exactly what `new Error(err.error)`
 * produced before, so every existing `err instanceof Error ? err.message : …`
 * caller behaves identically — nothing about jsonFetch's contract changed for
 * them. What is new is that the HTTP status and the parsed error body ride
 * along, so a caller that needs a machine-readable handle can branch on one
 * (`aiQuotaNotice` below) rather than string-matching prose.
 *
 * This does NOT supersede the `account.get` bypass documented in
 * `lib/api-client.ts`: `hooks/useAccount.ts` has to tell 401 from 403 before
 * any body is parsed and reads a `detail` field this module does not interpret.
 * Leave that hook on its own fetch.
 */
export class ApiError extends Error {
    readonly status: number;
    /** The parsed JSON error body, or `{}` when the response was not JSON. */
    readonly body: Record<string, unknown>;

    constructor(message: string, status: number, body: Record<string, unknown>) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }
}

/** The `code` field on the daily-AI-credit 429. Mirrors `lib/ai/quota.ts`. */
export const AI_QUOTA_CODE = 'AI_QUOTA_EXCEEDED';

/** The `reason` field on the watchlist-cap 400. Mirrors `app/api/watchlists/route.ts`. */
export const WATCHLIST_LIMIT_REASON = 'watchlist-limit';

export interface AiQuotaNotice {
    /** Credits spent today. `used <= limit` is guaranteed server-side. */
    used: number;
    /** The crew member's daily allowance (`CREW_AI_DAILY_LIMIT`). */
    limit: number;
    /** Ready-to-render sentence — render verbatim, do not decorate. */
    message: string;
}

export interface WatchlistLimitNotice {
    limit: number;
    current: number;
    /** Ready-to-render sentence — render verbatim, do not decorate. */
    message: string;
}

/**
 * Unwrap whatever a call site is holding down to a plain error body.
 *
 * Bare-`fetch` call sites already have the parsed JSON, so they pass it
 * straight in; `api.*` call sites pass the caught `ApiError` and we reach
 * through to `.body`. One entry point keeps both styles rendering identically.
 */
function errorBody(source: unknown): Record<string, unknown> | null {
    if (source instanceof ApiError) return source.body;
    if (source && typeof source === 'object') return source as Record<string, unknown>;
    return null;
}

function finiteNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function prose(body: Record<string, unknown>): string | null {
    return typeof body.error === 'string' && body.error.trim() !== '' ? body.error : null;
}

/**
 * Classify a caught error / parsed error body as the daily-AI-credit 429.
 *
 * Returns `null` for anything else, so the caller's existing failure path is
 * untouched. Accepts either a parsed body (bare `fetch` sites) or a thrown
 * `ApiError` (`api.*` sites).
 */
export function aiQuotaNotice(source: unknown): AiQuotaNotice | null {
    const body = errorBody(source);
    if (!body || body.code !== AI_QUOTA_CODE) return null;
    const used = finiteNumber(body.used);
    const limit = finiteNumber(body.limit);
    return {
        used,
        limit,
        message:
            prose(body) ??
            `Daily AI limit reached — you've used ${used} of ${limit} generations today.`,
    };
}

/** Classify a caught error / parsed error body as the watchlist-cap 400. */
export function watchlistLimitNotice(source: unknown): WatchlistLimitNotice | null {
    const body = errorBody(source);
    if (!body || body.reason !== WATCHLIST_LIMIT_REASON) return null;
    const limit = finiteNumber(body.limit);
    const current = finiteNumber(body.current);
    return {
        limit,
        current,
        message:
            prose(body) ??
            `Watchlist limit reached — you can have at most ${limit} (you have ${current}). ` +
            `Delete one to add another.`,
    };
}

/**
 * First notice among a `Promise.allSettled` batch's rejections.
 *
 * Fan-out call sites (run a whole Find-Roles group, add several watchlists at
 * once) reduce their rejections to a list of NAMES and drop every message. At a
 * cap that is the worst possible summary: every member failed for the same
 * reason and the user is told only which ones. One notice explains the batch,
 * so pulling the first match out is enough.
 */
export function firstRejectionNotice<T>(
    results: readonly PromiseSettledResult<unknown>[],
    classify: (source: unknown) => T | null,
): T | null {
    for (const result of results) {
        if (result.status !== 'rejected') continue;
        const notice = classify(result.reason);
        if (notice) return notice;
    }
    return null;
}
