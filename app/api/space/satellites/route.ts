import { NextResponse } from 'next/server';
import { withCache, readCachedDataIgnoringExpiry } from '../../../../lib/cache';
import { requireLocalOrSession } from '@/lib/auth-guards';
import { loggedFetch } from '@/lib/external-fetch';

const UPSTREAM_HOST = 'celestrak.org';
const CACHE_KEY = '/api/space/satellites';

// Celestrak's GP=active updates ~every 2h, but their 403 "data has not updated
// since your last successful download" gate is per-IP and our dev (:4101) +
// prod (:3101) tiers share an outbound IP — so re-fetching every 2h on either
// tier almost always trips the other's window. The active-satellite total
// changes by a handful day-over-day; 6h is plenty fresh for the dashboard
// readout and cuts our Celestrak traffic by ~3x.
const SATELLITE_TTL_SECONDS = 21600;
export const revalidate = 21600;

async function getHandler() {
    try {
        const res = await loggedFetch(
            "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json",
            {
                headers: {
                    'User-Agent': 'mission-control/1.0 (salsalcedo4321@gmail.com)',
                },
            }
        );

        if (!res.ok) {
            // Celestrak returns 403 with body "GP data has not updated since your last successful
            // download of GROUP=active at <UTC timestamp>. Data is updated once every 2 hours." when
            // we re-request unchanged data. That's not a punitive rate-limit — they're telling us
            // our prior payload is still current. Serve the last cached entry (ignoring TTL expiry)
            // so the dashboard doesn't break on a cold restart. If nothing is cached anywhere
            // (worst-case: first-ever fetch after migrating prod to sqlite L2), return a structured
            // 503 with Retry-After so the client backs off cleanly instead of looking like a crash.
            const body = await res.text().catch(() => '');
            if (res.status === 403 && body.includes('has not updated')) {
                const lastKnown = await readCachedDataIgnoringExpiry(CACHE_KEY);
                if (lastKnown) {
                    console.info('[EXTERNAL API] Celestrak: data unchanged, serving last-known payload');
                    return NextResponse.json(lastKnown, { headers: { 'X-Cache': 'CELESTRAK-UNCHANGED' } });
                }
                const lastSuccessMatch = body.match(/at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC/);
                const nextRefreshSec = lastSuccessMatch
                    ? Math.max(60, Math.ceil((new Date(lastSuccessMatch[1] + 'Z').getTime() + 2 * 3600 * 1000 - Date.now()) / 1000))
                    : 1800;
                console.warn(`[EXTERNAL API] Celestrak: data unchanged, no prior payload cached — retry in ~${nextRefreshSec}s`);
                return NextResponse.json(
                    { error: 'Celestrak data unchanged since last successful download; no cached fallback available yet.', retryAfterSeconds: nextRefreshSec },
                    { status: 503, headers: { 'Retry-After': String(nextRefreshSec), 'X-Cache': 'CELESTRAK-LOCKED' } }
                );
            }
            throw new Error(`Failed to fetch active satellites: ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        const orbits = { LEO: 0, MEO: 0, GEO: 0, SSO: 0, other: 0 };
        let starlink = 0;
        let oneweb = 0;

        for (const sat of data) {
            if (sat.OBJECT_NAME) {
                if (sat.OBJECT_NAME.includes("STARLINK")) {
                    starlink++;
                } else if (sat.OBJECT_NAME.includes("ONEWEB")) {
                    oneweb++;
                }
            }

            const mm = sat.MEAN_MOTION;
            const inc = sat.INCLINATION;
            const ecc = sat.ECCENTRICITY;

            // Simplified orbital classification based on mean motion and inclination
            if (mm >= 11.25) {
                // Mostly LEO
                // SSO is a specific subset: inclination ~95-105 deg and nearly circular
                if (inc >= 95 && inc <= 105 && ecc < 0.1) {
                    orbits.SSO++;
                } else {
                    orbits.LEO++;
                }
            } else if (mm > 0.99 && mm < 1.05 && ecc < 0.1) {
                // Geosynchronous / Geostationary
                orbits.GEO++;
            } else if (mm >= 1.05 && mm < 11.25) {
                // Medium Earth Orbit
                orbits.MEO++;
            } else {
                // HEO or other
                orbits.other++;
            }
        }

        return NextResponse.json({
            total_active: data.length,
            orbits,
            constellations: {
                starlink,
                oneweb,
            },
            updated_at: new Date().toISOString()
        });
    } catch (error) {
        console.error("Error fetching satellite data:", error);
        return NextResponse.json({ error: "Failed to fetch satellite data" }, { status: 500 });
    }
}

const cachedGET = withCache(getHandler, { ttlSeconds: SATELLITE_TTL_SECONDS, upstreamHost: UPSTREAM_HOST });
export const GET = async (req: Request) => {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    return cachedGET(req);
};
