"use client";

import React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export interface WidgetItem {
    id: string;
    content: React.ReactNode;
    colSpan?: number; // 1 to 3, assuming 3-col grid
    rowSpan?: number;
    hFit?: boolean; // If true, avoids stretching height to match grid rows
}

interface WidgetGridProps {
    items: WidgetItem[];
    className?: string;
    layout?: "grid" | "masonry";
}

export const WidgetGrid: React.FC<WidgetGridProps> = ({ items, className, layout = "grid" }) => {
    return (
        <div className={cn(
            layout === "grid"
                ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-2 grid-flow-row-dense"
                : "columns-1 md:columns-2 lg:columns-3 gap-4 p-2",
            className
        )}>
            {items.map((item) => (
                <motion.div
                    key={item.id}
                    layoutId={item.id}
                    drag
                    dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
                    dragElastic={0.2}
                    className={cn(
                        "relative bg-black/40 border border-white/5 rounded-lg overflow-hidden backdrop-blur-sm break-inside-avoid",
                        layout === "masonry" ? "mb-4 inline-block w-full" : "",
                        "hover:border-cyan-500/30 transition-colors group z-0 hover:z-10 cursor-grab active:cursor-grabbing",
                        layout === "grid" && item.colSpan === 2 ? "lg:col-span-2" : "",
                        layout === "grid" && item.colSpan === 3 ? "lg:col-span-3" : "",
                        layout === "grid" && item.rowSpan === 2 ? "lg:row-span-2" : "",
                        layout === "grid" && item.rowSpan === 3 ? "lg:row-span-3" : "",
                        layout === "masonry" && item.colSpan && item.colSpan > 1 ? "column-span-all" : "",
                        item.hFit ? "self-start h-fit" : "h-full"
                    )}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                >
                    {/* Drag Handle (Optional, or make whole thing draggable if desired) */}
                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab text-white/20 hover:text-white">
                        {/* Icon placeholder if needed */}
                    </div>

                    <div className={cn("w-full p-4 flex flex-col", item.hFit ? "" : "h-full")}>
                        {item.content}
                    </div>
                </motion.div>
            ))}
        </div>
    );
};
