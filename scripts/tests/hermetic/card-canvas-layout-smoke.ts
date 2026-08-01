/**
 * Hermetic smoke for the CardCanvas layout engine (lib/card-canvas/layout.ts).
 * Design doc: docs/card-canvas.html, task P3.1.
 *
 *   npx tsx scripts/tests/hermetic/card-canvas-layout-smoke.ts
 *
 * Pure functions — no DOM, no React, no network. The layout math lives in
 * lib/card-canvas/layout.ts precisely so it can be tested here without a
 * renderer; the component owns measurement and effects, this owns arithmetic.
 *
 * Three properties are load-bearing enough to gate a push on:
 *
 *   1. SPAN CLAMPING. `colSpan` is read as a fraction of `columns`, because the
 *      same literal means different things at different call sites: colSpan 2
 *      is two-thirds width in AIView (columns=3) but FULL width in
 *      ApplicationsView (columns=2). Reading it absolutely would silently
 *      change one of them.
 *
 *   2. NO INTERMEDIATE SPAN BEFORE THE TRACK COUNT IS KNOWN. Emitting `span 2`
 *      into a grid that resolved to one track manufactures an implicit second
 *      column and overflows the container. Pre-hydration and with JS disabled,
 *      cards must therefore be full-width or single-track only. This is the
 *      property that keeps the JS packing layer a refinement rather than a
 *      dependency, and it is the easiest one to regress by "simplifying" the
 *      cols<=0 guard away.
 *
 *   3. ROW SPANS ALWAYS COVER THE CARD. A span that rounds DOWN clips the card
 *      it was computed for, so rowSpanFor must never under-cover at any
 *      height/gap/quantum combination.
 */
import {
    readPx,
    resolveGridColumn,
    rowSpanFor,
    trackCount,
} from "@/lib/card-canvas/layout";

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

// ── 1. Span mapping, columns=3 (the default: AIView, InternalView, …) ────────
eq("cols=3: no colSpan → single track", resolveGridColumn(undefined, 3, 3), undefined);
eq("cols=3: colSpan 1 → single track", resolveGridColumn(1, 3, 3), undefined);
eq("cols=3: colSpan 2 → span 2", resolveGridColumn(2, 3, 3), "span 2");
eq("cols=3: colSpan 3 == columns → full width", resolveGridColumn(3, 3, 3), "1 / -1");
// Over-declared spans must not manufacture tracks.
eq("cols=3: colSpan 4 > columns → full width", resolveGridColumn(4, 3, 3), "1 / -1");

// ── 2. Span mapping, columns=2 (ApplicationsView, ProfileView sections) ──────
// This is the case that forces fraction semantics: the SAME colSpan literal
// that is two-thirds above is full width here.
eq("cols=2: colSpan 2 == columns → full width", resolveGridColumn(2, 2, 2), "1 / -1");
eq("cols=2: colSpan 1 → single track", resolveGridColumn(1, 2, 2), undefined);
ok(
    "colSpan 2 means different things at columns=3 vs columns=2",
    resolveGridColumn(2, 3, 3) !== resolveGridColumn(2, 2, 2),
    "fraction semantics collapsed — one of the two views just changed layout"
);

// ── 3. The pre-hydration / no-JS guard ──────────────────────────────────────
// cols=0 means "track count not yet known". Full-width is still safe (1 / -1
// spans whatever exists), but an intermediate span is NOT.
eq("cols unknown: full-width still emitted", resolveGridColumn(3, 3, 0), "1 / -1");
eq("cols unknown: intermediate span withheld", resolveGridColumn(2, 3, 0), undefined);
eq("cols unknown: colSpan 2 of 4 withheld", resolveGridColumn(2, 4, 0), undefined);
// REGRESSION (2026-08-01): these two lines are a CONTRACT ON THE COMPONENT, not
// just on this function. Because an unknown track count withholds the span, any
// render path in CardCanvas that fails to establish `cols` silently collapses
// every multi-column card to ONE track. That shipped: the effect skipped its
// whole measure pass when native `display: grid-lanes` was available (and in
// `layout="rows"`), so SpaceView's colSpan-2 Launch Calendar rendered one column
// wide on Safari 26. Measuring the track count is NOT part of the packing work
// and must never be skipped alongside it.
eq("cols unknown: colSpan 2 of 3 is WITHHELD (component must supply cols)",
   resolveGridColumn(2, 3, 0), undefined);
