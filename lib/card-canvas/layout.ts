/**
 * CardCanvas layout math — pure, DOM-free, React-free.
 *
 * Deliberately separated from components/grids/CardCanvas.tsx so the rules that
 * are easy to get subtly wrong (span clamping, the packing quantum) are unit
 * testable without a DOM or a React renderer. The component owns measurement
 * and effects; this module owns the arithmetic.
 *
 * Design doc: docs/card-canvas.html.
 */

export type CardHeight = "auto" | "sm" | "md" | "lg" | "xl";

/**
 * Which grid tracks a card occupies, as a `grid-column` value.
 *
 * `colSpan` is read RELATIVE to `columns` — it is a fraction, not an absolute
 * track count. That is forced by real call sites: `colSpan: 2` means two-thirds
 * width in AIView (columns=3) but full width in ApplicationsView (columns=2).
 * Interpreting it absolutely would silently change one of them.
 *
 * `cols` is the number of tracks the grid ACTUALLY resolved to, or 0 when that
 * is not yet known (pre-hydration, no JS, or before the first measurement).
 *
 * The `cols <= 0` guard is what keeps the packing layer non-load-bearing: an
 * intermediate `span 2` emitted into a grid that resolved to ONE track would
 * manufacture an implicit second column and overflow the container. So until
 * the real count is known a card is either full-width or single-track — both
 * safe at every width. Intermediate spans are an upgrade, never a baseline.
 *
 * @returns a `grid-column` value, or undefined for the default single track.
 */
export function resolveGridColumn(
    colSpan: number | undefined,
    columns: number,
    cols: number
): string | undefined {
    const span = colSpan ?? 1;
    if (!Number.isFinite(span) || span <= 1) return undefined;
    if (!Number.isFinite(columns) || columns <= 1) return undefined;
    if (span >= columns) return "1 / -1";
    if (cols <= 0) return undefined;
    if (cols === 1) return undefined;
    return `span ${Math.min(Math.floor(span), cols)}`;
}

/**
 * How many grid rows a card of `heightPx` occupies.
 *
 * Packing works by making rows a fine quantum (`--cc-row`, 4px) with row-gap 0,
 * then giving each card a span that covers its height PLUS the gap — so the
 * visual gutter lives inside the span rather than in the grid. Rounding up is
 * what guarantees a card is never clipped by its own span.
 */
export function rowSpanFor(heightPx: number, gapPx: number, rowPx: number): number {
    if (!Number.isFinite(heightPx) || heightPx <= 0) return 1;
    if (!Number.isFinite(rowPx) || rowPx <= 0) return 1;
    const gap = Number.isFinite(gapPx) && gapPx > 0 ? gapPx : 0;
    return Math.max(1, Math.ceil((heightPx + gap) / rowPx));
}

/**
 * Resolve a CSS length that may be authored in px or rem.
 *
 * `--cc-row` is an engine internal authored in px today, but a future density
 * pass might switch to rem, and a silent NaN here would disable packing
 * invisibly. `rootFontSizePx` is injected rather than read from the document so
 * this stays testable without a DOM.
 */
export function readPx(raw: string, fallback: number, rootFontSizePx = 16): number {
    const v = (raw ?? "").trim();
    if (!v) return fallback;
    const n = parseFloat(v);
    if (Number.isNaN(n)) return fallback;
    if (v.endsWith("rem")) {
        const root = Number.isFinite(rootFontSizePx) && rootFontSizePx > 0 ? rootFontSizePx : 16;
        return n * root;
    }
    return n;
}

/** Count the tracks in a resolved `grid-template-columns` computed value. */
export function trackCount(gridTemplateColumns: string): number {
    const v = (gridTemplateColumns ?? "").trim();
    if (!v || v === "none") return 1;
    return v.split(/\s+/).filter(Boolean).length;
}
