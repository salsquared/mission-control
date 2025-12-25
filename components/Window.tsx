"use client";

import React, { useState, useRef, useEffect } from "react";
import { motion, useDragControls } from "framer-motion";
import { X, Minus, Maximize2, Move } from "lucide-react";
import { cn } from "@/lib/utils";

interface WindowProps {
    id: string;
    title: string;
    children: React.ReactNode;
    initialX?: number;
    initialY?: number;
    initialWidth?: number;
    initialHeight?: number;
    onClose?: (id: string) => void;
    isActive?: boolean;
    onFocus?: (id: string) => void;
}

export const Window: React.FC<WindowProps> = ({
    id,
    title,
    children,
    initialX = 100,
    initialY = 100,
    initialWidth = 400,
    initialHeight = 300,
    onClose,
    isActive = false,
    onFocus,
}) => {
    const [isMaximized, setIsMaximized] = useState(false);
    const dragControls = useDragControls();
    const windowRef = useRef<HTMLDivElement>(null);

    return (
        <motion.div
            ref={windowRef}
            drag={!isMaximized}
            dragControls={dragControls}
            dragListener={false}
            dragMomentum={false}
            initial={{ x: initialX, y: initialY, width: initialWidth, height: initialHeight }}
            animate={isMaximized ? { x: 0, y: 0, width: "100%", height: "100%" } : {}}
            className={cn(
                "absolute flex flex-col overflow-hidden glass-dark rounded-xl border border-white/10 shadow-2xl transition-shadow",
                isActive ? "z-50 ring-2 ring-primary/20 shadow-primary/10" : "z-10",
                isMaximized ? "rounded-none" : "rounded-xl"
            )}
            onPointerDown={() => onFocus?.(id)}
        >
            {/* Window Header */}
            <div
                className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10 cursor-default select-none group"
                onPointerDown={(e) => dragControls.start(e)}
            >
                <div className="flex items-center gap-2 cursor-move">
                    <Move className="w-3 h-3 text-muted-foreground group-hover:text-cyan-vibrant transition-colors" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {title}
                    </span>
                </div>

                <div className="flex items-center gap-1.5">
                    <button
                        onClick={() => { }}
                        className="p-1 hover:bg-white/10 rounded-md text-muted-foreground transition-colors"
                    >
                        <Minus className="w-3.5 h-3.5" />
                    </button>
                    <button
                        onClick={() => setIsMaximized(!isMaximized)}
                        className="p-1 hover:bg-white/10 rounded-md text-muted-foreground transition-colors"
                    >
                        <Maximize2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                        onClick={() => onClose?.(id)}
                        className="p-1 hover:bg-red-500/20 hover:text-red-400 rounded-md text-muted-foreground transition-colors"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            {/* Window Content */}
            <div className="flex-1 overflow-auto p-4 custom-scrollbar">
                {children}
            </div>

            {/* Resize Handle (Bottom Right) */}
            {!isMaximized && (
                <div
                    className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
                    onPointerDown={(e) => {
                        // Placeholder for custom resizing logic if needed beyond framer drag
                    }}
                />
            )}
        </motion.div>
    );
};