eq("cols known: the same card spans 2", resolveGridColumn(2, 3, 3), "span 2");

// Narrow grid: one real track. An intermediate span here would overflow.
eq("1 real track: intermediate span withheld", resolveGridColumn(2, 3, 1), undefined);
eq("1 real track: full-width still fine", resolveGridColumn(3, 3, 1), "1 / -1");
// Clamped to the tracks that actually exist.
eq("2 real tracks of a 4-col cap: clamped to 2", resolveGridColumn(3, 4, 2), "span 2");
eq("3 real tracks of a 4-col cap: span 3", resolveGridColumn(3, 4, 3), "span 3");

// Degenerate inputs must never produce a span.
eq("columns=1 → never spans", resolveGridColumn(2, 1, 1), undefined);
eq("columns=0 → never spans", resolveGridColumn(2, 0, 0), undefined);
eq("NaN colSpan → single track", resolveGridColumn(NaN, 3, 3), undefined);
eq("negative colSpan → single track", resolveGridColumn(-2, 3, 3), undefined);

// ── 4. Row spans must always COVER the card ─────────────────────────────────
// The invariant: span * row >= height + gap. Under-covering clips the card.
{
    const rows = [2, 4, 8, 16];
    const gaps = [0, 8, 16, 24];
    const heights = [1, 17, 63, 64, 65, 120, 221, 384, 512, 1000, 1237];
    let worst = "";
    let allCover = true;
    for (const row of rows) {
        for (const gap of gaps) {
            for (const h of heights) {
                const span = rowSpanFor(h, gap, row);
                if (span * row < h + gap) {
                    allCover = false;
                    worst = `h=${h} gap=${gap} row=${row} → span ${span} covers ${span * row}px, needs ${h + gap}px`;
                }
                if (!Number.isInteger(span) || span < 1) {
                    allCover = false;
                    worst = `h=${h} gap=${gap} row=${row} → non-positive/non-integer span ${span}`;
                }
            }
        }
    }
    ok("rowSpanFor always covers height+gap (176 combinations)", allCover, worst);
}
// Exactness at the boundary — a card landing exactly on the quantum must not
// waste a whole extra row.
eq("exact fit: 48px + 16px gap at 4px rows → 16 rows", rowSpanFor(48, 16, 4), 16);
eq("one px over: 49px + 16px gap at 4px rows → 17 rows", rowSpanFor(49, 16, 4), 17);

// Degenerate inputs fall back to one row rather than NaN/Infinity, which would
// serialize into the style attribute as `span NaN` and break the whole canvas.
eq("zero height → 1 row", rowSpanFor(0, 16, 4), 1);
eq("negative height → 1 row", rowSpanFor(-10, 16, 4), 1);
eq("zero row quantum → 1 row", rowSpanFor(100, 16, 0), 1);
eq("NaN height → 1 row", rowSpanFor(NaN, 16, 4), 1);
eq("NaN gap treated as 0", rowSpanFor(40, NaN, 4), 10);

// ── 5. Length parsing (--cc-row may be authored px or rem) ──────────────────
eq("px parsed", readPx("4px", 99), 4);
eq("bare number parsed", readPx("4", 99), 4);
eq("rem resolved against root font size", readPx("0.5rem", 99, 16), 8);
eq("rem honours a non-16 root", readPx("0.5rem", 99, 20), 10);
eq("empty falls back", readPx("", 4), 4);
eq("garbage falls back", readPx("potato", 4), 4);
eq("whitespace tolerated", readPx("  8px  ", 99), 8);

// ── 6. Track counting off a resolved grid-template-columns ─────────────────
eq("three resolved tracks", trackCount("320px 320px 320px"), 3);
eq("one resolved track", trackCount("1024px"), 1);
eq("'none' → 1", trackCount("none"), 1);
eq("empty → 1", trackCount(""), 1);
eq("irregular whitespace tolerated", trackCount("  320px   320px  "), 2);

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
