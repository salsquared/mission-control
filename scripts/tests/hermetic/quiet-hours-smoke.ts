// Story 28 hermetic smoke for isInQuietHours — pure function. No DB.
// Run with: npx tsx scripts/tests/hermetic/quiet-hours-smoke.ts

import { isInQuietHours } from '@/lib/notifications/quiet-hours';

interface Step { name: string; ok: boolean; detail?: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail?: string) {
    steps.push({ name, ok, detail });
    console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

// Build a Date that lands at H:M UTC on an arbitrary day. The helper resolves
// to local time via Intl, so passing "UTC" as the configured tz keeps the
// expected local time === the constructed UTC time.
function atUTC(hour: number, minute = 0): Date {
    return new Date(Date.UTC(2026, 4, 22, hour, minute, 0));
}

// ─── Disabled when any field is null ─────────────────────────────────────
record(
    'all-null config: not in quiet hours',
    !isInQuietHours(atUTC(3), { start: null, end: null, timezone: null }),
);
record(
    'partial config (missing end): not in quiet hours',
    !isInQuietHours(atUTC(3), { start: '22:00', end: null, timezone: 'UTC' }),
);
record(
    'partial config (missing tz): not in quiet hours',
    !isInQuietHours(atUTC(3), { start: '22:00', end: '08:00', timezone: null }),
);

// ─── Invalid inputs degrade to "off" ─────────────────────────────────────
record(
    'invalid HH:MM: treated as off',
    !isInQuietHours(atUTC(3), { start: 'bogus', end: '08:00', timezone: 'UTC' }),
);
record(
    'invalid timezone: treated as off',
    !isInQuietHours(atUTC(3), { start: '22:00', end: '08:00', timezone: 'Not/A_Real/Tz' }),
);

// ─── Same-day window ─────────────────────────────────────────────────────
const lunch = { start: '12:00', end: '13:00', timezone: 'UTC' };
record('same-day: before window', !isInQuietHours(atUTC(11, 59), lunch));
record('same-day: at start (inclusive)', isInQuietHours(atUTC(12, 0), lunch));
record('same-day: middle', isInQuietHours(atUTC(12, 30), lunch));
record('same-day: at end (exclusive)', !isInQuietHours(atUTC(13, 0), lunch));
record('same-day: after window', !isInQuietHours(atUTC(13, 1), lunch));

// ─── Wrap-around window (sleep hours, e.g. 22:00 → 08:00) ────────────────
const sleep = { start: '22:00', end: '08:00', timezone: 'UTC' };
record('wrap: before window (21:59)', !isInQuietHours(atUTC(21, 59), sleep));
record('wrap: at start (22:00 — inclusive)', isInQuietHours(atUTC(22, 0), sleep));
record('wrap: late night (23:30)', isInQuietHours(atUTC(23, 30), sleep));
record('wrap: midnight (00:00)', isInQuietHours(atUTC(0, 0), sleep));
record('wrap: early morning (07:30)', isInQuietHours(atUTC(7, 30), sleep));
record('wrap: at end (08:00 — exclusive)', !isInQuietHours(atUTC(8, 0), sleep));
record('wrap: midday (12:00)', !isInQuietHours(atUTC(12, 0), sleep));

// ─── Zero-length window (start === end) ──────────────────────────────────
record(
    'zero-length window: never in quiet hours',
    !isInQuietHours(atUTC(3), { start: '03:00', end: '03:00', timezone: 'UTC' }),
);

// ─── Non-UTC timezone ────────────────────────────────────────────────────
// At 22:00 UTC, Los Angeles is 15:00 PDT (UTC-7) / 14:00 PST (UTC-8).
// Set quiet hours 22:00 → 06:00 LA local. 22:00 UTC = ~15:00 LA = NOT in
// quiet hours.
const laQuiet = { start: '22:00', end: '06:00', timezone: 'America/Los_Angeles' };
record(
    'tz: 22:00 UTC (≈15:00 LA) is NOT in 22-06 LA window',
    !isInQuietHours(atUTC(22), laQuiet),
);
// 06:00 UTC = 22:00 or 23:00 LA the prior day (depending on DST). Either way
// inside the 22:00 → 06:00 LA window.
record(
    'tz: 06:00 UTC (≈22-23:00 LA) IS in 22-06 LA window',
    isInQuietHours(atUTC(6), laQuiet),
);

const passed = steps.filter(s => s.ok).length;
const failed = steps.length - passed;
console.info(`\n${passed}/${steps.length} steps passed`);
if (failed > 0) {
    console.error(`${failed} step(s) failed`);
    process.exit(1);
}
console.info('All checks passed.');
