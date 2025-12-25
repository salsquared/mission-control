"use client";

import React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export interface WidgetItem {
    id: string;
    content: React.ReactNode;
    colSpan?: number; // 1 to 4, assuming 4-col grid
    rowSpan?: number;
}

interface WidgetGridProps {
    items: WidgetItem[];
    className?: string;
}

export const WidgetGrid: React.FC<WidgetGridProps> = ({ items, className }) => {
    return (
        <div className={cn("grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 p-2", className)}>
            {items.map((item) => (
                <motion.div
                    key={item.id}
                    layoutId={item.id}
                    drag
                    dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
                    dragElastic={0.2}
                    className={cn(
                        "relative bg-black/40 border border-white/5 rounded-lg overflow-hidden backdrop-blur-sm",
                        "hover:border-cyan-500/30 transition-colors group z-0 hover:z-10 cursor-grab active:cursor-grabbing",
                        item.colSpan ? `col-span-${item.colSpan}` : "col-span-1",
                        item.rowSpan ? `row-span-${item.rowSpan}` : "row-span-1"
                    )}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                >
                    {/* Drag Handle (Optional, or make whole thing draggable if desired) */}
                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab text-white/20 hover:text-white">
                        {/* Icon placeholder if needed */}
                    </div>

                    <div className="h-full w-full p-4">
                        {item.content}
                    </div>
                </motion.div>
            ))}
        </div>
    );
};
