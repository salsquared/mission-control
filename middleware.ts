import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
    const start = Date.now();

    // We only want to log /api routes
    if (request.nextUrl.pathname.startsWith('/api/')) {
        // Run logger asynchronously on response close to get latency (or at least close to it)
        console.info(`[API Request] ${request.method} ${request.nextUrl.pathname}`);
    }

    return NextResponse.next();
}

export const config = {
    matcher: '/api/:path*',
};
