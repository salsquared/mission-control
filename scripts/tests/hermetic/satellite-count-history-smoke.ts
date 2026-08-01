/**
 * Hermetic smoke for the active-satellite count store (lib/satellites/count-history.ts).
 *
 *   npx tsx scripts/tests/hermetic/satellite-count-history-smoke.ts
 *
 * No network, no PM2, no Prisma — the store is its own SQLite sidecar, pointed
 * at a scratch file here via SATELLITE_COUNTS_PATH.
 *
 * What earns a push gate: this series is the one store in the repo that cannot
 * be rebuilt. Celestrak serves only CURRENT elements, so every property below
 * protects against silently LOSING or CORRUPTING days that no later run can
 * recover.
 *
 *   1. ONE ROW PER UTC DAY, LAST READING WINS. The route records on every
 *      successful Celestrak reading (up to ~4/day at the 6h TTL). If that
 *      appended instead of upserting, the sparkline would show four points a
 *      day; if it were first-write-wins, the day would freeze on a stale
 *      morning count.
 *
 *   2. UTC BUCKETING, NOT LOCAL. The box runs at UTC-7/8. A reading at 18:00
 *      local on the 1st is the 2nd in UTC; bucketing locally would merge two
 *      UTC days into one row and lose one of them permanently.
 *
 *   3. THE WRITE PATH NEVER THROWS. It sits inside the satellites route, so a
 *      bad sample or a broken sidecar must degrade to "no row", never to a 500
 *      on a response we already successfully fetched from Celestrak.
 *
 *   4. THE READ WINDOW IS INCLUSIVE AT ITS EDGE. An off-by-one there quietly
 *      drops the oldest day from every chart.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name} — got ${g}, want ${w}`); failed++; }
}
function ok(name: string, cond: boolean, detail = "") {
    if (cond) { console.log(`[PASS] ${name}`); passed++; }
    else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const scratch = mkdtempSync(join(tmpdir(), "mc-satcounts-"));
process.env.SATELLITE_COUNTS_PATH = join(scratch, "satellite-counts.db");

async function main() {
    const {
        recordSatelliteCount,
        readSatelliteCountHistory,
        satelliteCountStats,
        __resetSatelliteCountStore,
    } = await import("@/lib/satellites/count-history");

    const day = (iso: string) => new Date(iso);

    // ── 1. A reading round-trips, with the orbit split riding along ──────────
    await recordSatelliteCount(
        {
            total: 12_345,
            orbits: { LEO: 10_000, MEO: 200, GEO: 1_000, SSO: 1_100, other: 45 },
            constellations: { starlink: 8_000, oneweb: 650 },
        },
        day("2026-07-01T12:00:00Z"),
    );
    // The orbit split rides along and reads back with the total — it is what the
    // card stacks under the total line, and the buckets must partition it.
    eq(
        "records one point with its orbit split",
        await readSatelliteCountHistory(3650, day("2026-07-01T12:00:00Z")),
        [{ date: "2026-07-01", total: 12_345, leo: 10_000, meo: 200, geo: 1_000, sso: 1_100, other: 45 }],
    );

    // ── 2. Same UTC day again → still one row, latest value wins ─────────────
    await recordSatelliteCount({ total: 12_350 }, day("2026-07-01T18:00:00Z"));
    await recordSatelliteCount({ total: 12_360 }, day("2026-07-01T23:59:59Z"));
    // Those readings carry no orbit split, so the columns go null — and must read
    // back as 0, not null, or the stacked chart gets NaN bands for that day.
    eq(
        "same day upserts to the last reading; absent orbits read as 0",
        await readSatelliteCountHistory(3650, day("2026-07-01T23:59:59Z")),
        [{ date: "2026-07-01", total: 12_360, leo: 0, meo: 0, geo: 0, sso: 0, other: 0 }],
    );
    eq("one row per day", (await satelliteCountStats()).days, 1);

    // ── 3. UTC bucketing, not local ─────────────────────────────────────────
    // 2026-07-02T03:00Z is still Jul 1 in every US timezone. It must land on
    // the 2nd regardless of where the box is, or two UTC days collapse to one.
    await recordSatelliteCount({ total: 12_400 }, day("2026-07-02T03:00:00Z"));
    eq(
        "buckets by UTC day, not local day",
        (await readSatelliteCountHistory(3650, day("2026-07-02T03:00:00Z"))).map(p => [p.date, p.total]),
        [
            ["2026-07-01", 12_360],
            ["2026-07-02", 12_400],
        ],
    );

    // ── 4. Ordering is ascending even when written out of order ─────────────
    await recordSatelliteCount({ total: 12_200 }, day("2026-06-28T09:00:00Z"));
    const ordered = await readSatelliteCountHistory(3650, day("2026-07-02T03:00:00Z"));
    eq(
        "returns oldest-first regardless of write order",
        ordered.map(p => p.date),
        ["2026-06-28", "2026-07-01", "2026-07-02"],
    );

    // ── 5. The day window is inclusive at its far edge ──────────────────────
    // From 2026-07-02, a 4-day window reaches back to 2026-06-28 — that day is
    // IN, and one day further out is not.
    eq(
        "4-day window includes the boundary day",
        (await readSatelliteCountHistory(4, day("2026-07-02T03:00:00Z"))).map(p => p.date),
        ["2026-06-28", "2026-07-01", "2026-07-02"],
    );
    eq(
        "3-day window excludes what falls outside it",
        (await readSatelliteCountHistory(3, day("2026-07-02T03:00:00Z"))).map(p => p.date),
        ["2026-07-01", "2026-07-02"],
    );

    // ── 6. Junk samples are dropped, never written, never thrown ────────────
    const before = (await satelliteCountStats()).days;
    for (const bad of [
        { total: 0 },
        { total: -5 },
        { total: Number.NaN },
        { total: undefined as unknown as number },
        undefined as unknown as { total: number },
    ]) {
        await recordSatelliteCount(bad, day("2026-07-03T00:00:00Z"));
    }
    eq("junk samples write no row", (await satelliteCountStats()).days, before);
    ok("junk samples do not throw", true);

    // ── 7. An unusable store degrades to [] rather than throwing ────────────
    // A directory path can never be opened as a database — same observable
    // shape as an ABI mismatch or an unwritable data/ dir in production.
    await __resetSatelliteCountStore();
    process.env.SATELLITE_COUNTS_PATH = scratch; // a directory, not a file
    let threw = false;
    try {
        await recordSatelliteCount({ total: 999 }, day("2026-07-04T00:00:00Z"));
        eq("unusable store reads empty", await readSatelliteCountHistory(30, day("2026-07-04T00:00:00Z")), []);
    } catch {
        threw = true;
    }
    ok("unusable store never throws on the route path", !threw);

    await __resetSatelliteCountStore();
}

main()
    .catch(e => {
        console.error("[FAIL] uncaught:", e);
        failed++;
    })
    .finally(() => {
        rmSync(scratch, { recursive: true, force: true });
        console.log(`\n${passed} passed, ${failed} failed`);
        process.exit(failed > 0 ? 1 : 0);
    });
