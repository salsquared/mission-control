import React from "react";
import { Clock } from "lucide-react";

interface Props {
    nextStepAt: string | null;
}

function formatRelative(iso: string): { label: string; tone: "ok" | "soon" | "overdue" } {
    const ms = new Date(iso).getTime() - Date.now();
    const days = Math.round(ms / (24 * 60 * 60 * 1000));
    if (ms < 0) {
        const overdueDays = Math.abs(days);
        return { label: overdueDays <= 0 ? "Overdue" : `Overdue ${overdueDays}d`, tone: "overdue" };
    }
    if (days === 0) return { label: "Due today", tone: "soon" };
    if (days === 1) return { label: "Due tomorrow", tone: "soon" };
    if (days < 7) return { label: `Due in ${days}d`, tone: "soon" };
    return { label: `Due ${new Date(iso).toLocaleDateString()}`, tone: "ok" };
}

export const ApplicationNextStep: React.FC<Props> = ({ nextStepAt }) => {
    if (!nextStepAt) return null;
    const { label, tone } = formatRelative(nextStepAt);

    const toneClass =
        tone === "overdue"
            ? "bg-rose-500/15 text-rose-300 border-rose-400/30"
            : tone === "soon"
                ? "bg-amber-500/15 text-amber-300 border-amber-400/30"
                : "bg-emerald-500/15 text-emerald-300 border-emerald-400/30";

    return (
        <div
            className={`mt-3 inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] font-semibold uppercase tracking-wide ${toneClass}`}
        >
            <Clock className="w-3 h-3" />
            {label}
        </div>
    );
};
