import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth-guards';
import { DEFAULT_HISTORY_DAYS, readSatelliteCountHistory } from '@/lib/satellites/count-history';

// Deliberately NOT wrapped in withCache and deliberately separate from
// /api/space/satellites. That route is a 6h-cached proxy for a live Celestrak
// fetch; this one is a local SQLite read of a slow daily series. Folding the
// history into the cached payload would freeze it for up to 6h — and worse, the
// "Celestrak data unchanged" fallback there can serve a payload captured days
// ago, which would ship a history missing every day recorded since.
export const dynamic = 'force-dynamic';

const MAX_DAYS = 3650;

export const GET = async (req: Request) => {
    const guard = await requireOwner();
    if ('error' in guard) return guard.error;

    const raw = Number(new URL(req.url).searchParams.get('days'));
    const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), MAX_DAYS) : DEFAULT_HISTORY_DAYS;

    const history = await readSatelliteCountHistory(days);
    return NextResponse.json({ history, days });
};
