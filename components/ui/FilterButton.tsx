"use client";
import React from "react";
import { Filter } from "lucide-react";

interface FilterButtonProps {
    /** Whether the dropdown this button controls is currently open. */
    active: boolean;
    /** Number of active filters — shown as a `(N)` badge to the LEFT of the
     * icon when > 0. Pass 0 to hide. */
    count: number;
    onClick: () => void;
    title?: string;
    /** Label text after the icon. Defaults to "Filters". */
    label?: string;
}

/**
 * Shared filter trigger used in the `action` slot of cards that own a
 * filter dropdown (NewPostingsCard, WatchlistsCard). Muted styling when no
 * filters are set AND the dropdown is closed; cyan when either condition
 * flips. Count badge sits on the LEFT of the icon/label so a glance at the
 * card header surfaces "filtered" state without reading.
 */
export function FilterButton({ active, count, onClick, title, label = "Filters" }: FilterButtonProps) {
    const lit = count > 0 || active;
    return (
        <button
            onClick={onClick}
            title={title ?? (active ? "Hide filters" : "Show filters")}
            aria-pressed={active}
            className={[
                "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border transition-colors",
                lit
                    ? "bg-cyan-500/20 text-cyan-100 border-cyan-400/40"
                    : "bg-black/30 text-white/50 border-white/10 hover:text-white/80",
            ].join(" ")}
        >
            {count > 0 && (
                <span className="tabular-nums">({count})</span>
            )}
            <Filter className="w-3 h-3" />
            {label}
        </button>
    );
}
