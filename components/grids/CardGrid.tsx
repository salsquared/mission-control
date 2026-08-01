"use client";

import React, { useMemo } from "react";
import { CardCanvas, type CardItem as CanvasCardItem } from "./CardCanvas";
import { heightForRowSpan } from "@/lib/card-canvas/layout";

/**
 * @deprecated Compatibility shim over CardCanvas. Scheduled for deletion in
 * P3.3 of docs/card-canvas.html, once every view imports CardCanvas directly.
 *
 * This exists so the engine swap and the eight view migrations are separate,
 * reviewable diffs. It defaults to `layout="rows"` — today's aligned-row
 * behaviour — so an UN-MIGRATED view renders exactly as it did before. Nothing
 * changes visually until a view is deliberately moved over.
 *
 * Do not add features here. New work goes to CardCanvas.
 */

export interface CardItem extends CanvasCardItem {
    /** @deprecated Removed in CardCanvas — use `height` instead. Retained only
     *  so un-migrated call sites keep type-checking; mapped below. */
    rowSpan?: number;
}

interface CardGridProps {
    items: CardItem[];
    className?: string;
    /** @deprecated CardCanvas uses "packed" | "rows". Mapped below. */
    layout?: "grid" | "masonry";
    columns?: 2 | 3;
}

export const CardGrid: React.FC<CardGridProps> = ({
    items,
    className,
    layout = "grid",
    columns = 3,
}) => {
    const mapped = useMemo<CanvasCardItem[]>(
        () =>
            items.map(({ rowSpan, height, ...item }) => ({
                ...item,
                // An explicit `height` always wins — a partially-migrated view
                // can set tokens on some cards while others still carry rowSpan.
                height: height ?? heightForRowSpan(rowSpan),
            })),
        [items]
    );

    return (
        <CardCanvas
            items={mapped}
            className={className}
            columns={columns}
            // "grid" → rows: the un-migrated default, visually unchanged.
            // "masonry" → packed: these callers already wanted packing; they
            // were just getting it from CSS multi-column, which silently
            // dropped colSpan and flowed column-wise instead of in DOM order.
            layout={layout === "masonry" ? "packed" : "rows"}
        />
    );
};
