/**
 * Hermetic smoke for timezone-safe date normalization
 * (lib/applications/normalize-datetime.ts). Fix B / B2-ii of
 * docs/archive/postmortem-self-notification-mail-loop.html §11.
 *
 * Pure function — no DB, no network. Verifies that a bare-Z / zone-less
 * wall-clock the LLM emits for "2pm" resolves to 2pm in the user's zone (the
 * 7–8 h calendar drift from §6), while values that carry a real offset or whose
 * rawText named a zone pass through untouched.
 *
 *   npx tsx scripts/tests/hermetic/datetime-normalize-smoke.ts
 */
import { normalizeExtractedDateTime, rawTextHasTimezone } from "@/lib/applications/normalize-datetime";

const TZ = "America/Los_Angeles"; // PDT = UTC-7 (summer), PST = UTC-8 (winter)

let passes = 0;
let fails = 0;
function eq(name: string, got: string, want: string) {
    if (got === want) { console.log(`[PASS] ${name}`); passes++; }
    else { console.error(`[FAIL] ${name}: got ${got}, want ${want}`); fails++; }
}
function truthy(name: string, got: boolean, want: boolean) {
    if (got === want) { console.log(`[PASS] ${name}`); passes++; }
    else { console.error(`[FAIL] ${name}: got ${got}, want ${want}`); fails++; }
}

// ── The core bug: bare-Z "2pm" for a Pacific user must become 2pm PDT ──────
// 2026-06-10 is PDT (UTC-7), so 2pm local = 21:00 UTC.
eq(
    "bare-Z summer wall-clock → local instant (no drift)",
    normalizeExtractedDateTime("2026-06-10T14:00:00Z", "Tuesday at 2pm", TZ),
    "2026-06-10T21:00:00.000Z",
);

// Winter date is PST (UTC-8), so 2pm local = 22:00 UTC — proves DST awareness.
eq(
    "bare-Z winter wall-clock → local instant (PST offset)",
    normalizeExtractedDateTime("2026-01-15T14:00:00Z", "2pm", TZ),
    "2026-01-15T22:00:00.000Z",
);

// Zone-less (no designator at all) is normalized the same way.
eq(
    "zone-less wall-clock → local instant",
    normalizeExtractedDateTime("2026-06-10T14:00:00", "2pm", TZ),
    "2026-06-10T21:00:00.000Z",
);

// ── Pass-through cases: do NOT touch ───────────────────────────────────────
// Real numeric offset → the model resolved an actual zone; trust it verbatim.
eq(
    "explicit ±offset is left untouched",
    normalizeExtractedDateTime("2026-06-10T14:00:00-04:00", "2pm", TZ),
    "2026-06-10T14:00:00-04:00",
);

// rawText named a zone → trust the model's bare-Z value as genuine UTC.
eq(
    "bare-Z is left untouched when rawText names a zone (EDT)",
    normalizeExtractedDateTime("2026-06-10T18:00:00Z", "2pm EDT", TZ),
    "2026-06-10T18:00:00Z",
);
eq(
    "bare-Z left untouched when rawText says 'Pacific Time'",
    normalizeExtractedDateTime("2026-06-10T21:00:00Z", "2:00 PM Pacific Time", TZ),
    "2026-06-10T21:00:00Z",
);

// Unparseable shape → returned as-is (let new Date() reject it downstream).
eq(
    "unrecognized shape passes through",
    normalizeExtractedDateTime("next Tuesday", "next Tuesday", TZ),
    "next Tuesday",
);

// ── rawTextHasTimezone detector ────────────────────────────────────────────
truthy("detects 'PST'", rawTextHasTimezone("3pm PST"), true);
truthy("detects 'EDT'", rawTextHasTimezone("interview at 10:00 EDT"), true);
truthy("detects 'ET'", rawTextHasTimezone("2pm ET"), true);
truthy("detects numeric offset", rawTextHasTimezone("14:00 -07:00"), true);
truthy("detects 'Pacific Time'", rawTextHasTimezone("2pm Pacific Time"), true);
truthy("no false positive on plain '2pm'", rawTextHasTimezone("Tuesday at 2pm"), false);
truthy("no false positive on empty", rawTextHasTimezone(""), false);

console.log(`\n${passes}/${passes + fails} steps passed`);
if (fails === 0) console.log("All checks passed.");
if (fails > 0) process.exit(1);
