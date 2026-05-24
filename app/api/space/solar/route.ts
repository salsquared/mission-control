import { NextResponse } from 'next/server';
import { withCache } from '../../../../lib/cache';
import { requireLocalOrSession } from '@/lib/auth-guards';
import { loggedFetch } from '@/lib/external-fetch';

export const revalidate = 300; // Cache for 5 minutes

function getFluxCategory(flux: number): string {
    if (flux >= 1e-4) return "X" + (flux / 1e-4).toFixed(1);
    if (flux >= 1e-5) return "M" + (flux / 1e-5).toFixed(1);
    if (flux >= 1e-6) return "C" + (flux / 1e-6).toFixed(1);
    if (flux >= 1e-7) return "B" + (flux / 1e-7).toFixed(1);
    if (flux >= 1e-8) return "A" + (flux / 1e-8).toFixed(1);
    return "<A1.0";
}

function getStatusFromFlux(category: string): string {
    if (category.startsWith("X")) return "Extreme";
    if (category.startsWith("M")) return "High";
    if (category.startsWith("C")) return "Moderate";
    return "Normal";
}

async function getHandler() {
    try {
        const res = await loggedFetch("https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json");

        if (!res.ok) {
            throw new Error(`Failed to fetch solar data: ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        const latest = data[data.length - 1];

        const fluxCategory = getFluxCategory(latest.flux);
        const status = getStatusFromFlux(fluxCategory);

        return NextResponse.json({
            status,
            xray_flux: fluxCategory,
            updated_at: latest.time_tag
        });
    } catch (error) {
        console.error("Error fetching solar data:", error);
        return NextResponse.json({ error: "Failed to fetch solar data" }, { status: 500 });
    }
}

const cachedGET = withCache(getHandler, { ttlSeconds: 300, upstreamHost: 'services.swpc.noaa.gov' }); // Cache for 5 mins
export const GET = async (req: Request) => {
    const guard = await requireLocalOrSession(req);
    if ('error' in guard) return guard.error;
    return cachedGET(req);
};
