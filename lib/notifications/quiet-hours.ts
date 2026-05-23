// Story 28 — quiet hours helper. Checks whether a given moment falls inside
// the user-configured quiet-hours window (in their configured timezone).
// Pure function so it's trivially testable without freezing the system
// clock; callers pass `now` explicitly.

const HHMM_REGEX = /^([0-1]\d|2[0-3]):([0-5]\d)$/;

export interface QuietHoursConfig {
    start: string | null;  // "HH:MM"
    end: string | null;    // "HH:MM"
    timezone: string | null;  // IANA, e.g. "America/Los_Angeles"
}

function parseHHMM(s: string): { hour: number; minute: number } | null {
    const m = HHMM_REGEX.exec(s);
    if (!m) return null;
    return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

// Resolve `now` to {hour, minute} in the configured timezone. Uses Intl
// rather than juggling Date arithmetic — DST transitions are handled
// transparently by the host's zoneinfo.
function localTime(now: Date, timezone: string): { hour: number; minute: number } | null {
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }).formatToParts(now);
        const hourStr = parts.find(p => p.type === "hour")?.value;
        const minStr = parts.find(p => p.type === "minute")?.value;
        if (!hourStr || !minStr) return null;
        const hour = parseInt(hourStr, 10);
        const minute = parseInt(minStr, 10);
        // Intl can produce "24:00" at midnight in some locales — normalise.
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
        return { hour: hour === 24 ? 0 : hour, minute };
    } catch {
        // Invalid timezone string. Caller treats this as "no quiet hours
        // configured" so a typo doesn't silently suppress every email.
        return null;
    }
}

function toMinutes(t: { hour: number; minute: number }): number {
    return t.hour * 60 + t.minute;
}

export function isInQuietHours(now: Date, config: QuietHoursConfig): boolean {
    if (!config.start || !config.end || !config.timezone) return false;
    const start = parseHHMM(config.start);
    const end = parseHHMM(config.end);
    if (!start || !end) return false;
    const local = localTime(now, config.timezone);
    if (!local) return false;

    const startM = toMinutes(start);
    const endM = toMinutes(end);
    const nowM = toMinutes(local);

    // start === end is a 0-length window (no quiet hours).
    if (startM === endM) return false;

    if (startM < endM) {
        // Same-day window: [start, end). e.g. 13:00 → 14:00 = "lunch".
        return nowM >= startM && nowM < endM;
    }
    // Wraps midnight: [start, 24:00) ∪ [00:00, end). e.g. 22:00 → 08:00.
    return nowM >= startM || nowM < endM;
}
