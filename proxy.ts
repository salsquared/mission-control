import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
    if (request.nextUrl.pathname.startsWith('/api/')) {
        console.info(`[API Request] ${request.method} ${request.nextUrl.pathname}`);
    }

    return NextResponse.next();
}

export const config = {
    matcher: '/api/:path*',
};
