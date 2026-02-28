import { NextResponse } from 'next/server';
import { withCache } from '../../../../lib/cache';

// Constants for lunar calculations
const LUNAR_MONTH = 29.53058867; // average length of a lunar month in days
const KNOWN_NEW_MOON = new Date('2000-01-06T18:14:00Z').getTime(); // Known new moon date

// Hardcoded upcoming major lunar phenomena (global events)
const LUNAR_PHENOMENA = [
    {
        type: "Total Lunar Eclipse",
        date: "2026-03-03T11:38:00Z",
        description: "A total lunar eclipse visible across much of the Americas, Europe, Africa, Asia, and Australia."
    },
    {
        type: "Partial Lunar Eclipse",
        date: "2026-08-28T04:14:00Z",
        description: "A partial lunar eclipse visible over the Americas, western Europe, and western Africa."
    },
    {
        type: "Penumbral Lunar Eclipse",
        date: "2027-02-20T23:14:00Z",
        description: "A penumbral lunar eclipse visible from the Americas, Europe, Africa, and parts of Asia."
    },
    {
        type: "Supermoon",
        date: "2027-07-18T00:00:00Z",
        description: "A supermoon where the full moon coincides with its closest approach to Earth, appearing larger and brighter."
    }
];

function getMoonPhaseAndIllumination(date: Date) {
    const diffMs = date.getTime() - KNOWN_NEW_MOON;
    const daysSinceNew = diffMs / (1000 * 60 * 60 * 24);
    const cycleFraction = (daysSinceNew % LUNAR_MONTH) / LUNAR_MONTH;

    // Convert fraction to phase name
    let phase = "";
    if (cycleFraction < 0.03 || cycleFraction >= 0.97) phase = "New Moon";
    else if (cycleFraction < 0.22) phase = "Waxing Crescent";
    else if (cycleFraction < 0.28) phase = "First Quarter";
    else if (cycleFraction < 0.47) phase = "Waxing Gibbous";
    else if (cycleFraction < 0.53) phase = "Full Moon";
    else if (cycleFraction < 0.72) phase = "Waning Gibbous";
    else if (cycleFraction < 0.78) phase = "Last Quarter";
    else phase = "Waning Crescent";

    // Calculate illumination percentage (0-100)
    // Illumination follows a cosine-like curve from 0 to 1 back to 0
    const illumination = (1 - Math.cos(cycleFraction * 2 * Math.PI)) / 2 * 100;

    return {
        phase,
        illumination: parseFloat(illumination.toFixed(1))
    };
}

async function getHandler() {
    try {
        const today = new Date();

        // Generate past 7 days and next 7 days of lunar cycles
        const weekly_cycles = [];
        for (let i = -7; i <= 7; i++) {
            // Set to 11 PM local time for the specific day
            const targetDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i, 23, 0, 0, 0);
            const { phase, illumination } = getMoonPhaseAndIllumination(targetDate);

            const year = targetDate.getFullYear();
            const month = String(targetDate.getMonth() + 1).padStart(2, '0');
            const dayStr = String(targetDate.getDate()).padStart(2, '0');

            weekly_cycles.push({
                date: `${year}-${month}-${dayStr}`,
                phase,
                illumination
            });
        }

        // Find the next phenomenon
        const nowMs = today.getTime();
        const next_phenomenon = LUNAR_PHENOMENA.find(p => new Date(p.date).getTime() > nowMs) || null;

        return NextResponse.json({
            weekly_cycles,
            next_phenomenon,
            updated_at: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error fetching moon data:', error);
        return NextResponse.json({ error: 'Failed to fetch moon data' }, { status: 500 });
    }
}

export const GET = withCache(getHandler, 86400); // Cache moon data for 24h
