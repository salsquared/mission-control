"use client";

import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Card } from "../ui/Card";
import {
    type CardHeight,
    readPx,
    resolveGridColumn,
    rowSpanFor,
    trackCount,
} from "@/lib/card-canvas/layout";

/**
 * CardCanvas — the card layout engine. Design doc: docs/card-canvas.html.
 *
 * Replaces CardGrid's fixed-breakpoint, stretch-to-row-height grid. Three
 * layers, each useful without the one above it:
 *
 *   1. Fluid tracks (pure CSS, `.card-canvas` in globals.css) — column count
 *      derives from CONTAINER width via an auto-fill/minmax/max() formula, so
 *      there is no md:/lg: ladder and the cap is exact. Needs no JS.
 *   2. Packing (this file) — each card's row span is computed from its measured
 *      height, giving true masonry that KEEPS DOM order and colSpan. The old
 *      `layout="masonry"` (CSS multi-column) lost both.
 *   3. Density tokens (--cc-*) — one knob instead of scattered literals.
 *
 * JS REFINES, IT IS NEVER LOAD-BEARING. With no JS, or before hydration, layer
 * 1 alone yields a fluid container-driven grid at content height — already
 * better than the stretch it replaces. Layer 2 only closes the residual gaps.
 */

export type { CardHeight };
export type CanvasLayout = "packed" | "rows";

export interface CardItem {
    id: string;
    content: React.ReactNode;
    /** Track span, read RELATIVE to `columns`. `colSpan === columns` means
     *  "full width" and maps to `1 / -1`. This is why it must be a fraction
     *  and not an absolute count: today `colSpan: 2` means two-thirds in
     *  AIView but full width in ApplicationsView (columns={2}). */
    colSpan?: number;
    /** Height mode. `auto` (default) measures the content — correct for cards
     *  that bound their own scroll regions (`max-h-[16rem]` and friends).
     *  A token gives a FIXED height, which is what cards using
     *  `flex-1 overflow-y-auto` need: that pattern requires a bounded parent,
     *  and content-sizing makes them expand instead of scroll (or, for
     *  KanbanWidget's `h-full` chain, collapse outright). */
    height?: CardHeight;
    /** @deprecated No-op alias for `height: "auto"`, which is now the default.
     *  Retained so existing call sites keep type-checking during migration. */
    hFit?: boolean;
    className?: string;
    /** Inline style for the card's wrapper — e.g. a per-card radial-gradient
     *  glow that can't be a static Tailwind class. Applied to the inner Card
     *  wrapper so a background-image layers over the canonical `bg-black/40`
     *  background-color. */
    wrapperStyle?: React.CSSProperties;
    /** Inline style for the card's outermost frame (the motion.div) — e.g. a
     *  colored box-shadow glow. Applied here, not the inner Card, so the
     *  frame's overflow-hidden doesn't clip the outer shadow. */
    frameStyle?: React.CSSProperties;
}

interface CardCanvasProps {
    items: CardItem[];
    className?: string;
    /** Column CAP, not a fixed count (OQ2a). Fewer columns are used when the
     *  container is narrow; never more than this. Feeds `--cc-max-cols`. */
    columns?: number;
    /** `packed` (default) is content-packed masonry. `rows` restores aligned
     *  equal-height rows — the escape hatch, and what the CardGrid shim uses. */
    layout?: CanvasLayout;
}

const HEIGHT_CLASS: Record<Exclude<CardHeight, "auto">, string> = {
    sm: "cc-h-sm",
    md: "cc-h-md",
    lg: "cc-h-lg",
    xl: "cc-h-xl",
};

/** Native CSS masonry (grid level 3). Safari 26 has it; Chrome and Firefox are
 *  still behind flags. Where it exists the browser packs better than we can, so
 *  the measurement pass is skipped entirely. Called from an effect only — `CSS`
 *  is not defined during SSR. */
function supportsNativeLanes(): boolean {
    return (
        typeof CSS !== "undefined" &&
        typeof CSS.supports === "function" &&
        CSS.supports("display", "grid-lanes")
    );
}

/** Wrapper over the pure resolver — see lib/card-canvas/layout.ts for why
 *  colSpan is read as a fraction of `columns` and why intermediate spans wait
 *  for a real track count. */
function columnStyle(item: CardItem, columns: number, cols: number): React.CSSProperties {
    const gridColumn = resolveGridColumn(item.colSpan, columns, cols);
    return gridColumn ? { gridColumn } : {};
}

