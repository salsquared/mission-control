import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// `[API Request]` logs run on every API call. In dev they fan out through
// the patched console + ring buffer + SSE log subscribers (Internal Systems
// dash) — and the dash itself polls /api/system + /api/notifications at
// 5s/60s intervals, so the log line drives further dash-render work. Prod
// keeps logging on (the in-app log viewer is the canonical observability
// surface per CLAUDE.md). DEBUG_VERBOSE_LOG=1 re-enables in dev.
const LOG_VERBOSE =
    process.env.NODE_ENV === 'production' || process.env.DEBUG_VERBOSE_LOG === '1';

export function proxy(request: NextRequest) {
    if (LOG_VERBOSE && request.nextUrl.pathname.startsWith('/api/')) {
        console.info(`[API Request] ${request.method} ${request.nextUrl.pathname}`);
    }

    return NextResponse.next();
}

export const config = {
    matcher: '/api/:path*',
};
