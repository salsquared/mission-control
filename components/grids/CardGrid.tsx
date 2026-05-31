"use client";

import React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Card } from "../ui/Card";

export interface CardItem {
    id: string;
    content: React.ReactNode;
    colSpan?: number; // 1 to 3, assuming 3-col grid
    rowSpan?: number;
    hFit?: boolean; // If true, avoids stretching height to match grid rows
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

interface CardGridProps {
    items: CardItem[];
    className?: string;
    layout?: "grid" | "masonry";
    columns?: 2 | 3;
}

export const CardGrid: React.FC<CardGridProps> = ({ items, className, layout = "grid", columns = 3 }) => {
    return (
        <div className={cn(
            // py-2 (not p-2): keep the 8px vertical breathing room for hover
            // glow but drop the horizontal inset. Section's px-6 owns the gutter,
            // so cards align flush to the same line as the section title — a
            // horizontal p-2 here pushed cards ~8px further in than the title.
            layout === "grid"
                ? columns === 3
                    ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 py-2 grid-flow-row-dense"
                    : "grid grid-cols-1 md:grid-cols-2 gap-4 py-2 grid-flow-row-dense"
                : columns === 3
                    ? "columns-1 md:columns-2 lg:columns-3 gap-4 py-2"
                    : "columns-1 md:columns-2 gap-4 py-2",
            className
        )}>
            {items.map((item) => (
                <motion.div
                    key={item.id}
                    style={item.frameStyle}
                    className={cn(
                        "relative rounded-lg overflow-hidden backdrop-blur-sm break-inside-avoid group z-0 hover:z-10",
                        layout === "masonry" ? "mb-4 inline-block w-full" : "",
                        layout === "grid" && item.colSpan === 2 ? "md:col-span-2 lg:col-span-2" : "",
                        layout === "grid" && item.colSpan === 3 ? "md:col-span-2 lg:col-span-3" : "",
                        layout === "grid" && item.rowSpan === 2 ? "md:row-span-2 lg:row-span-2" : "",
                        layout === "grid" && item.rowSpan === 3 ? "md:row-span-3 lg:row-span-3" : "",
                        layout === "masonry" && item.colSpan && item.colSpan > 1 ? "column-span-all" : "",
                        item.hFit ? "self-start h-fit" : "h-full",
                        item.className
                    )}
                >
                    <Card
                        wrapperClassName="bg-black/40 rounded-lg border border-white/5 hover:border-cyan-500/30 transition-colors h-full"
                        wrapperStyle={item.wrapperStyle}
                        contentClassName={cn("w-full p-4 flex flex-col", item.hFit ? "" : "h-full")}
                    >
                        {item.content}
                    </Card>
                </motion.div>
            ))}
        </div>
    );
};