export const CardCanvas: React.FC<CardCanvasProps> = ({
    items,
    className,
    columns = 3,
    layout = "packed",
}) => {
    const gridRef = useRef<HTMLDivElement | null>(null);
    const frames = useRef(new Map<string, HTMLElement>());
    const lastSpan = useRef(new Map<string, number>());
    const raf = useRef<number | null>(null);

    // `cols` drives grid-column (changes rarely — only when a track is gained
    // or lost), so it lives in React state. Row spans change constantly with
    // content and are written straight to the DOM instead, keeping a data
    // refresh in any card from re-rendering the whole canvas.
    const [cols, setCols] = useState(0);
    const [packedOn, setPackedOn] = useState(false);

    const registerFrame = useCallback((id: string, el: HTMLElement | null) => {
        if (el) frames.current.set(id, el);
        else {
            frames.current.delete(id);
            lastSpan.current.delete(id);
        }
    }, []);

    const measure = useCallback(() => {
        const grid = gridRef.current;
        if (!grid) return;

        const cs = getComputedStyle(grid);

        // Read the column count back off the RESOLVED template rather than
        // recomputing the formula here. The CSS stays the single source of
        // truth, so the two can never drift out of agreement.
        const n = trackCount(cs.gridTemplateColumns);
        setCols((prev) => (prev === n ? prev : n));

        const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
        const rowPx = readPx(cs.getPropertyValue("--cc-row"), 4, rootPx);
        // columnGap always resolves to the gap in px regardless of packed
        // state; rowGap is deliberately 0 once packing is on, since the gap
        // moves into each card's span.
        const gapPx = parseFloat(cs.columnGap) || 16;
        if (rowPx <= 0) return;

        for (const [id, el] of frames.current) {
            // `align-items: start` means this height is the card's CONTENT
            // height and does NOT depend on the span we are about to write —
            // which is precisely what makes this loop-free.
            const h = el.getBoundingClientRect().height;
            if (h <= 0) continue;
            const span = rowSpanFor(h, gapPx, rowPx);
            if (lastSpan.current.get(id) === span) continue;
            lastSpan.current.set(id, span);
            el.style.gridRowEnd = `span ${span}`;
        }

        setPackedOn(true);
    }, []);

    useLayoutEffect(() => {
        if (layout !== "packed") {
            // Rows mode: drop any spans a previous packed render left behind.
            for (const el of frames.current.values()) el.style.gridRowEnd = "";
            lastSpan.current.clear();
            setPackedOn(false);
            return;
        }
        if (supportsNativeLanes()) return;

        const grid = gridRef.current;
        if (!grid) return;

        // Batch every write into a rAF OUTSIDE the observer callback. Writing
        // synchronously from inside it is what produces "ResizeObserver loop
        // completed with undelivered notifications" — which, because
        // lib/logger.ts patches console.error into the in-app log viewer,
        // would surface to the user as a real fault rather than console noise.
        const schedule = () => {
            if (raf.current != null) return;
            raf.current = requestAnimationFrame(() => {
                raf.current = null;
                measure();
            });
        };

        // First pass synchronously, before paint, so cards land at their final
        // position rather than visibly jumping once spans are applied.
        measure();

        const ro = new ResizeObserver(schedule);
        ro.observe(grid);
        for (const el of frames.current.values()) ro.observe(el);

        return () => {
            ro.disconnect();
            if (raf.current != null) {
                cancelAnimationFrame(raf.current);
                raf.current = null;
            }
        };
        // items.length re-arms the observer when cards are added or removed.
    }, [layout, measure, items.length]);

    return (
        <div
            ref={gridRef}
            data-layout={layout}
            data-packed={packedOn ? "on" : undefined}
            // py-2 (not p-2): keep the 8px vertical breathing room for hover
            // glow but drop the horizontal inset. Section's gutter owns that,
            // so cards align flush to the same line as the section title.
            className={cn("card-canvas py-2", className)}
            style={{ "--cc-max-cols": columns } as React.CSSProperties}
        >
            {items.map((item) => (
                <motion.div
                    key={item.id}
                    ref={(el) => registerFrame(item.id, el)}
                    style={{ ...item.frameStyle, ...columnStyle(item, columns, cols) }}
                    // Frame contract preserved byte-for-byte from CardGrid:
                    // overflow-hidden and the z-0/hover:z-10 lift are load-
                    // bearing for the portalled popovers in CanonsCard and
                    // GenerateResumeCard, which exist to work around exactly
                    // this clipping.
                    className={cn(
                        "relative rounded-lg overflow-hidden backdrop-blur-sm break-inside-avoid group z-0 hover:z-10",
                        item.height && item.height !== "auto" ? HEIGHT_CLASS[item.height] : "",
                        item.className
                    )}
                >
                    <Card
                        wrapperClassName="bg-black/40 rounded-lg border border-white/5 hover:border-cyan-500/30 transition-colors h-full"
                        wrapperStyle={item.wrapperStyle}
                        // No h-full: Card's own `flex-1 min-h-0` already fills
                        // the wrapper, and min-h-0 is what confines the
                        // internal `overflow-y-auto` regions that fill-height
                        // cards rely on.
                        contentClassName="w-full flex flex-col cc-pad"
                    >
                        {item.content}
                    </Card>
                </motion.div>
            ))}
        </div>
    );
};
