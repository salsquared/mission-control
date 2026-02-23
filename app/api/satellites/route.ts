import { NextResponse } from 'next/server';

export const revalidate = 3600; // Cache for 1 hour

export async function GET() {
    try {
        const res = await fetch("https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json");

        if (!res.ok) {
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
