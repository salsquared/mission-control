import { NextResponse } from 'next/server';
import { requireLocalOrSession } from '@/lib/auth-guards';
import { invalidateCacheKey, invalidateCacheByPrefix } from '@/lib/cache';
import { CacheInvalidatePostSchema } from '@/lib/schemas/cache';

export async function POST(req: Request) {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;

    try {
        const parsed = CacheInvalidatePostSchema.safeParse(await req.json());
        if (!parsed.success) {
            return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
        }

        if (parsed.data.key !== undefined) {
            const had = invalidateCacheKey(parsed.data.key);
            return NextResponse.json({ success: true, invalidated: had ? 1 : 0 });
        }

        const count = invalidateCacheByPrefix(parsed.data.prefix!);
        return NextResponse.json({ success: true, invalidated: count });
    } catch (e: any) {
        console.error('[CACHE INVALIDATE] failed:', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
