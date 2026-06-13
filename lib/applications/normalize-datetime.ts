/**
 * Timezone-safe normalization of LLM-extracted interview/assessment times
 * (Fix B / B2-ii — docs/archive/postmortem-self-notification-mail-loop.html §11).
 *
 * The email parser asks the LLM for an ISO-8601 `startsAt`. For a zone-less
 * wall-clock phrasing like "Tuesday at 2pm", the model inconsistently
 * serializes the wall-clock as bare-`Z` UTC (`…T14:00:00Z`) — which
 * `new Date()` then reads as 14:00 *UTC*, i.e. 7–8 h off for a Pacific user.
 * That is the four-month calendar drift documented in §6.
 *
 * Rule (B2-ii): when the extracted instant is **bare-`Z` or zone-less** AND the
 * source `rawText` named no timezone, re-interpret the wall-clock COMPONENTS as
 * local time in the user's IANA zone, yielding the correct UTC instant. If the
 * ISO carried a real ±HH:MM offset, or the rawText named a zone, we trust the
 * model's value as-is.
 *
 * Pure + dependency-free (takes the IANA zone as a param, uses only Intl) so the
 * hermetic smoke can exercise it with no DB, network, or the calendar module.
 */

// ISO-8601 date-time with optional seconds/fraction and optional zone designator.
// Groups: 1=year 2=month 3=day 4=hour 5=minute 6=second(opt) 7=zone(opt).
const ISO_RE =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Heuristic: did the email's own wording name a timezone? If so we trust the
 * model to have resolved it and skip normalization. Covers explicit numeric
 * offsets, North-American zone abbreviations, and "Eastern/Pacific/… Time".
 */
export function rawTextHasTimezone(rawText: string | null | undefined): boolean {
    if (!rawText) return false;
    // Explicit numeric offset, e.g. -07:00, +0530
    if (/[+-]\d{2}:?\d{2}\b/.test(rawText)) return true;
    // UTC/GMT and the common US zone abbreviations (PST/PDT/EST/…/ET/PT/CT/MT)
    if (/\b(UTC|GMT|[ECMP][SD]T|[ECMP]T)\b/.test(rawText)) return true;
    // "Eastern Time", "Pacific Standard", "central daylight", …
    if (/\b(eastern|central|mountain|pacific|atlantic)\s+(time|standard|daylight)/i.test(rawText)) return true;
    if (/\btime\s*zone\b/i.test(rawText)) return true;
    return false;
}

/**
 * Offset (ms) of `timeZone` at the instant `date`, defined so that the
 * wall-clock reading in `timeZone` equals `date.getTime() + offset` interpreted
 * as UTC. Positive east of UTC, negative west.
 */
function zoneOffsetMs(date: Date, timeZone: string): number {
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    const map: Record<string, number> = {};
    for (const p of dtf.formatToParts(date)) {
        if (p.type !== "literal") map[p.type] = Number(p.value);
    }
    // Some engines emit hour "24" for midnight — normalize to 0.
    const hour = map.hour === 24 ? 0 : map.hour;
    const asUtc = Date.UTC(map.year, map.month - 1, map.day, hour, map.minute, map.second);
    return asUtc - date.getTime();
}

/**
 * Given wall-clock components understood to be local time in `timeZone`, return
 * the corresponding UTC instant. Two-pass to land correctly across DST
 * transitions (the offset at the naive guess can differ from the offset at the
 * true instant).
 */
function wallClockInZoneToUtc(
    y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string,
): Date {
    const naiveUtcMs = Date.UTC(y, mo - 1, d, h, mi, s);
    const off1 = zoneOffsetMs(new Date(naiveUtcMs), timeZone);
    const candidate = new Date(naiveUtcMs - off1);
    const off2 = zoneOffsetMs(candidate, timeZone);
    if (off2 === off1) return candidate;
    return new Date(naiveUtcMs - off2);
}

/**
 * Normalize one LLM-extracted ISO timestamp. Returns a corrected ISO string, or
 * the input unchanged when no normalization applies (real offset present, the
 * rawText named a zone, or the value isn't a recognizable ISO date-time).
 */
export function normalizeExtractedDateTime(
    iso: string,
    rawText: string | null | undefined,
    timeZone: string,
): string {
    const s = (iso ?? "").trim();
    const m = ISO_RE.exec(s);
    if (!m) return iso; // unrecognized shape — let new Date() handle/reject it
    const zone = m[7];
    // A real ±HH:MM offset means the model resolved an actual zone — trust it.
    if (zone && zone !== "Z") return iso;
    // bare-Z or naive: if the email itself named a timezone, trust the model.
    if (rawTextHasTimezone(rawText)) return iso;
    // Re-interpret the wall-clock components as local time in `timeZone`.
    const utc = wallClockInZoneToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, timeZone);
    return utc.toISOString();
}
